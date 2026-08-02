// OCR words turned into PDF text operators. The same words are drawn two ways,
// and which way is a property of the page rather than of the document — a text
// PDF keeps its picture pages as bitmaps, and those pages want the invisible
// treatment even though everything around them is painted.
//
// 'invisible' draws in rendering mode 3 — shaped, painted with nothing — over
// the bitmap of the page. That is what a scanner means by a "searchable PDF":
// the page still shows the photograph, but selecting, copying and Ctrl-F all
// reach the words underneath, in the right places.
//
// 'visible' paints the same operators where there is no bitmap at all. The page
// becomes vector: a few kilobytes instead of a few hundred, sharp at any zoom,
// and still laid out where the recogniser found the words — so paragraphs,
// indents, headings and margins keep their positions and their sizes. It is only
// ever as true as the OCR under it, and anything that was not text — plates,
// rules, ornaments — is not carried across, which is what the picture pages are
// for.

export type TextStyle = 'invisible' | 'visible';

const INVISIBLE = 3;
const FILL = 0;

/** Boxes thinner than this in points are OCR noise, not words. */
const MIN_SIDE = .5;

/**
 * Horizontal scaling is what makes a word fill its box, so it absorbs the
 * difference between the PDF's font and whatever the book was set in. Clamps
 * keep one badly-measured word from producing a Tz no reader will honour.
 *
 * Painted glyphs are condensed but essentially never expanded. The two
 * directions are not symmetrical: word boxes do not overlap, so a word squeezed
 * to fit can never run into its neighbour, whereas one spread to fill a box the
 * serif does not need reads as letterspaced — and against a line of ordinary
 * text, letterspaced reads as a mistake. The word still starts at the x the
 * recogniser measured; the slack falls in the space after it, where a space
 * belongs.
 */
const MIN_STRETCH = 10;
const MAX_STRETCH = 1000;
const MAX_VISIBLE_STRETCH = 105;

/**
 * Helvetica advance widths, in 1/1000 em, for the printable ASCII range. One of
 * the fourteen fonts every PDF reader carries, so nothing has to be embedded —
 * and since the glyphs are never painted, the only thing these widths have to
 * get right is how wide the selection highlight comes out.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

/**
 * Times-Roman, the other base-14 face worth having here. Books are set in a
 * serif at roughly these proportions, so the text page comes out close to the
 * scan it was read from and the Tz corrections stay near 100 — which is what
 * keeps painted glyphs from looking squeezed.
 */
const TIMES_WIDTHS = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541
];

export interface PdfFont {
  /** The name a page's /Resources gives it, and the content stream selects. */
  resource: string;
  /** A base-14 name, so it is never embedded. */
  baseFont: string;
  widths: number[];
  /** Everything outside the table, including all of WinAnsi's upper half. */
  fallback: number;
}

export const HELVETICA: PdfFont = {
  resource: 'F1', baseFont: 'Helvetica', widths: HELVETICA_WIDTHS, fallback: 556
};

export const TIMES_ROMAN: PdfFont = {
  resource: 'F2', baseFont: 'Times-Roman', widths: TIMES_WIDTHS, fallback: 500
};

/**
 * Both are written into every document, because one document can hold pages of
 * both kinds. Two base-14 font objects are eighty bytes each and neither is
 * embedded, so the unused one costs nothing worth deciding about.
 */
export const FONTS: PdfFont[] = [HELVETICA, TIMES_ROMAN];

export const fontFor = (style: TextStyle): PdfFont =>
  style === 'visible' ? TIMES_ROMAN : HELVETICA;

/**
 * Where a face's letters reach, as fractions of the em. Only used to guess a
 * type size from a word box, so a serif average is close enough for all of them.
 */
const X_HEIGHT_EMS = .45;
const ASCENT_EMS = .7;
const DESCENT_EMS = .21;

/** Letters that reach above the x-height: capitals, digits, and these. */
const ASCENDING = /[A-Z0-9bdfhijklt£$(){}[\]/\\|!?"'*#@&%]/;

/** Letters that reach below the baseline. */
const DESCENDING = /[gjpqyQ,;]/;

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
export function textWidth(winAnsiText: string, font: PdfFont = HELVETICA): number {
  let total = 0;
  for (let i = 0; i < winAnsiText.length; i++) {
    const code = winAnsiText.charCodeAt(i);
    total += (code >= 0x20 && code <= 0x7E ? font.widths[code - 0x20]! : font.fallback);
  }
  return total / 1000;
}

/**
 * Type size and baseline for one word, in the bitmap's own pixels.
 *
 * The line the word sits on is the better guide — see OcrWord.b — and the word
 * box is the fallback. Taken literally that box is a poor one: it runs from the
 * tallest ink in the word to the lowest, so "one" measures an x-height and
 * "flight" nearly a whole em, and sizing by it makes them different sizes on the
 * same line. Reading which letters the word actually contains recovers most of
 * the difference, and matters far more once the glyphs are painted: a
 * mis-sized invisible word only mis-shapes the selection highlight.
 */
function metricsFor(word: OcrWord, estimate: boolean): { size: number; baseline: number } {
  if (word.s !== undefined && word.b !== undefined) return { size: word.s, baseline: word.b };

  const height = word.y1 - word.y0;
  if (!estimate) return { size: word.s ?? height, baseline: word.b ?? word.y1 };

  const above = ASCENDING.test(word.t) ? ASCENT_EMS : X_HEIGHT_EMS;
  const below = DESCENDING.test(word.t) ? DESCENT_EMS : 0;
  const size = word.s ?? height / (above + below);
  return { size, baseline: word.b ?? word.y1 - below * size };
}

/**
 * Content-stream operators for one page's words.
 *
 * Each word is placed on its own with a text matrix and stretched horizontally
 * to the width of its own OCR box, which is what keeps a selection over the
 * glyphs it belongs to — and, when the glyphs are visible, what keeps a
 * paragraph the shape the typesetter gave it without needing to know anything
 * about lines, justification or hyphenation.
 */
export function textLayerOps(
  words: OcrWord[], place: TextPlacement, style: TextStyle = 'invisible'
): string {
  const { scale, left, bottom, imageHeight } = place;
  const visible = style === 'visible';
  const font = fontFor(style);
  const maxStretch = visible ? MAX_VISIBLE_STRETCH : MAX_STRETCH;
  let out = `BT\n${visible ? FILL : INVISIBLE} Tr\n`;
  let used = 0;

  for (const word of words) {
    const text = winAnsi(word.t);
    if (!text.trim()) continue;

    const boxWidth = (word.x1 - word.x0) * scale;
    const metrics = metricsFor(word, visible);
    const size = (metrics.size || 0) * scale;
    if (boxWidth < MIN_SIDE || size < MIN_SIDE) continue;

    const natural = textWidth(text, font) * size;
    if (natural <= 0) continue;
    const stretch = Math.min(maxStretch, Math.max(MIN_STRETCH, 100 * boxWidth / natural));

    // Boxes count y down from the top of the bitmap; PDF counts up from the
    // bottom of the page.
    const x = left + word.x0 * scale;
    const y = bottom + (imageHeight - metrics.baseline) * scale;

    out += `/${font.resource} ${size.toFixed(2)} Tf ${stretch.toFixed(2)} Tz `;
    out += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(text)} Tj\n`;
    used += 1;
  }

  return used ? `${out}ET\n` : '';
}
