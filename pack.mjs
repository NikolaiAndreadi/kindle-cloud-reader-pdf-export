// Zips the files Chrome loads, for a GitHub release. The list is written out
// rather than derived by excluding src/, test/ and docs/, so a directory added
// later cannot end up in a release by default.

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { VENDOR_DIR, requiredVendorFiles } from './vendor.mjs';
import { readVersions } from './version.mjs';

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

const DIST_DIR = 'dist';

const RUNTIME = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.js',
  'preview.js',
  'popup.html',
  'popup.css',
  'preview.html',
  'LICENSE'
];

const packaged = () => [
  ...RUNTIME,
  ...requiredVendorFiles().map((name) => `${VENDOR_DIR}/${name}`)
];

async function verifyPresent(paths) {
  const missing = [];
  for (const path of paths) {
    try {
      const info = await stat(resolve(root, path));
      if (!info.size) missing.push(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length) {
    throw new Error(
      `cannot package, missing or empty: ${missing.join(', ')} — run \`npm run build\``
    );
  }
}

const { version } = await readVersions(root);
const paths = packaged();
await verifyPresent(paths);

const zip = `${DIST_DIR}/kindle-cloud-reader-pdf-export-${version}.zip`;
await mkdir(resolve(root, DIST_DIR), { recursive: true });
// zip adds to an existing archive rather than replacing it.
await rm(resolve(root, zip), { force: true });

// -X leaves out the extra file attributes, which vary by machine.
try {
  await run('zip', ['-q', '-9', '-X', zip, ...paths], { cwd: root });
} catch (error) {
  if (error.code === 'ENOENT') {
    throw new Error('packaging needs the `zip` command, which is not on PATH');
  }
  throw error;
}

const { size } = await stat(resolve(root, zip));
console.log(`${zip} — ${paths.length} files, ${(size / 1024 / 1024).toFixed(1)} MB`);
