import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DELAY_DEFAULT, DELAY_MAX, DELAY_MIN, JITTER_DEFAULT, JITTER_MAX,
  clampDelay, clampJitter, jitterCeiling, jitteredDelay
} from '../../src/shared/timing.ts';

describe('clampDelay', () => {
  it('keeps a value inside the slider range', () => {
    assert.equal(clampDelay(1250), 1250);
  });

  it('pulls values outside the range back to the bounds', () => {
    assert.equal(clampDelay(100), DELAY_MIN);
    assert.equal(clampDelay(9000), DELAY_MAX);
  });

  it('falls back to the default for a missing or unusable value', () => {
    assert.equal(clampDelay(undefined), DELAY_DEFAULT);
    assert.equal(clampDelay(Number.NaN), DELAY_DEFAULT);
  });
});

describe('clampJitter', () => {
  it('keeps zero rather than treating it as absent', () => {
    assert.equal(clampJitter(0), 0);
  });

  it('rounds and clamps to a level the slider can produce', () => {
    assert.equal(clampJitter(2.4), 2);
    assert.equal(clampJitter(-3), 0);
    assert.equal(clampJitter(50), JITTER_MAX);
  });

  it('falls back to the default when no level is given', () => {
    assert.equal(clampJitter(undefined), JITTER_DEFAULT);
  });
});

describe('jitteredDelay', () => {
  it('waits exactly the base delay when jitter is off', () => {
    for (const roll of [0, .5, 1]) {
      assert.equal(jitteredDelay(1100, 0, roll), 1100);
    }
  });

  it('only ever adds time', () => {
    assert.equal(jitteredDelay(1000, 3, 0), 1000);
    assert.ok(jitteredDelay(1000, 3, .5) > 1000);
  });

  it('never exceeds the ceiling the popup advertises', () => {
    for (const level of [1, JITTER_DEFAULT, JITTER_MAX]) {
      assert.equal(jitteredDelay(1000, level, 1), jitterCeiling(1000, level));
      assert.ok(jitteredDelay(1000, level, .99) <= jitterCeiling(1000, level));
    }
  });

  it('doubles the base delay at the top level', () => {
    assert.equal(jitterCeiling(1000, JITTER_MAX), 2000);
  });

  it('returns whole milliseconds', () => {
    assert.equal(jitteredDelay(733, 3, .37), Math.round(733 * (1 + .2 * 3 * .37)));
    assert.ok(Number.isInteger(jitteredDelay(733, 3, .37)));
  });

  it('varies between waits when rolled repeatedly', () => {
    const waits = new Set(Array.from({ length: 40 }, () => jitteredDelay(1100, JITTER_DEFAULT)));
    assert.ok(waits.size > 1, 'expected the wait to change from page to page');
  });
});
