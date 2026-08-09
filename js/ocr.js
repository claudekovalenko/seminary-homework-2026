// Optical character recognition for PDFs that are photographs of pages rather
// than text — the usual shape of a scanned course reader.
//
// Each page is rendered to a canvas by pdf.js, then read by Tesseract compiled
// to WebAssembly. Everything runs on the device: no upload, no account, no API.
// The cost is size and time — roughly 9 MB fetched once, and ten to twenty
// seconds per page on a phone — so it is never started without being asked for.

import { loadPdfjs } from './pdftext.js';

const TESSERACT_URL = '../vendor/tesseract/tesseract.esm.min.js';
const VENDOR = '../vendor/tesseract/';

/** Roughly the download, so the UI can warn honestly before starting. */
export const ENGINE_MB = 9;

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
export async function ocrPdf(blob, onProgress) {
  cancelled = false;
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  onProgress?.({ done: 0, total: doc.numPages, stage: 'engine' });
  const worker = await makeWorker((status, progress) =>
    onProgress?.({ done: 0, total: doc.numPages, stage: 'engine', status, progress })
  );

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pages = [];

  try {
    for (let n = 1; n <= doc.numPages; n++) {
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
      pages.push({ page: n, text: layOutLines(result) });
      onProgress?.({ done: n, total: doc.numPages, stage: 'reading' });
    }
  } finally {
    await worker.terminate();
    await doc.destroy();
    canvas.width = canvas.height = 0;
  }

  const chars = pages.reduce((sum, p) => sum + p.text.length, 0);
  return {
    pages,
    chars,
    pageCount: pages.length,
    emptyPages: pages.filter((p) => p.text.length < 40).length,
    looksScanned: false,
    ocr: true,
    partial: cancelled
  };
}

/**
 * Rebuild paragraphs from where the lines physically sit on the page.
 *
 * Tesseract returns one line per line of print. Joining them on blank lines
 * alone produced a single unbroken slab of text — unreadable for a chapter.
 * Typography gives better signals than whitespace does: a paragraph ends when
 * its last line stops short of the column's right edge, and a new one usually
 * starts indented or after a wider gap. That is what this reads.
 */
function layOutLines(result) {
  const lines = (result?.blocks || [])
    .flatMap((b) => b.paragraphs || [])
    .flatMap((p) => p.lines || [])
    .map((l) => ({ text: String(l.text || '').replace(/\s+/g, ' ').trim(), bbox: l.bbox }))
    .filter((l) => l.text && l.bbox);

  if (!lines.length) return tidyText(result?.text);

  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);

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
  const sorted = pitches.slice().sort((a, b) => a - b);
  const typicalPitch = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

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

    if (bigGap || (prevEndedShort && (looseLine || indented))) {
      out += '\n\n' + line.text;
    } else if (/[-‐‑]$/.test(out)) {
      out = out.replace(/[-‐‑]$/, '') + line.text;
    } else {
      out += ' ' + line.text;
    }
  });

  return out.replace(/\n{3,}/g, '\n\n').trim();
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
