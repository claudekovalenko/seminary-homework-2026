# Vendored OCR engine

Used only when a PDF turns out to be a photographed scan with no text layer.

- `tesseract.esm.min.js`, `worker.min.js` — tesseract.js 5.1.1 (Apache-2.0)
- `tesseract-core-simd-lstm.wasm.js` — tesseract.js-core 5.1.1 (Apache-2.0),
  the LSTM-only SIMD build: the smallest core that still recognises modern text
- `eng.traineddata` — English model, 4.0.0 `best_int` (Apache-2.0)
- `grc.traineddata` — Ancient Greek model, 4.0.0 `best_int` (Apache-2.0), for
  the Koine in the course reading. Polytonic: breathings and accents come back
  with the letters. Fetched only when Greek is left on in Settings.

About 9 MB, or 11 with Greek — fetched only when OCR is actually asked for, and
never precached, so installing the app stays small.

The language data is stored **uncompressed on purpose**. A `.traineddata.gz`
here gets `Content-Encoding: gzip` added by some hosts, the browser decompresses
it once, tesseract tries to decompress it again, and the model arrives corrupt.
