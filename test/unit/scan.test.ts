import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emptyMeta } from '../../src/shared/storage.ts';
import { JITTER_DEFAULT } from '../../src/shared/timing.ts';
import type { Settings } from '../../src/content/scan.ts';
import {
  isRunning, prepareBookMode, retune, revisitWatch, scan, settingsFrom
} from '../../src/content/scan.ts';

const capture = (): CaptureRecord => ({
  index: 1, position: '', fingerprint: 'fp-1', page: null
});

const asked = (split: boolean, quality = .88): Settings =>
  settingsFrom({ split, quality });

describe('settingsFrom quality', () => {
  it('passes lossless through instead of clamping it to the JPEG ceiling', () => {
    assert.equal(settingsFrom({ quality: 1 }).quality, 1);
    assert.equal(settingsFrom({ quality: .99 }).quality, .98);
    assert.equal(settingsFrom({ quality: 1.5 }).quality, .98);
    assert.equal(settingsFrom({}).quality, .88);
  });

  it('pins a lossless book like any other quality', () => {
    const meta = { ...emptyMeta('B001'), split: true, quality: 1, captures: [capture()] };
    const settings = asked(true, .88);
    prepareBookMode(meta, settings);
    assert.equal(settings.quality, 1);
  });
});

describe('prepareBookMode', () => {
  it('records the mode when starting an empty cache', () => {
    const meta = emptyMeta('B001');
    prepareBookMode(meta, asked(true, .96));
    assert.equal(meta.split, true);
    assert.equal(meta.splitByGutter, true);
    assert.equal(meta.quality, .96);
  });

  it('allows a resume with the same mode', () => {
    const meta = { ...emptyMeta('B001'), split: false, quality: .88, captures: [capture()] };
    assert.doesNotThrow(() => prepareBookMode(meta, asked(false)));
  });

  it('rejects a resume with a different mode', () => {
    const meta = { ...emptyMeta('B001'), split: false, quality: .88, captures: [capture()] };
    assert.throws(() => prepareBookMode(meta, asked(true)), /split setting differs/i);
  });

  it('rejects appending to a legacy cache whose mode is unknown', () => {
    const meta = { ...emptyMeta('B001'), captures: [capture()] };
    assert.throws(() => prepareBookMode(meta, asked(true)), /predates layout tracking/i);
  });

  it('holds a resume to the quality the cached pages were encoded at', () => {
    const meta = { ...emptyMeta('B001'), split: true, splitByGutter: true, quality: .75, captures: [capture()] };
    const settings = asked(true, .96);
    prepareBookMode(meta, settings);
    assert.equal(settings.quality, .75);
    assert.equal(meta.quality, .75);
    assert.equal(meta.splitByGutter, true);
  });

  it('resumes legacy JPEG pages at Balanced when lossless was requested', () => {
    const meta = { ...emptyMeta('B001'), split: true, captures: [capture()] };
    const settings = asked(true, 1);
    prepareBookMode(meta, settings);
    assert.equal(meta.quality, .88);
    assert.equal(settings.quality, .88);
  });

  it('pins the requested quality on a cache written before it was recorded', () => {
    const meta = { ...emptyMeta('B001'), split: true, captures: [capture()] };
    const settings = asked(true, .96);
    prepareBookMode(meta, settings);
    assert.equal(meta.quality, .96);
    assert.equal(settings.quality, .96);
    assert.equal(meta.splitByGutter, undefined);
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

describe('revisitWatch', () => {
  it('never gives up while every view is one it has not seen', () => {
    const watch = revisitWatch(3);
    for (let i = 0; i < 50; i++) assert.equal(watch.saw(`view-${i}`), false);
  });

  it('gives up once the same view comes round enough times', () => {
    const watch = revisitWatch(3);
    assert.equal(watch.saw('a'), false);
    assert.equal(watch.saw('a'), false);
    assert.equal(watch.saw('a'), false);
    assert.equal(watch.saw('a'), true);
  });

  it('catches a reader bouncing between two views, which never looks stalled', () => {
    const watch = revisitWatch(3);
    const seen = [];
    for (let i = 0; i < 8; i++) seen.push(watch.saw(i % 2 ? 'a' : 'b'));
    // b and a are new; every view after them is a repeat, so the third ends it.
    assert.deepEqual(seen, [false, false, false, false, true, true, true, true]);
  });

  it('forgives a repeat that turns out to be a pause, not a loop', () => {
    const watch = revisitWatch(3);
    watch.saw('a');
    watch.saw('a');
    assert.equal(watch.revisits, 1);
    watch.saw('b');
    assert.equal(watch.revisits, 0);
  });

  it('reads nothing into a view whose pixels could not be hashed', () => {
    const watch = revisitWatch(1);
    assert.equal(watch.saw(''), false);
    assert.equal(watch.saw(''), false);
    assert.equal(watch.revisits, 0);
  });
});

describe('retune', () => {
  // The applied path needs a scan mid-loop, which needs a rendered page: it is
  // covered by the fixture rather than here.
  it('reports nothing to retune while no scan is running', () => {
    assert.equal(retune({ delay: 1500, jitter: 4 }), false);
  });
});

describe('scan lifecycle', () => {
  it('resets running after storage rejects', async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async () => { throw new Error('storage unavailable'); } } }
    };

    await assert.rejects(scan('B001', undefined), /storage unavailable/);
    assert.equal(isRunning(), false);
    // The settings the loop was reading are released too, so a late slider
    // message cannot mutate the finished scan's object.
    assert.equal(retune({ delay: 1500 }), false);
  });
});
