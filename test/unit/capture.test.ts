import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintOf, isWide, regionsFor } from '../../src/content/capture.ts';

describe('isWide', () => {
  it('treats a landscape bitmap as a spread', () => {
    assert.equal(isWide(1600, 1200), true);
  });

  it('treats a portrait page as a single page', () => {
    assert.equal(isWide(1200, 1600), false);
  });

  it('leaves a near-square capture alone, below the 1.2 threshold', () => {
    assert.equal(isWide(1199, 1000), false);
    assert.equal(isWide(1200, 1000), true);
  });

  it('never divides by zero', () => {
    assert.equal(isWide(1200, 0), false);
  });
});

describe('regionsFor', () => {
  it('returns nothing for a bitmap with no size', () => {
    assert.deepEqual(regionsFor(0, 1600, true), []);
    assert.deepEqual(regionsFor(1200, 0, true), []);
  });

  it('returns the whole bitmap for a portrait page', () => {
    assert.deepEqual(regionsFor(1200, 1600, true), [{ sx: 0, sy: 0, sw: 1200, sh: 1600 }]);
  });

  it('leaves a spread whole when splitting is off', () => {
    assert.deepEqual(regionsFor(2400, 1600, false), [{ sx: 0, sy: 0, sw: 2400, sh: 1600 }]);
  });

  it('cuts a spread down the middle', () => {
    assert.deepEqual(regionsFor(2400, 1600, true), [
      { sx: 0, sy: 0, sw: 1200, sh: 1600 },
      { sx: 1200, sy: 0, sw: 1200, sh: 1600 }
    ]);
  });

  it('loses no column of an odd-width spread', () => {
    const [left, right] = regionsFor(2401, 1600, true);
    assert.ok(left && right);
    assert.equal(left.sw + right.sw, 2401);
    assert.equal(right.sx, left.sw);
  });
});

describe('fingerprintOf', () => {
  const long = (fill: string): string => `data:image/jpeg;base64,${fill.repeat(400)}`;

  it('is stable for the same input', () => {
    const url = long('AB');
    assert.equal(fingerprintOf(url, 800, 1200), fingerprintOf(url, 800, 1200));
  });

  it('separates different pixels at the same size', () => {
    assert.notEqual(fingerprintOf(long('AB'), 800, 1200), fingerprintOf(long('CD'), 800, 1200));
  });

  it('separates the same bytes at different sizes', () => {
    const url = long('AB');
    assert.notEqual(fingerprintOf(url, 800, 1200), fingerprintOf(url, 801, 1200));
  });

  it('encodes the dimensions in the prefix, so a size change is visible', () => {
    assert.match(fingerprintOf(long('AB'), 800, 1200), /^800x1200-/);
  });

  it('copes with a data URL shorter than the sampled window', () => {
    assert.equal(typeof fingerprintOf('data:image/jpeg;base64,AA==', 4, 4), 'string');
  });
});
