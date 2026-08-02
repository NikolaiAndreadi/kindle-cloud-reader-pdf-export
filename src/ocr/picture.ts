// Deciding whether a page is a picture, from the pixels the recogniser has just
// read and the boxes it found words in.
//
// The measure is how much of the page is covered by ink the words do not account
// for. On a page of prose almost every dark pixel is inside a word box: what is
// left is a rule, a folio, the odd speck. On a plate, a map or a full-page
// diagram, most of the ink is nowhere near a word. The same measure catches the
// case the text export handles worst without anyone having to name it — a page
// the recogniser simply failed on reads as ink outside boxes too, and a page
// that failed is exactly one to keep as a bitmap.
//
// It runs on a thumbnail rather than the page. Ink coverage is an area, and an
// area survives being averaged down; a couple of hundred pixels across is enough
// to separate a plate from a paragraph and costs a fraction of a millisecond.

/** Long edge of the thumbnail the score is computed on. */
export const SAMPLE_SIDE = 200;

/**
 * Above this, the page is a picture. A page of prose measures a percent or two —
 * a folio, a running head, the odd speck of dirt outside the boxes — and a plate
 * measures tens. Sitting the line at 8% leaves both a wide berth, which is the
 * point: the cost of being wrong is a page that is a little larger than it had
 * to be, or one that lost an illustration, and the second is much the worse.
 */
export const PICTURE_THRESHOLD = .08;

/** Below this luminance a pixel is ink rather than paper. 0–1. */
const INK_BELOW = .8;

/**
 * Colour is ink whatever its luminance: a pale wash is part of an illustration,
 * and nothing in a page of text is coloured.
 */
const SATURATED_ABOVE = .18;

/**
 * Word boxes bound the ink of the word, and the recogniser's are tight. Grown by
 * this fraction of the box's own height before ink is counted against them, so
 * an accent, a descender clipped by a pixel or an underline does not read as
 * picture.
 */
const BOX_MARGIN = .35;

export interface PictureSample {
  /** RGBA, four bytes a pixel, as ImageData gives it. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * How much of the page is ink that no word accounts for, 0–1.
 *
 * `pageWidth` and `pageHeight` are the space the boxes were measured in; the
 * sample is the same page at whatever size it was drawn.
 */
export function pictureScore(
  sample: PictureSample, words: OcrWord[], pageWidth: number, pageHeight: number
): number {
  const { data, width, height } = sample;
  const pixels = width * height;
  if (!pixels || !(pageWidth > 0) || !(pageHeight > 0)) return 0;

  // One byte a pixel: 0 for paper, 1 for a pixel some word has claimed. Cheaper
  // to paint the boxes once than to ask every dark pixel which box it is in.
  const claimed = new Uint8Array(pixels);
  const scaleX = width / pageWidth;
  const scaleY = height / pageHeight;
  for (const word of words) {
    const margin = (word.y1 - word.y0) * BOX_MARGIN;
    const x0 = Math.max(0, Math.floor((word.x0 - margin) * scaleX));
    const x1 = Math.min(width, Math.ceil((word.x1 + margin) * scaleX));
    const y0 = Math.max(0, Math.floor((word.y0 - margin) * scaleY));
    const y1 = Math.min(height, Math.ceil((word.y1 + margin) * scaleY));
    for (let y = y0; y < y1; y++) claimed.fill(1, y * width + x0, y * width + x1);
  }

  let loose = 0;
  for (let i = 0; i < pixels; i++) {
    if (claimed[i]) continue;
    const red = data[i * 4]! / 255;
    const green = data[i * 4 + 1]! / 255;
    const blue = data[i * 4 + 2]! / 255;
    // Rec. 601 luma, which is what a scanner's own thresholding uses.
    const luminance = .299 * red + .587 * green + .114 * blue;
    const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (luminance < INK_BELOW || saturation > SATURATED_ABOVE) loose += 1;
  }
  return loose / pixels;
}

export const looksLikePicture = (score: number): boolean => score >= PICTURE_THRESHOLD;
