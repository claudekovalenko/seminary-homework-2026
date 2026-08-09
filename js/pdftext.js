// Pull the text out of an attached PDF and lay it out so it reads like prose.
//
// pdf.js hands back a flat list of positioned glyph runs, not sentences. Joining
// them naively gives run-together mush, so we rebuild lines from each run's
// baseline, then paragraphs from the gaps between baselines, and stitch back
// the hyphens that a line break split.
//
// The library is ~1.6 MB, so it is imported on first use rather than up front,
// and cached by the service worker afterwards.

const PDFJS_URL = '../vendor/pdfjs/pdf.min.mjs';
const WORKER_URL = '../vendor/pdfjs/pdf.worker.min.mjs';

let pdfjsPromise = null;

/** Shared with js/ocr.js, which renders the same pages to canvas. */
export async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const pdfjs = await import(new URL(PDFJS_URL, import.meta.url).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(WORKER_URL, import.meta.url).href;
    return pdfjs;
  })();
  return pdfjsPromise;
}

/** A page with almost no glyphs is a picture of a page, not a page of text. */
const SCAN_THRESHOLD = 40;

/**
 * Rebuild readable text from one page's positioned runs.
 * `items` come from pdf.js getTextContent(); each carries a transform matrix
 * whose last two entries are the run's x and y on the page.
 */
function layOutPage(items) {
  const runs = items
    .filter((it) => typeof it.str === 'string')
    .map((it) => ({
      text: it.str,
      x: it.transform[4],
      y: it.transform[5],
      height: Math.abs(it.transform[3]) || 10,
      eol: it.hasEOL
    }))
    .filter((r) => r.text.length);

  if (!runs.length) return '';

  // Group runs onto shared baselines. Anything within a quarter of the font
  // height is the same visual line, even if pdf.js reports it separately.
  const lines = [];
  for (const run of runs.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - run.y) <= Math.max(2, run.height * 0.25)) {
      line.runs.push(run);
      line.height = Math.max(line.height, run.height);
    } else {
      lines.push({ y: run.y, height: run.height, runs: [run] });
    }
  }

  const text = lines.map((line) => {
    const sorted = line.runs.sort((a, b) => a.x - b.x);
    let out = '';
    let prev = null;
    for (const run of sorted) {
      if (prev) {
        const gap = run.x - (prev.x + prev.text.length * prev.height * 0.5);
        // A real word gap, when neither side already carries a space.
        const spaced = /\s$/.test(out) || /^\s/.test(run.text);
        if (!spaced && gap > prev.height * 0.2) out += ' ';
      }
      out += run.text;
      prev = run;
    }
    return { text: out.replace(/\s+/g, ' ').trim(), y: line.y, height: line.height };
  });

  // A gap noticeably bigger than the usual line spacing starts a paragraph.
  const gaps = [];
  for (let i = 1; i < text.length; i++) gaps.push(text[i - 1].y - text[i].y);
  const typical = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

  let out = '';
  text.forEach((line, i) => {
    if (!line.text) return;
    if (i > 0) {
      const gap = text[i - 1].y - line.y;
      const newParagraph = typical > 0 && gap > typical * 1.6;
      if (newParagraph) {
        out += '\n\n';
      } else if (HYPHEN_AT_END.test(out)) {
        // A word broken across lines. Whether the hyphen is part of the word or
        // just the break is decided later, once the whole document is known —
        // leave a marker rather than guessing here. Deliberately not matching
        // en or em dashes: those end lines legitimately and must survive.
        out = out.replace(HYPHEN_AT_END, JOIN);
      } else {
        out += ' ';
      }
    }
    out += line.text;
  });

  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// U+002D hyphen-minus, U+2010 hyphen, U+2011 non-breaking hyphen, U+00AD soft.
const HYPHEN_AT_END = /[-‐‑­]$/;
// A private-use codepoint: it cannot occur in real text, so the marker is
// unambiguous and survives the whitespace collapsing above.
const JOIN = '\uE000';

/**
 * Decide what each line-break hyphen meant, using the document's own vocabulary.
 *
 * "load-" + "bearing" is a real compound; "metaphysi-" + "cal" is one word split
 * by the typesetter. Nothing local distinguishes them, but the rest of the
 * document usually does: whichever form appears elsewhere is the intended one.
 * With no evidence either way we join, since typeset prose breaks words far more
 * often than it hyphenates them.
 */
function resolveHyphens(pages) {
  const vocab = new Set();
  for (const p of pages) {
    for (const word of p.text.split(/[^\p{L}\p{N}'’-]+/u)) {
      if (word && !word.includes(JOIN)) vocab.add(word.toLowerCase().replace(/^['’-]+|['’-]+$/g, ''));
    }
  }

  const decide = (left, right) => {
    if (vocab.has(`${left}${right}`.toLowerCase())) return `${left}${right}`;
    if (vocab.has(`${left}-${right}`.toLowerCase())) return `${left}-${right}`;
    return `${left}${right}`;
  };

  return pages.map((p) => ({
    ...p,
    text: p.text.replace(/([\p{L}\p{N}]+)\uE000([\p{L}\p{N}]+)/gu, (_, l, r) => decide(l, r)).replaceAll(JOIN, '')
  }));
}

/**
 * Extract every page of a PDF.
 * onProgress({done, total}) fires per page so the UI can show a bar.
 */
export async function extractText(blob, onProgress) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  const raw = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      raw.push({ page: n, text: layOutPage(content.items) });
      page.cleanup();
      onProgress?.({ done: n, total: doc.numPages });
    }
  } finally {
    await doc.destroy();
  }

  // Hyphens can only be judged once every page has been read.
  const pages = resolveHyphens(raw);
  const chars = pages.reduce((sum, p) => sum + p.text.length, 0);
  const emptyPages = pages.filter((p) => p.text.length < SCAN_THRESHOLD).length;
  return {
    pages,
    chars,
    pageCount: pages.length,
    emptyPages,
    // Nothing worth reading came out: this is a scan, and needs OCR instead.
    looksScanned: pages.length > 0 && emptyPages / pages.length > 0.8
  };
}

/** Whole document as one string, with page markers for orientation. */
export function toPlainText(extracted) {
  return extracted.pages
    .filter((p) => p.text)
    .map((p) => `— page ${p.page} —\n\n${p.text}`)
    .join('\n\n');
}
