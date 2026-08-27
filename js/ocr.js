// Optical character recognition for PDFs that are photographs of pages rather
// than text — the usual shape of a scanned course reader.
//
// Each page is rendered to a canvas by pdf.js, then read by Tesseract compiled
// to WebAssembly. Everything runs on the device: no upload, no account, no API.
// The cost is size and time — roughly 9 MB fetched once, and ten to twenty
// seconds per page on a phone — so it is never started without being asked for.

import { loadPdfjs, resolveHyphens, JOIN } from './pdftext.js';
import * as lexicon from './lexicon.js';
import { prepare, skewOf } from './imageprep.js';

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

  const worker = await createWorker('eng', 1, {
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

  await worker.setParameters({
    // Left to guess, Tesseract infers the resolution from the pixel count and
    // gets it wrong on anything but a full page, which throws off every size
    // judgement it makes afterwards. We rendered the page ourselves, so we know.
    user_defined_dpi: String(TARGET_DPI),
    // Keep the spacing the page actually has. Without this the engine
    // regularises runs of spaces, and justified type — which is stretched full
    // of them — comes back with words welded together.
    preserve_interword_spaces: '1',
    // 3 is Tesseract's own full page analysis. The library defaults to 6,
    // "one uniform block of text", which quietly disables the layout pass: a
    // page in two columns then comes back as lines that run straight across the
    // gutter, so every sentence is interleaved with the one beside it. Nothing
    // downstream can undo that, because by then the columns are inside single
    // lines. With 3 the engine finds the columns itself and hands them over in
    // reading order.
    tessedit_pageseg_mode: '3'
  });
  return worker;
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
  let deskewed = 0;

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
      // Straighten it, threshold it locally, and take the dust off the glass.
      // The engine reads what is left far better than it reads a photocopy.
      const cleaned = prepare(canvas, ctx);
      if (cleaned.angle) deskewed++;

      const { data: result } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      pages.push({
        page: n,
        ...layOutLines(result, { height: canvas.height, width: canvas.width }),
        // How sure the engine was of this page, kept so the reader can say which
        // pages came out badly instead of leaving you to find them.
        confidence: Math.round(result?.confidence ?? 0)
      });
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
  const joined = resolveHyphens(pages, ['text', 'notes']);
  let repaired = { pages: joined, changed: 0, words: 0 };
  if (await words) {
    try {
      repaired = lexicon.repairPages(joined);
    } catch (err) {
      console.warn('Word repair failed; keeping the raw reading', err);
    }
  }

  return {
    ...summarise(repaired.pages, lastPage, doc.numPages),
    repaired: repaired.changed,
    deskewed
  };
}

/**
 * One page, as the engine sees it: blocks, paragraphs, lines and words with
 * their boxes and confidences. Used by tools/bench to design the layout pass
 * against real geometry; not reached by the app.
 */
export async function debugPage(blob, pageNumber = 1) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const worker = await makeWorker();
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  let scale = TARGET_DPI / 72;
  const pixels = base.width * scale * (base.height * scale);
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const before = skewOf(canvas, ctx);
  const cleaned = prepare(canvas, ctx);
  const after = skewOf(canvas, ctx);
  const { data: result } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  await worker.terminate();
  await doc.destroy();
  const lines = linesOf(result);
  const trimmed = stripFurniture(lines, canvas.height);
  const split = splitNotes(trimmed);
  const columns = columnsOf(trimmed, canvas.width);
  return {
    cleaned,
    skew: { before, after },
    lines: trimmed.map((l) => ({ text: l.text.slice(0, 60), size: l.size, y: l.bbox.y0, x0: l.bbox.x0, x1: l.bbox.x1 })),
    split: { body: split.body.length, notes: split.notes.length, columns: columns.map((c) => c.length) },
    size: { width: canvas.width, height: canvas.height },
    confidence: result.confidence,
    blocks: (result.blocks || []).map((b) => ({
      bbox: b.bbox,
      type: b.blocktype,
      paragraphs: (b.paragraphs || []).map((p) => ({
        bbox: p.bbox,
        lines: (p.lines || []).map((l) => ({
          bbox: l.bbox,
          confidence: l.confidence,
          text: l.text,
          words: (l.words || []).map((w) => ({ text: w.text, confidence: w.confidence, bbox: w.bbox }))
        }))
      }))
    }))
  };
}

/** Below this the engine was guessing often enough that the page is worth checking. */
export const POOR_PAGE = 75;

/** The stored shape, whether the run finished or stopped part-way. */
export function summarise(pages, lastPage, total) {
  const length = (p) => p.text.length + (p.notes?.length || 0);
  // How sure the engine was, page by page. Worth keeping and worth showing: a
  // page it struggled with is the one to check against the PDF, and without
  // this you would have to find it by reading until something stopped making
  // sense. Pages read by an older version carry no score and are not counted.
  const scored = pages.filter((p) => typeof p.confidence === 'number' && length(p) >= 40);
  const confidence = scored.length ? Math.round(scored.reduce((sum, p) => sum + p.confidence, 0) / scored.length) : null;
  return {
    pages,
    chars: pages.reduce((sum, p) => sum + length(p), 0),
    pageCount: pages.length,
    totalPages: total,
    emptyPages: pages.filter((p) => length(p) < 40).length,
    notePages: pages.filter((p) => p.notes).length,
    confidence,
    poorPages: scored.filter((p) => p.confidence < POOR_PAGE).map((p) => p.page),
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
      // "load-" + "bearing" is a compound; "metaphysi-" + "cal" is one word the
      // typesetter broke. Nothing on this line can tell them apart, so leave a
      // marker and let the whole document decide once it has been read.
      out = out.replace(/[-‐‑]$/, JOIN) + line.text;
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
  const bodySize = median(lines.map((l) => l.size));
  if (!bodySize) return { body: lines, notes: [] };
  const smaller = (line) => line.size < bodySize * 0.9;
  const numbered = (line) => /^\d{1,3}[.)]\s/.test(line.text);

  // A note opens with its own number, hard against the left margin, in type
  // smaller than the body. That is a surer signal than size alone, which on a
  // page of mixed leading can point almost anywhere.
  let start = -1;
  for (let i = Math.floor(lines.length * 0.4); i < lines.length; i++) {
    if (!numbered(lines[i]) || !smaller(lines[i])) continue;
    // Everything below it should be small too — otherwise this is a numbered
    // list in the middle of the argument, not the apparatus at the foot.
    const below = lines.slice(i);
    if (below.filter(smaller).length >= below.length * 0.75) {
      start = i;
      break;
    }
  }

  // The number found is not always the first one: dirt in the margin can hide
  // note 1 behind a stray letter. The block is a run of small type, so walk up
  // from whichever note was found until the type goes back to reading size.
  if (start > 0) {
    while (start > 0 && smaller(lines[start - 1])) start--;
  }

  // Failing that, walk up from the bottom for as long as the type stays small.
  if (start < 0) {
    start = lines.length;
    while (start > 0 && lines[start - 1].size < bodySize * 0.86) start--;
    if (start === lines.length) return { body: lines, notes: [] };
  }

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
  const thin = lines.length - start < 2 && !numbered(lines[start]);
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

/**
 * How sure the engine has to be before a mark counts as text.
 *
 * These are the two failure modes of a photocopy. Dirt in the margin comes back
 * as confident-looking punctuation — a stray "|" or ":" at the start of a line,
 * which then drags the line's box out to the paper's edge and ruins every
 * measurement made from it. And a genuinely unreadable smudge comes back as a
 * one or two letter word with the engine's own confidence in single figures.
 */
const PUNCTUATION_ONLY = /^[^A-Za-z0-9]+$/;
// Marks that do legitimately stand alone between spaces, in ordinary typesetting.
const STANDS_ALONE = /^(?:[—–-]{1,3}|\.{3}|[("'“‘]|[)"'”’]|[?!]+)$/;
const SURE = 90;
const UNSURE = 40;

/**
 * True when this word is print rather than a mark on the glass.
 *
 * `margin` says the word lies outside the column of type altogether, which is
 * where dirt collects and where a short doubtful word is treated as a speck.
 * The same word between two others is a word the engine merely found hard, and
 * "the God at the end" must not lose its "at".
 */
function isRealWord(word, margin) {
  const text = String(word.text || '').trim();
  if (!text) return false;
  const confidence = typeof word.confidence === 'number' ? word.confidence : 100;
  if (PUNCTUATION_ONLY.test(text)) return !margin && STANDS_ALONE.test(text) && confidence >= SURE;
  if (!margin) return true;
  // Longer words are kept even out in the margin: half of a long word is still
  // worth reading, and the lexicon pass downstream often finishes it.
  return text.replace(/[^A-Za-z0-9]/g, '').length > 2 || confidence >= UNSURE;
}

const percentile = (nums, p) => {
  const sorted = nums.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
};

/**
 * Where the column of type begins and ends, judged from the lines themselves.
 *
 * Taken as low and high quantiles rather than extremes, because the extremes
 * are exactly what we are trying to find: one speck against the paper's edge
 * would otherwise define the column as the whole page.
 */
function columnBounds(lines) {
  const left = percentile(lines.map((l) => Math.min(...l.words.map((w) => w.bbox.x0))), 0.25);
  const right = percentile(lines.map((l) => Math.max(...l.words.map((w) => w.bbox.x1))), 0.75);
  return { left, right, slack: Math.max(8, (right - left) * 0.015) };
}

const boxOf = (words) => ({
  x0: Math.min(...words.map((w) => w.bbox.x0)),
  x1: Math.max(...words.map((w) => w.bbox.x1)),
  y0: Math.min(...words.map((w) => w.bbox.y0)),
  y1: Math.max(...words.map((w) => w.bbox.y1))
});

/**
 * Every line on the page, rebuilt out of the words worth keeping.
 *
 * The line boxes the engine hands back include whatever dirt it read, so they
 * are re-derived here from the surviving words. That matters more than it
 * sounds: the column edges, the indents and the type size are all measured off
 * these boxes further down, and one speck in the margin was enough to make a
 * page look as though every line began in a different place.
 */
function linesOf(result) {
  const raw = [];
  for (const block of result?.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || []).filter((w) => w.bbox && String(w.text || '').trim());
        if (words.length) raw.push({ words, confidence: line.confidence });
      }
    }
  }
  if (!raw.length) return [];

  const column = columnBounds(raw);
  const inMargin = (w) => w.bbox.x1 < column.left - column.slack || w.bbox.x0 > column.right + column.slack;

  const out = [];
  for (const line of raw) {
    const words = line.words.filter((w) => isRealWord(w, inMargin(w)));
    if (!words.length) continue;
    const text = deSpeckle(words.map((w) => w.text).join(' ').replace(/\s+/g, ' '));
    if (text.replace(/[^A-Za-z0-9]/g, '').length <= 2) continue;
    const heights = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    out.push({
      text,
      bbox: boxOf(words),
      // The type size, taken from the median word rather than the line box: one
      // word with a descender should not make a whole line look larger.
      size: heights[Math.floor(heights.length / 2)],
      confidence: typeof line.confidence === 'number' ? line.confidence : 100
    });
  }
  return out.sort((a, b) => a.bbox.y0 - b.bbox.y0);
}

/**
 * The running head at the top and the page number at the foot.
 *
 * Both are furniture rather than text: read straight through they interrupt a
 * sentence once a page, and searching for a phrase finds the folio instead. A
 * line is only taken as furniture when it is short, set apart from the text
 * block, and near the edge of the paper — and a page number has to be nothing
 * but a number.
 */
function stripFurniture(lines, height) {
  if (lines.length < 4 || !height) return lines;
  const body = lines.slice(1, -1);
  const pitches = [];
  for (let i = 1; i < body.length; i++) pitches.push(body[i].bbox.y0 - body[i - 1].bbox.y0);
  const pitch = median(pitches);
  const widths = lines.map((l) => l.bbox.x1 - l.bbox.x0);
  const columnWidth = Math.max(...widths);

  const out = lines.slice();
  const short = (line) => line.bbox.x1 - line.bbox.x0 < columnWidth * 0.6;
  const detached = (a, b) => pitch > 0 && b.bbox.y0 - a.bbox.y0 > pitch * 1.5;
  // A page number, once the dust either side of it is discounted. Judged on
  // what is left rather than on the line as it stands, because a folio almost
  // never arrives clean: a speck in the margin turns "47" into "oC 47", and
  // that was enough to leave the number sitting in the middle of the prose.
  const isFolio = (line) => {
    const core = line.text
      .split(/\s+/)
      .filter((token) => /\d/.test(token) || token.replace(/[^A-Za-z0-9]/g, '').length > 2)
      .join(' ')
      .replace(/[^A-Za-z0-9]/g, '');
    return core.length > 0 && core.length <= 6 && /^[ivxlcdm\d]+$/i.test(core);
  };

  const first = out[0];
  if (first.bbox.y0 < height * 0.13 && short(first) && detached(first, out[1])) out.shift();
  const last = out[out.length - 1];
  const previous = out[out.length - 2];
  if (last.bbox.y1 > height * 0.9 && (isFolio(last) || (short(last) && detached(previous, last) && last.confidence < 60))) {
    out.pop();
  }
  return out;
}

/**
 * Split the page into columns, and put them back in reading order.
 *
 * A page of two columns comes off the engine as lines that are correct
 * individually and nonsense in sequence: sorted down the page, the first line of
 * the left column is followed by the first line of the right, and a journal
 * article reads as two half-sentences at a time. Tesseract knows better — it
 * finds the columns — but that knowledge is thrown away by the moment the lines
 * are flattened, so it is recovered here from the geometry.
 *
 * A gutter is a vertical band the type never crosses. Anything sitting inside
 * one band is a column; anything spanning a gutter — a heading, a rule, a
 * footnote block set to the full measure — is not, and it separates what is
 * above it from what is below, exactly as it does to a reader.
 */
// Fine enough that the quantisation does not eat a gutter: at 600 bins a
// column edge is placed to within about four pixels of a 300 dpi page, where at
// 240 it was ten, and rounding outward at both ends of every line was enough to
// close a real gutter and merge two columns back into one.
const BINS = 600;
/**
 * A gap narrower than this is word spacing, not a gutter between columns.
 * Journals set a gutter at four to six per cent of the page; the widest word
 * space in justified type is nowhere near three.
 */
const GUTTER_FRACTION = 0.03;

export function columnsOf(lines, pageWidth) {
  const width = pageWidth || Math.max(...lines.map((l) => l.bbox.x1));
  if (lines.length < 6 || !width) return [lines];

  const scale = BINS / width;
  const covered = new Uint8Array(BINS);
  for (const line of lines) {
    const from = Math.max(0, Math.floor(line.bbox.x0 * scale));
    const to = Math.min(BINS - 1, Math.ceil(line.bbox.x1 * scale));
    covered.fill(1, from, to + 1);
  }

  // The bands of the page that carry type, separated by gaps wide enough to be
  // gutters. Blank margins at either edge are not gutters; they are margins.
  const bands = [];
  let start = -1;
  for (let i = 0; i <= BINS; i++) {
    if (i < BINS && covered[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      bands.push({ x0: start / scale, x1: i / scale });
      start = -1;
    }
  }
  const wide = [];
  for (const band of bands) {
    const last = wide[wide.length - 1];
    // Fold a band back into its neighbour when the gap between them is too
    // narrow to be a gutter — an indented first line leaves gaps like that.
    if (last && band.x0 - last.x1 < width * GUTTER_FRACTION) last.x1 = band.x1;
    else wide.push({ ...band });
  }
  if (wide.length < 2) return [lines];

  const bandOf = (line) => {
    const span = Math.max(1, line.bbox.x1 - line.bbox.x0);
    for (let i = 0; i < wide.length; i++) {
      const inside = Math.min(line.bbox.x1, wide[i].x1) - Math.max(line.bbox.x0, wide[i].x0);
      if (inside / span > 0.8) return i;
    }
    return -1; // spans a gutter: full measure
  };

  // Walk down the page. A full-measure line closes whatever columns were open,
  // stands on its own, and the columns start again beneath it.
  const groups = [];
  let open = null;
  const flush = () => {
    if (!open) return;
    for (const column of open) if (column.length) groups.push(column);
    open = null;
  };
  for (const line of lines) {
    const band = bandOf(line);
    if (band < 0) {
      flush();
      groups.push([line]);
      continue;
    }
    if (!open) open = wide.map(() => []);
    open[band].push(line);
  }
  flush();

  // Two columns are only worth the rearranging if both of them hold text; a
  // page with one line off to the side is a page with a marginal note on it.
  const real = groups.filter((g) => g.length > 2);
  return real.length > 1 ? groups.filter((g) => g.length) : [lines];
}

function layOutLines(result, { height = 0, width = 0 } = {}) {
  const all = linesOf(result);
  if (!all.length) return { text: tidyText(result?.text), notes: '' };

  const lines = stripFurniture(all, height);
  if (!lines.length) return { text: '', notes: '' };

  // Each column is laid out as though it were its own small page: its own
  // measure, its own indents, its own footnotes at its own foot.
  const body = [];
  const notes = [];
  for (const column of columnsOf(lines, width)) {
    const split = splitNotes(column);
    if (split.body.length) body.push(paragraphs(split.body));
    if (split.notes.length) notes.push(paragraphs(split.notes, { notes: true }));
  }
  return { text: body.filter(Boolean).join('\n\n'), notes: notes.filter(Boolean).join('\n\n') };
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
