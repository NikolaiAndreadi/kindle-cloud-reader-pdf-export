// manifest.json and package.json both carry a version and nothing at runtime
// reads package.json's, so drift between them is harmless until someone tags
// the wrong one.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const read = async (root, name) => JSON.parse(await readFile(resolve(root, name), 'utf8'));

export async function readVersions(root) {
  const [manifest, pkg] = await Promise.all([
    read(root, 'manifest.json'),
    read(root, 'package.json')
  ]);

  if (manifest.version !== pkg.version) {
    throw new Error(
      `version mismatch: manifest.json is ${manifest.version}, package.json is ${pkg.version}`
    );
  }

  // Chrome takes up to four dot-separated integers and nothing else, so a tag
  // like v1.0.0-beta would install nowhere.
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error(`manifest.json version ${manifest.version} is not a valid extension version`);
  }

  return { version: manifest.version };
}
