// Copies the OCR engine out of node_modules into vendor/tesseract/, which is
// checked in. Two reasons it is a copy rather than a bundle:
//
//   - MV3 forbids loading code from anywhere but the extension package, so the
//     wasm core and the language data cannot come off a CDN the way
//     tesseract.js does by default.
//   - Chrome loads this directory as-is, so "Load unpacked" has to work without
//     a node_modules present. Same reason content.js and friends are committed.
//
// Run `npm run vendor` after bumping tesseract.js, then commit what changes.

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

export const VENDOR_DIR = 'vendor/tesseract';

/**
 * Each entry is [source in node_modules, name under vendor/tesseract].
 *
 * Only the SIMD LSTM core is taken. tesseract.js normally picks between six
 * builds at runtime by probing for wasm features; every Chrome that can run an
 * MV3 extension has SIMD, and the LSTM-only core is 800 KB smaller than the one
 * that also carries the legacy engine we do not use. src/ocr/engine.ts names
 * this file directly, which is what turns the probe off.
 */
export const VENDORED = [
  ['tesseract.js/dist/tesseract.min.js', 'tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  // best_int, not the 11 MB float model: a quarter of the size for a fraction
  // of a percent of accuracy on printed prose, which is all a book page is.
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ['tesseract.js/LICENSE.md', 'LICENSE-tesseract.js.md'],
  ['tesseract.js-core/LICENSE', 'LICENSE-tesseract.js-core.txt'],
  // The trained-data repository uses the same Apache-2.0 text. Its npm package
  // does not ship the repository's LICENSE file, so copy an identical canonical
  // copy and name it for the artifact it accompanies.
  ['tesseract.js/LICENSE.md', 'LICENSE-tessdata.txt']
];

/** Hand-maintained attribution shipped beside the machine-readable assets. */
export const VENDOR_NOTICES = ['THIRD_PARTY_NOTICES.md'];

export const vendorPath = (name) => resolve(root, VENDOR_DIR, name);

/** Names that must be present for OCR to work at runtime. */
export const requiredVendorFiles = () => [
  ...VENDORED.map(([, name]) => name),
  ...VENDOR_NOTICES
];

export async function missingVendorFiles() {
  const missing = [];
  for (const name of requiredVendorFiles()) {
    try {
      const info = await stat(vendorPath(name));
      if (!info.size) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

// Only when run directly: build.mjs imports the list to check it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(resolve(root, VENDOR_DIR), { recursive: true });
  for (const [from, name] of VENDORED) {
    const source = resolve(root, 'node_modules', from);
    await copyFile(source, vendorPath(name));
    // Some published license files end with an extra whitespace-only line,
    // which makes `git diff --check` complain every time the vendor set is
    // refreshed. Preserve the text while normalising its final newline.
    if (name.startsWith('LICENSE-')) {
      const license = await readFile(vendorPath(name), 'utf8');
      await writeFile(vendorPath(name), `${license.trimEnd()}\n`);
    }
    const { size } = await stat(vendorPath(name));
    console.log(`${VENDOR_DIR}/${name} — ${(size / 1024).toFixed(0)} KB`);
  }
}
