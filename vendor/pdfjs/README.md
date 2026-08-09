# Vendored pdf.js

`pdfjs-dist` 4.10.38, Apache-2.0 (see LICENSE). Only the two files the app needs:

- `pdf.min.mjs` — the library
- `pdf.worker.min.mjs` — the parsing worker

Vendored rather than loaded from a CDN so the app keeps working offline and
pulls in no third-party network calls. Both are loaded lazily by
`js/pdftext.js` on first use, not precached, so installing the app stays small.

Pinned to the 4.x line on purpose. pdf.js 5.x calls
`Map.prototype.getOrInsertComputed`, a proposal that current Safari and
Chromium do not ship, and page rendering throws on it — which OCR depends on.
