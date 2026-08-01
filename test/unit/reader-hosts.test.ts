import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { READER_HOSTS, isReaderUrl, matchPattern } from '../../src/shared/reader-hosts.ts';

describe('isReaderUrl', () => {
  it('accepts every host the manifest grants access to', () => {
    for (const host of READER_HOSTS) {
      assert.equal(isReaderUrl(`https://${host}/?asin=B001`), true, host);
    }
  });

  it('rejects a reader domain the manifest does not cover', () => {
    // A regex such as /read\.amazon\.[a-z]{2,3}/ matched these, so the popup
    // offered to scan a tab where no content script had ever been injected.
    assert.equal(isReaderUrl('https://read.amazon.xyz/'), false);
    assert.equal(isReaderUrl('https://read.amazon.co.za/'), false);
  });

  it('rejects the rest of amazon.com', () => {
    assert.equal(isReaderUrl('https://www.amazon.com/'), false);
    assert.equal(isReaderUrl('https://amazon.com/read/'), false);
  });

  it('rejects a lookalike host that merely starts the same way', () => {
    assert.equal(isReaderUrl('https://read.amazon.com.evil.test/'), false);
  });

  it('rejects plain http and a missing url', () => {
    assert.equal(isReaderUrl('http://read.amazon.com/'), false);
    assert.equal(isReaderUrl(undefined), false);
  });

  it('rejects malformed URLs instead of throwing', () => {
    assert.equal(isReaderUrl('not a url'), false);
  });
});

describe('manifest.json', () => {
  it('grants exactly the hosts declared in reader-hosts.ts', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    const expected = READER_HOSTS.map(matchPattern);
    assert.deepEqual([...manifest.host_permissions].sort(), [...expected].sort());
    assert.deepEqual([...manifest.content_scripts[0].matches].sort(), [...expected].sort());
  });

  it('loads the bundle the build actually emits', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['content.js']);
    assert.equal(manifest.action.default_popup, 'popup.html');
    assert.equal(manifest.background.service_worker, 'background.js');
  });
});
