// Copies the free offline bill reader (Tesseract OCR) into public/ocr, so it works with
// no internet and no outside website: worker, the LSTM engine builds, and English data.
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, '..', 'public', 'ocr');
fs.mkdirSync(out, { recursive: true });
const nm = path.join(__dirname, '..', 'node_modules');
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];
for (const [from, to] of files) {
  const src = path.join(nm, from), dst = path.join(out, to);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}
console.log('offline bill reader files ready in public/ocr');
