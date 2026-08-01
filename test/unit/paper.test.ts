import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAPER_SIZES, isPaperName, layoutFor, paperLabel } from '../../src/pdf/paper.ts';

const round = (value: number): number => Math.round(value * 100) / 100;

describe('isPaperName', () => {
  it('accepts the three sizes the writer implements', () => {
    for (const name of ['a4', 'letter', 'native']) assert.ok(isPaperName(name));
  });

  it('rejects anything else, including sizes it does not have', () => {
    for (const name of ['A4', 'a3', '', undefined, 42]) assert.ok(!isPaperName(name));
  });
});

describe('layoutFor', () => {
  it('gives up on a bitmap with no size rather than dividing by zero', () => {
    assert.equal(layoutFor(0, 1000, 'a4'), null);
    assert.equal(layoutFor(1000, 0, 'a4'), null);
    assert.equal(layoutFor(-10, 1000, 'a4'), null);
  });

  it('fits a portrait capture to A4 width and centres the bands vertically', () => {
    const layout = layoutFor(1200, 1600, 'a4')!;
    assert.equal(layout.pageWidth, PAPER_SIZES.a4.width);
    assert.equal(layout.pageHeight, PAPER_SIZES.a4.height);
    assert.equal(round(layout.width), PAPER_SIZES.a4.width);
    assert.equal(layout.x, 0);
    assert.equal(round(layout.height), 793.71);
    assert.equal(round(layout.y), 24.09);
  });

  it('fits a capture taller than the sheet to the height instead', () => {
    // 1000x2000 is thinner than A4, so the constraint is the height and the
    // bands land at the sides.
    const layout = layoutFor(1000, 2000, 'a4')!;
    assert.equal(round(layout.height), round(PAPER_SIZES.a4.height));
    assert.ok(layout.x > 0);
    assert.equal(layout.y, 0);
  });

  it('never scales a bitmap past the edge of the sheet', () => {
    for (const [w, h] of [[1200, 1600], [1000, 2000], [2400, 1000], [500, 500]]) {
      const layout = layoutFor(w!, h!, 'letter')!;
      assert.ok(layout.width <= layout.pageWidth + .01, `${w}x${h} is too wide`);
      assert.ok(layout.height <= layout.pageHeight + .01, `${w}x${h} is too tall`);
      // Centred: the two margins are equal.
      assert.equal(round(layout.x * 2 + layout.width), round(layout.pageWidth));
      assert.equal(round(layout.y * 2 + layout.height), round(layout.pageHeight));
    }
  });

  it('turns the sheet sideways for a spread captured unsplit', () => {
    const layout = layoutFor(2000, 1200, 'a4')!;
    assert.equal(layout.pageWidth, PAPER_SIZES.a4.height);
    assert.equal(layout.pageHeight, PAPER_SIZES.a4.width);
  });

  it('keeps a square capture portrait rather than flipping on a rounding error', () => {
    const layout = layoutFor(1000, 1000, 'a4')!;
    assert.equal(layout.pageWidth, PAPER_SIZES.a4.width);
  });

  it('gives native pages the capture aspect ratio at 612 points wide', () => {
    const layout = layoutFor(1200, 1600, 'native')!;
    assert.deepEqual(layout, {
      pageWidth: 612, pageHeight: 816, x: 0, y: 0, width: 612, height: 816
    });
  });

  it('names the sizes the way the popup does', () => {
    assert.equal(paperLabel('a4'), 'A4');
    assert.equal(paperLabel('letter'), 'US Letter');
    assert.equal(paperLabel('native'), 'capture size');
  });
});
