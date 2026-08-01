// The invisible text layer: OCR words turned into PDF text operators drawn in
// rendering mode 3 (no fill, no stroke). This is what a scanner means by a
// "searchable PDF" — the page still shows the bitmap, but selecting, copying and
// Ctrl-F all reach the words underneath, in the right places.

/** Text rendering mode 3: shape the glyphs, paint nothing. */
const INVISIBLE = 3;

/** Boxes thinner than this in points are OCR noise, not words. */
const MIN_SIDE = .5;

/**
 * Horizontal scaling is what makes a word fill its box, so it absorbs the
 * difference between Helvetica and whatever the book was set in. A clamp keeps
 * one badly-measured word from producing a Tz no reader will honour.
 */
const MIN_STRETCH = 10;
const MAX_STRETCH = 1000;

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range. One of
 * the fourteen fonts every PDF reader carries, so nothing has to be embedded —
 * and since the glyphs are never painted, the only thing these widths have to
 * get right is how wide the selection highlight comes out.
 */
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

/** Everything outside the table above, including all of WinAnsi's upper half. */
const FALLBACK_WIDTH = 556;

/**
 * Codepoints that WinAnsiEncoding puts in 0x80–0x9F, where Latin-1 has control
 * characters. Tesseract emits the quotes and dashes routinely, and dropping them
 * would leave "don t" and "1914 18" in the text layer.
 */
const WIN_ANSI_HIGH = new Map<number, number>([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88], [0x2030, 0x89], [0x0160, 0x8A],
  [0x2039, 0x8B], [0x0152, 0x8C], [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92],
  [0x201C, 0x93], [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B], [0x0153, 0x9C],
  [0x017E, 0x9E], [0x0178, 0x9F]
]);

/**
 * Re-encode to WinAnsi, as a string of one char per byte. Characters with no
 * WinAnsi byte are dropped rather than replaced: a dropped accent still leaves
 * a searchable word, whereas "caf?" matches nothing anyone would type.
 */
export function winAnsi(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    // 0x00–0x1F are controls in both encodings; OCR should not produce them.
    if (code >= 0x20 && code <= 0xFF) out += String.fromCharCode(code);
    else {
      const mapped = WIN_ANSI_HIGH.get(code);
      if (mapped !== undefined) out += String.fromCharCode(mapped);
    }
  }
  return out;
}

/**
 * Wrap a WinAnsi string as a PDF literal string. Bytes above 0x7E are written
 * as octal escapes so the whole document stays 7-bit: everything else in the
 * file is ASCII, and the writer measures /Length in JS string units.
 */
export function pdfString(winAnsiText: string): string {
  let out = '(';
  for (let i = 0; i < winAnsiText.length; i++) {
    const code = winAnsiText.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || code === 0x5C) out += `\\${winAnsiText[i]}`;
    else if (code > 0x7E) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += winAnsiText[i];
  }
  return `${out})`;
}

/** Natural width of a WinAnsi string at font size 1, in points. */
export function textWidth(winAnsiText: string): number {
  let total = 0;
  for (let i = 0; i < winAnsiText.length; i++) {
    const code = winAnsiText.charCodeAt(i);
    total += (code >= 0x20 && code <= 0x7E ? WIDTHS[code - 0x20]! : FALLBACK_WIDTH);
  }
  return total / 1000;
}

/**
 * Content-stream operators for one page's words.
 *
 * Each word is placed on its own with a text matrix and stretched horizontally
 * to the width of its own OCR box, which is what keeps a selection over the
 * glyphs it belongs to. Vertically the line is the better guide — see OcrWord.b
 * — and the word box is the fallback: its bottom edge is the descender of
 * whatever letters the word happens to contain, so sizing by it makes "one" and
 * "long" different sizes on the same line.
 */
export function textLayerOps(words: OcrWord[], place: TextPlacement): string {
  const { scale, left, bottom, imageHeight } = place;
  let out = `BT\n${INVISIBLE} Tr\n`;
  let used = 0;

  for (const word of words) {
    const text = winAnsi(word.t);
    if (!text.trim()) continue;

    const boxWidth = (word.x1 - word.x0) * scale;
    const size = ((word.s ?? (word.y1 - word.y0)) || 0) * scale;
    if (boxWidth < MIN_SIDE || size < MIN_SIDE) continue;

    const natural = textWidth(text) * size;
    if (natural <= 0) continue;
    const stretch = Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, 100 * boxWidth / natural));

    // Boxes count y down from the top of the bitmap; PDF counts up from the
    // bottom of the page.
    const x = left + word.x0 * scale;
    const y = bottom + (imageHeight - (word.b ?? word.y1)) * scale;

    out += `/F1 ${size.toFixed(2)} Tf ${stretch.toFixed(2)} Tz `;
    out += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(text)} Tj\n`;
    used += 1;
  }

  return used ? `${out}ET\n` : '';
}
