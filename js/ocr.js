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
 * a scale of ~4 hits that — capped, because a canvas that big on a phone risks
 * being silently refused.
 */
const TARGET_WIDTH = 2000;
const MAX_SCALE = 4;

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
      const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / base.width));
      const viewport = page.getViewport({ scale });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      // Scans photograph white paper; a white ground keeps edges clean.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      const { data: result } = await worker.recognize(canvas);
      pages.push({ page: n, text: tidy(result.text) });
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
 * Tesseract emits one line per line of the page. Rejoin them into paragraphs so
 * the result reads like the extraction path's output rather than a column of
 * fragments.
 */
function tidy(raw) {
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
