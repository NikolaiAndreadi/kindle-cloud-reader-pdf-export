import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type PictureSample, PICTURE_THRESHOLD, looksLikePicture, pictureScore
} from '../../src/ocr/picture.ts';

const WIDTH = 100;
const HEIGHT = 140;

/** A blank white page to draw test ink on. */
function blank(width = WIDTH, height = HEIGHT): PictureSample {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { data, width, height };
}

function fill(
  sample: PictureSample, x0: number, y0: number, x1: number, y1: number,
  [red, green, blue]: [number, number, number]
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const at = (y * sample.width + x) * 4;
      sample.data[at] = red;
      sample.data[at + 1] = green;
      sample.data[at + 2] = blue;
      sample.data[at + 3] = 255;
    }
  }
}

const BLACK: [number, number, number] = [0, 0, 0];
const GREY: [number, number, number] = [128, 128, 128];
/** Pale enough to pass for paper by luminance alone; only its colour gives it away. */
const PALE_BLUE: [number, number, number] = [200, 225, 250];

/** Boxes in the same 100×140 space the sample is measured in. */
const line = (y: number): OcrWord =>
  ({ t: 'words words', x0: 10, y0: y, x1: 90, y1: y + 6 });

describe('pictureScore', () => {
  it('is nothing for a blank page', () => {
    assert.equal(pictureScore(blank(), [], WIDTH, HEIGHT), 0);
  });

  it('is near nothing for a page whose ink is all inside word boxes', () => {
    const sample = blank();
    const words: OcrWord[] = [];
    for (let y = 20; y < 120; y += 10) {
      fill(sample, 10, y, 90, y + 6, BLACK);
      words.push(line(y));
    }
    const score = pictureScore(sample, words, WIDTH, HEIGHT);
    assert.ok(score < .01, `expected almost no loose ink, got ${score}`);
    assert.equal(looksLikePicture(score), false);
  });

  it('counts a plate the words do not account for', () => {
    const sample = blank();
    // A photograph over the top half of the page, and a caption under it.
    fill(sample, 5, 10, 95, 70, GREY);
    fill(sample, 10, 80, 90, 86, BLACK);
    const score = pictureScore(sample, [line(80)], WIDTH, HEIGHT);
    assert.ok(score > .3, `expected most of the page to be loose ink, got ${score}`);
    assert.equal(looksLikePicture(score), true);
  });

  it('reads colour as ink however pale it is', () => {
    const sample = blank();
    fill(sample, 5, 10, 95, 70, PALE_BLUE);
    const score = pictureScore(sample, [], WIDTH, HEIGHT);
    assert.ok(score > .3, `expected the wash to count, got ${score}`);
  });

  it('counts a page the recogniser failed on, which is one to keep as a bitmap', () => {
    const sample = blank();
    for (let y = 20; y < 120; y += 10) fill(sample, 10, y, 90, y + 6, BLACK);
    // The same page of prose, with no words returned at all.
    assert.equal(looksLikePicture(pictureScore(sample, [], WIDTH, HEIGHT)), true);
  });

  it('forgives ink a hair outside the box, which every accent and descender is', () => {
    const sample = blank();
    // Ink a pixel taller and wider than the box the recogniser reported.
    fill(sample, 9, 19, 91, 27, BLACK);
    const score = pictureScore(sample, [line(20)], WIDTH, HEIGHT);
    assert.ok(score < .005, `expected the margin to absorb it, got ${score}`);
  });

  it('measures the boxes in the page space, not the sample space', () => {
    const sample = blank();
    for (let y = 20; y < 120; y += 10) fill(sample, 10, y, 90, y + 6, BLACK);
    // The same words, reported against a page ten times the size.
    const words: OcrWord[] = [];
    for (let y = 20; y < 120; y += 10) {
      words.push({ t: 'words', x0: 100, y0: y * 10, x1: 900, y1: (y + 6) * 10 });
    }
    assert.ok(pictureScore(sample, words, WIDTH * 10, HEIGHT * 10) < .01);
  });

  it('refuses a sample or a page with no area rather than dividing by zero', () => {
    assert.equal(pictureScore(blank(0, 0), [], WIDTH, HEIGHT), 0);
    assert.equal(pictureScore(blank(), [], 0, HEIGHT), 0);
  });

  it('puts the line where a plate and a page of prose both clear it', () => {
    assert.equal(looksLikePicture(PICTURE_THRESHOLD), true);
    assert.equal(looksLikePicture(PICTURE_THRESHOLD - .001), false);
  });
});
