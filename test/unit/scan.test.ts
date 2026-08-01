import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyMeta } from '../../src/shared/storage.ts';
import { JITTER_DEFAULT } from '../../src/shared/timing.ts';
import { isRunning, prepareSplitMode, scan, settingsFrom } from '../../src/content/scan.ts';

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

describe('settingsFrom', () => {
  it('takes the pacing the popup sent', () => {
    const settings = settingsFrom({ delay: 1500, jitter: 4, quality: .9, split: false });
    assert.equal(settings.delay, 1500);
    assert.equal(settings.jitter, 4);
  });

  it('holds jitter off when the popup asked for none', () => {
    assert.equal(settingsFrom({ delay: 900, jitter: 0 }).jitter, 0);
  });

  it('applies defaults to a request that predates the sliders', () => {
    const settings = settingsFrom({ quality: .88 });
    assert.equal(settings.jitter, JITTER_DEFAULT);
    assert.ok(settings.delay >= 700);
  });

  it('pulls a delay outside the slider range back into it', () => {
    assert.equal(settingsFrom({ delay: 60000 }).delay, 2000);
    assert.equal(settingsFrom({ delay: 10 }).delay, 700);
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
