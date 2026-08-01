# Third-party notices

The files in this directory are redistributed with Personal Cloud Reader
Export so OCR works locally and without downloading executable code at runtime.

## Tesseract.js

- Package: `tesseract.js` 7.0.0
- Files: `tesseract.min.js`, `worker.min.js`
- Project: https://github.com/naptha/tesseract.js
- License: Apache License 2.0
- License text: `LICENSE-tesseract.js.md`

## Tesseract.js Core

- Package: `tesseract.js-core` 7.0.0
- File: `tesseract-core-simd-lstm.wasm.js`
- Project: https://github.com/naptha/tesseract.js-core
- License: Apache License 2.0
- License text: `LICENSE-tesseract.js-core.txt`

## English trained data

- Package: `@tesseract.js-data/eng` 1.0.0
- Artifact: `4.0.0_best_int/eng.traineddata.gz`
- File: `eng.traineddata.gz`
- Project: https://github.com/naptha/tessdata
- Upstream model source: https://github.com/tesseract-ocr/tessdata_best
- License: Apache License 2.0 (the model)
- License text: `LICENSE-tessdata.txt`

The English artifact is the integerized LSTM-only form of the Tessdata Best
model distributed by the Tesseract.js trained-data repository.

What is redistributed here is the model, which upstream publishes under the
Apache License 2.0. The npm package that carries it declares MIT for its own
packaging; the terms above are the ones that govern the file in this directory.
