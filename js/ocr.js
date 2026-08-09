// Optical character recognition for PDFs that are photographs of pages rather
// than text — the usual shape of a scanned course reader.
//
// Each page is rendered to a canvas by pdf.js, then read by Tesseract compiled
// to WebAssembly. Everything runs on the device: no upload, no account, no API.
// The cost is size and time — roughly 9 MB fetched once, and ten to twenty
// seconds per page on a phone — so it is never started without being asked for.

import { loadPdfjs } from './pdftext.js';
import * as lexicon from './lexicon.js';

const TESSERACT_URL = '../vendor/tesseract/tesseract.esm.min.js';
const VENDOR = '../vendor/tesseract/';

/** Roughly the download — engine and word list — so the UI can warn honestly. */
export const ENGINE_MB = 10;

/**
 * Tesseract reads best at around 300 dpi. PDF pages are measured at 72 dpi, so
 * a scale of ~4.2 hits that. The pixel budget, not the scale, is the real cap:
 * a canvas beyond it is silently refused on phones.
 */
const TARGET_DPI = 300;
const MAX_PIXELS = 8e6;

let cancelled = false;
export const cancel = () => {
  cancelled = true;
};

// Holding the screen awake is the only "keep running" a web app gets. It stops
// the device sleeping mid-run; it does not survive switching away, because iOS
// freezes the page outright and no API can prevent that.
let wakeLock = null;
let holding = false;

// The browser drops the lock whenever the page is hidden, and will not hand it
// back on its own. Ask again each time we are looked at, for as long as a run
// is still going.
async function reacquire() {
  if (!holding || document.hidden) return;
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    wakeLock = null;
  }
}

async function keepAwake() {
  holding = true;
  document.addEventListener('visibilitychange', reacquire);
  await reacquire();
}

async function releaseAwake() {
  holding = false;
  document.removeEventListener('visibilitychange', reacquire);
  try {
    await wakeLock?.release();
  } catch {
    /* already gone */
  }
  wakeLock = null;
}

/** WASM SIMD — every browser new enough to run this app has it, but check. */
export async function supported() {
  try {
    // Minimal SIMD module: fails to validate where SIMD is unavailable.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])
    );
  } catch {
    return false;
  }
}

async function makeWorker(onLoad) {
  const url = (name) => new URL(VENDOR + name, import.meta.url).href;
  // The ESM build exposes everything on its default export, not as named ones.
  const Tesseract = (await import(new URL(TESSERACT_URL, import.meta.url).href)).default;
  const { createWorker } = Tesseract;

  return createWorker('eng', 1, {
    workerPath: url('worker.min.js'),
    corePath: url('tesseract-core-simd-lstm.wasm.js'),
    // Point at the directory; Tesseract appends "eng.traineddata". Stored
    // uncompressed on purpose: a .gz here would be double-decoded by hosts that
    // add Content-Encoding themselves, and arrive corrupt.
    langPath: new URL(VENDOR, import.meta.url).href.replace(/\/$/, ''),
    gzip: false,
    logger: (m) => {
      if (m.status === 'loading tesseract core' || m.status === 'loading language traineddata') {
        onLoad?.(m.status, m.progress);
      }
    }
  });
}

/**
 * OCR every page of a PDF.
 * onProgress({done, total, stage}) fires as it goes; call cancel() to stop.
 * Returns the same shape as pdftext.extractText, so the reader treats them alike.
 */
export async function ocrPdf(blob, onProgress, { startPage = 1, pages: done = [], onPage } = {}) {
  cancelled = false;
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  onProgress?.({ done: startPage - 1, total: doc.numPages, stage: 'engine' });
  // Fetched alongside the engine, and never allowed to stop the run: without it
  // the text is still readable, only rougher.
  const words = lexicon.load().catch(() => null);
  const worker = await makeWorker((status, progress) =>
    onProgress?.({ done: startPage - 1, total: doc.numPages, stage: 'engine', status, progress })
  );
  await keepAwake();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pages = [...done];
  let lastPage = startPage - 1;

  try {
    for (let n = startPage; n <= doc.numPages; n++) {
      if (cancelled) break;

      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      let scale = TARGET_DPI / 72;
      // Stay inside the pixel budget rather than the scale, so a large page is
      // reduced instead of failing to allocate.
      const pixels = base.width * scale * (base.height * scale);
      if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
      const viewport = page.getViewport({ scale });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // Scans photograph white paper; a white ground keeps edges clean.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      const { data: result } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      pages.push({ page: n, ...layOutLines(result) });
      lastPage = n;
      // Hand each page over as it lands. Switching away freezes the page, so
      // anything not already saved is lost — save after every page, not at the end.
      await onPage?.({ pages: pages.slice(), lastPage: n, total: doc.numPages });
      onProgress?.({ done: n, total: doc.numPages, stage: 'reading' });
    }
  } finally {
    await worker.terminate();
    await doc.destroy();
    await releaseAwake();
    canvas.width = canvas.height = 0;
  }

  // Word repair waits until the end, when the whole document is available to
  // judge against: a word the book uses over and over is deliberate, however odd
  // it looks. Pages saved along the way hold the raw reading, and are repaired
  // wholesale here — including on a resumed run, which re-repairs everything.
  onProgress?.({ done: lastPage, total: doc.numPages, stage: 'words' });
  let repaired = { pages, changed: 0, words: 0 };
  if (await words) {
    try {
      repaired = lexicon.repairPages(pages);
    } catch (err) {
      console.warn('Word repair failed; keeping the raw reading', err);
    }
  }

  return { ...summarise(repaired.pages, lastPage, doc.numPages), repaired: repaired.changed };
}

/** The stored shape, whether the run finished or stopped part-way. */
export function summarise(pages, lastPage, total) {
  const length = (p) => p.text.length + (p.notes?.length || 0);
  return {
    pages,
    chars: pages.reduce((sum, p) => sum + length(p), 0),
    pageCount: pages.length,
    totalPages: total,
    emptyPages: pages.filter((p) => length(p) < 40).length,
    notePages: pages.filter((p) => p.notes).length,
    looksScanned: false,
    ocr: true,
    complete: lastPage >= total,
    nextPage: lastPage + 1,
    partial: lastPage < total
  };
}

const median = (nums) => {
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/**
 * Rebuild paragraphs from where the lines physically sit on the page.
 *
 * Tesseract returns one line per line of print. Joining them on blank lines
 * alone produced a single unbroken slab of text — unreadable for a chapter.
 * Typography gives better signals than whitespace does: a paragraph ends when
 * its last line stops short of the column's right edge, and a new one usually
 * starts indented or after a wider gap. That is what this reads.
 */
function paragraphs(lines, { notes = false } = {}) {
  if (!lines.length) return '';

  // The column edges, taken as the commonest extremes rather than the absolute
  // ones, so a stray speck in the margin cannot define the page.
  const rights = lines.map((l) => l.bbox.x1).sort((a, b) => a - b);
  const lefts = lines.map((l) => l.bbox.x0).sort((a, b) => a - b);
  const columnRight = rights[Math.floor(rights.length * 0.9)];
  const columnLeft = lefts[Math.floor(lefts.length * 0.1)];
  const width = Math.max(1, columnRight - columnLeft);

  // Measure top-to-top, not the space between boxes. Line boxes overlap, since
  // one line's descenders reach into the next line's ascenders, so the space
  // between them is routinely negative and useless as a baseline for comparison.
  const pitches = [];
  for (let i = 1; i < lines.length; i++) pitches.push(lines[i].bbox.y0 - lines[i - 1].bbox.y0);
  const typicalPitch = median(pitches);

  let out = '';
  lines.forEach((line, i) => {
    if (i === 0) {
      out = line.text;
      return;
    }
    const prev = lines[i - 1];
    const pitch = line.bbox.y0 - prev.bbox.y0;
    // A line that stops well short of the column edge is the end of something.
    const prevEndedShort = prev.bbox.x1 < columnRight - width * 0.06;
    const indented = line.bbox.x0 > columnLeft + width * 0.02;
    const looseLine = typicalPitch > 0 && pitch > typicalPitch * 1.05;
    const bigGap = typicalPitch > 0 && pitch > typicalPitch * 1.4;
    // Each footnote opens with its own number, which is a surer break than any
    // amount of geometry in type that small.
    const numbered = notes && /^\d{1,3}[.)\s]/.test(line.text) && line.bbox.x0 < columnLeft + width * 0.1;

    if (numbered || bigGap || (prevEndedShort && (looseLine || indented))) {
      out += '\n\n' + line.text;
    } else if (/[-‐‑]$/.test(out)) {
      out = out.replace(/[-‐‑]$/, '') + line.text;
    } else {
      out += ' ' + line.text;
    }
  });

  // Again on the joined text: a colon left stranded at the end of one line is
  // only next to its word once the lines have been put back together.
  return tidyPunctuation(out.replace(/\n{3,}/g, '\n\n')).trim();
}

/**
 * Split a page into its body and its footnotes.
 *
 * Footnotes are set smaller than the body and sit in a block at the foot of the
 * page, and that is exactly how they are found here: walk up from the bottom
 * while the lines stay noticeably shorter than the page's usual type. Run
 * together with the body they are worse than useless — a citation lands in the
 * middle of a sentence — so they are kept, but kept apart.
 */
function splitNotes(lines) {
  const heightOf = (l) => l.bbox.y1 - l.bbox.y0;
  const bodyHeight = median(lines.map(heightOf));
  if (!bodyHeight) return { body: lines, notes: [] };

  let start = lines.length;
  while (start > 0 && heightOf(lines[start - 1]) < bodyHeight * 0.86) start--;
  if (start === lines.length) return { body: lines, notes: [] };

  const top = lines[0].bbox.y0;
  const bottom = lines[lines.length - 1].bbox.y1;
  const band = Math.max(1, bottom - top);
  // A block of small type that is most of the page is not a footnote block —
  // it is a page set in small type, and splitting it would invent a structure
  // the page does not have.
  const tooMuch = lines.length - start > lines.length * 0.45;
  const highUp = lines[start].bbox.y0 < top + band * 0.5;
  // One short line at the foot of a page is a running head or a page number far
  // more often than it is a note — unless it opens with a note's number.
  const thin = lines.length - start < 2 && !/^\d{1,3}[.)\s]/.test(lines[start].text);
  if (tooMuch || highUp || thin) return { body: lines, notes: [] };

  return { body: lines.slice(0, start), notes: lines.slice(start) };
}

/**
 * Remove the marks that are dirt on the glass rather than ink on the page.
 *
 * A photocopied page is covered in specks, and the engine dutifully reads them
 * as letters: "distinction x between", "CHAPTER THREE : ;". Two things give them
 * away. Typesetting never puts a space before a colon, and English has exactly
 * three one-letter words — so a lone "x" between two words is not a word, while
 * the "J." of an initial is left alone.
 */
function tidyPunctuation(text) {
  return text
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/([,;:.!?])[,;:](?=\s|$)/g, '$1')
    // Nothing opens with a comma. A line that starts with one starts with dirt.
    .replace(/(^|\n\n)[\s,;:.!?]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

function deSpeckle(text) {
  return tidyPunctuation(text)
    // Spared: the "J." of an initial, and the "v" of a verse reference.
    .replace(/(^|\s)(?![aAI]\b)[b-hj-zB-HJ-Z](?=\s)(?!\s*[.\d])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function layOutLines(result) {
  const lines = (result?.blocks || [])
    .flatMap((b) => b.paragraphs || [])
    .flatMap((p) => p.lines || [])
    .map((l) => ({ text: deSpeckle(String(l.text || '').replace(/\s+/g, ' ')), bbox: l.bbox }))
    .filter((l) => l.text && l.bbox)
    // A line of one or two characters is a speck of dirt read as a letter. Real
    // lines of print are not two characters long, and these were being welded
    // onto the start of headings — "Ee CHAPTER THREE".
    .filter((l) => l.text.replace(/[^A-Za-z0-9]/g, '').length > 2);

  if (!lines.length) return { text: tidyText(result?.text), notes: '' };

  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const { body, notes } = splitNotes(lines);
  return { text: paragraphs(body), notes: paragraphs(notes, { notes: true }) };
}

/** Fallback when a page yields no line geometry at all. */
function tidyText(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());

  let out = '';
  for (const line of lines) {
    if (!line) {
      if (out && !out.endsWith('\n\n')) out += '\n\n';
      continue;
    }
    if (!out || out.endsWith('\n\n')) {
      out += line;
    } else if (/[-‐‑]$/.test(out)) {
      out = out.replace(/[-‐‑]$/, '') + line;
    } else {
      out += ` ${line}`;
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
