import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyMeta } from '../../src/shared/storage.ts';
import { isRunning, prepareSplitMode, scan } from '../../src/content/scan.ts';

const capture = (): CaptureRecord => ({
  index: 1, position: '', fingerprint: 'fp-1', page: null
});

describe('prepareSplitMode', () => {
  it('records the mode when starting an empty cache', () => {
    const meta = emptyMeta('B001');
    prepareSplitMode(meta, true);
    assert.equal(meta.split, true);
  });

  it('allows a resume with the same mode', () => {
    const meta = { ...emptyMeta('B001'), split: false, captures: [capture()] };
    assert.doesNotThrow(() => prepareSplitMode(meta, false));
  });

  it('rejects a resume with a different mode', () => {
    const meta = { ...emptyMeta('B001'), split: false, captures: [capture()] };
    assert.throws(() => prepareSplitMode(meta, true), /split setting differs/i);
  });

  it('rejects appending to a legacy cache whose mode is unknown', () => {
    const meta = { ...emptyMeta('B001'), captures: [capture()] };
    assert.throws(() => prepareSplitMode(meta, true), /predates layout tracking/i);
  });
});

describe('scan lifecycle', () => {
  it('resets running after storage rejects', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async () => { throw new Error('storage unavailable'); } } }
    };

    await assert.rejects(scan('B001', undefined), /storage unavailable/);
    assert.equal(isRunning(), false);
  });
});
