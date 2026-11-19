import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { fingerprintOf, isWide, regionsFor, viewsOf } from '../../src/content/capture.ts';

describe('isWide', () => {
  it('considers a wide landscape bitmap for splitting', () => {
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

describe('viewsOf', () => {
  const side = 128;
  const element = { localName: 'canvas', width: 1537, height: 655 } as HTMLCanvasElement;
  const whole = { sx: 0, sy: 0, sw: 1537, sh: 655 };
  const originalDocument = globalThis.document;
  let pixels: Uint8ClampedArray | null;

  before(() => {
    const context = {
      fillRect() {},
      drawImage() {},
      getImageData() {
        if (!pixels) throw new Error('Unreadable pixels');
        return { data: pixels };
      }
    };
    globalThis.document = {
      createElement: () => ({ getContext: () => context })
    } as unknown as Document;
  });

  after(() => {
    globalThis.document = originalDocument;
  });

  function sample(gutter: boolean, background = 255): Uint8ClampedArray {
    const data = new Uint8ClampedArray(side * side * 4).fill(background);
    // Synthetic lines of text with or without space at the center.
    for (let y = 20; y < 110; y += 8) {
      for (let x = 10; x < 118; x++) {
        if (gutter && x >= 59 && x <= 68) continue;
        data.fill(255 - background, (y * side + x) * 4, (y * side + x) * 4 + 3);
      }
    }
    return data;
  }

  it('keeps the reported 1537 × 655 layout whole when text crosses the center', async () => {
    pixels = sample(false);
    const views = await viewsOf(element, 'gutter');
    assert.deepEqual(views.map(({ region }) => region), [whole]);
    assert.deepEqual(views, await viewsOf(element, 'off'));
    assert.match(views[0]?.signature ?? '', /^1537x655-/);
  });

  it('splits the same geometry when the center gutter is clear, including on a dark page', async () => {
    for (const background of [255, 16]) {
      pixels = sample(true, background);
      const views = await viewsOf(element, 'gutter');
      assert.deepEqual(views.map(({ region }) => region), [
        { sx: 0, sy: 0, sw: 768, sh: 655 },
        { sx: 768, sy: 0, sw: 769, sh: 655 }
      ]);
      assert.deepEqual(views, await viewsOf(element, 'aspect'));
      assert.deepEqual((await viewsOf(element, 'off')).map(({ region }) => region), [whole]);
    }
  });

  it('keeps blank or unreadable views intact', async () => {
    pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    assert.deepEqual((await viewsOf(element, 'gutter')).map(({ region }) => region), [whole]);
    pixels = null;
    assert.deepEqual(await viewsOf(element, 'gutter'), [{ region: whole, signature: null }]);
  });

  it('uses the original split rule when resuming a legacy cache', async () => {
    pixels = sample(false);
    assert.deepEqual((await viewsOf(element, 'aspect')).map(({ region }) => region.sw), [768, 769]);
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
