// Bundles the three entry points to the project root, where manifest.json
// expects them. Output deliberately stays at the root and checked in so
// "Load unpacked" on this directory keeps working without a build first.
//
// esbuild does not typecheck — `npm run build` runs tsc --noEmit first.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

import { READER_HOSTS, matchPattern } from './src/shared/reader-hosts.ts';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

const ENTRIES = {
  'content.js': 'src/content/main.ts',
  'popup.js': 'src/popup/main.ts',
  'preview.js': 'src/preview/main.ts'
};

/**
 * manifest.json cannot import anything, so it repeats the host list twice.
 * Rather than generate a file people reasonably expect to hand-edit, the build
 * fails when the manifest has drifted from src/shared/reader-hosts.ts.
 */
async function verifyManifest() {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const expected = READER_HOSTS.map(matchPattern);
  const lists = [
    ['host_permissions', manifest.host_permissions],
    ['content_scripts[0].matches', manifest.content_scripts?.[0]?.matches]
  ];

  const problems = [];
  for (const [label, actual] of lists) {
    const missing = expected.filter((pattern) => !actual?.includes(pattern));
    const extra = (actual ?? []).filter((pattern) => !expected.includes(pattern));
    if (missing.length) problems.push(`${label} is missing: ${missing.join(', ')}`);
    if (extra.length) problems.push(`${label} has unknown entries: ${extra.join(', ')}`);
  }

  const scripts = Object.keys(ENTRIES).filter((name) => name !== 'popup.js' && name !== 'preview.js');
  for (const name of scripts) {
    if (!manifest.content_scripts?.[0]?.js?.includes(name)) {
      problems.push(`content_scripts[0].js does not load ${name}`);
    }
  }

  if (problems.length) {
    throw new Error(`manifest.json is out of sync with src/shared/reader-hosts.ts:\n  ${problems.join('\n  ')}`);
  }
}

const options = {
  absWorkingDir: root,
  bundle: true,
  // IIFE, not ESM: a manifest content script is a plain script and cannot be a
  // module. The popup and preview pages could be, but one format keeps the
  // build and the <script> tags uniform.
  format: 'iife',
  // MV3 requires Chrome 88+; ES2022 syntax used here lands in 94+.
  target: 'chrome111',
  platform: 'browser',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: false
};

await verifyManifest();

const builds = Object.entries(ENTRIES).map(([outfile, entry]) => ({
  ...options,
  entryPoints: [entry],
  outfile
}));

if (watch) {
  const contexts = await Promise.all(builds.map((build) => esbuild.context(build)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('watching src/ — rebuilding on change');
} else {
  await Promise.all(builds.map((build) => esbuild.build(build)));
  console.log(`built ${Object.keys(ENTRIES).join(', ')}`);
}
