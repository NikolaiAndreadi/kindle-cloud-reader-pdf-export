import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pdfString, textLayerOps, textWidth, winAnsi } from '../../src/pdf/text.ts';

const word = (t: string, x0: number, y0: number, x1: number, y1: number): OcrWord =>
  ({ t, x0, y0, x1, y1 });

/** One point per pixel, image flush with the bottom-left of a 1000pt-tall page. */
const place: TextPlacement = { scale: 1, left: 0, bottom: 0, imageHeight: 1000 };

describe('winAnsi', () => {
  it('passes ASCII through unchanged', () => {
    assert.equal(winAnsi('Hello, world!'), 'Hello, world!');
  });

  it('keeps accented Latin-1 letters, which share their codes with WinAnsi', () => {
    assert.equal(winAnsi('café Ünter'), 'caf\xe9 \xdcnter');
  });

  it('maps the punctuation OCR actually produces into WinAnsi upper codes', () => {
    assert.equal(winAnsi('‘a’'), '\x91a\x92');
    assert.equal(winAnsi('“b”'), '\x93b\x94');
    assert.equal(winAnsi('1914–18'), '1914\x9618');
    assert.equal(winAnsi('and—then'), 'and\x97then');
    assert.equal(winAnsi('so…'), 'so\x85');
  });

  it('drops characters WinAnsi cannot hold rather than substituting them', () => {
    // A dropped glyph still leaves a searchable stem; '?' matches nothing typed.
    assert.equal(winAnsi('Bałtyk'), 'Batyk');
    assert.equal(winAnsi('中文'), '');
  });

  it('drops control characters', () => {
    assert.equal(winAnsi('a\x00b\x1fc'), 'abc');
  });
});

describe('pdfString', () => {
  it('wraps the text in parentheses', () => {
    assert.equal(pdfString('word'), '(word)');
  });

  it('escapes the delimiters that would end the string early', () => {
    assert.equal(pdfString('(a)'), '(\\(a\\))');
    assert.equal(pdfString('a\\b'), '(a\\\\b)');
  });

  it('writes bytes above ASCII as octal, so the file stays 7-bit', () => {
    assert.equal(pdfString('caf\xe9'), '(caf\\351)');
    assert.equal(pdfString('\x92'), '(\\222)');
  });
});

describe('textWidth', () => {
  it('measures in ems at font size 1', () => {
    // Helvetica 'l' is 222/1000, 'm' is 833/1000.
    assert.equal(textWidth('l'), .222);
    assert.equal(textWidth('m'), .833);
    // H 722 + i 222 + space 278 + t 278 + h 556 + e 556 + r 333 + e 556.
    assert.equal(Math.round(textWidth('Hi there') * 1000), 3501);
  });

  it('falls back to a middling width for the upper half of WinAnsi', () => {
    assert.equal(textWidth('\xe9'), .556);
  });

  it('is zero for an empty string, so the caller can reject it', () => {
    assert.equal(textWidth(''), 0);
  });
});

describe('textLayerOps', () => {
  it('opens invisible and closes the text object', () => {
    const ops = textLayerOps([word('Hi', 0, 0, 20, 10)], place);
    assert.ok(ops.startsWith('BT\n3 Tr\n'));
    assert.ok(ops.endsWith('ET\n'));
  });

  it('flips y, so a word at the top of the bitmap is near the top of the page', () => {
    const ops = textLayerOps([word('top', 12, 0, 60, 30)], place);
    // imageHeight 1000 - y1 30 = 970 up from the image's bottom edge.
    assert.ok(ops.includes('1 0 0 1 12.00 970.00 Tm'), ops);
  });

  it('offsets by where the image sits on the sheet', () => {
    const ops = textLayerOps([word('x', 0, 0, 10, 10)], {
      scale: 1, left: 40, bottom: 25, imageHeight: 1000
    });
    assert.ok(ops.includes('1 0 0 1 40.00 1015.00 Tm'), ops);
  });

  it('scales boxes into points', () => {
    const ops = textLayerOps([word('x', 100, 100, 200, 140)], {
      scale: .5, left: 0, bottom: 0, imageHeight: 1000
    });
    // 40px tall at half scale is a 20pt font, 100px down the page from y=500.
    assert.ok(ops.includes('/F1 20.00 Tf'), ops);
    assert.ok(ops.includes('1 0 0 1 50.00 430.00 Tm'), ops);
  });

  it('stretches each word to the width of its own box', () => {
    // 'll' is 0.444 em, so at a 10pt font it is 4.44pt wide naturally. A 22.2pt
    // box therefore needs exactly 500% horizontal scaling.
    const ops = textLayerOps([word('ll', 0, 0, 22.2, 10)], place);
    assert.ok(ops.includes('500.00 Tz'), ops);
  });

  it('prefers the line baseline and em size when the recogniser gave them', () => {
    const ops = textLayerOps(
      [{ t: 'one', x0: 0, y0: 480, x1: 30, y1: 495, b: 500, s: 20 }], place
    );
    // The word box is 15px of x-height; the line says 20px em on a 500 baseline.
    assert.ok(ops.includes('/F1 20.00 Tf'), ops);
    assert.ok(ops.includes('1 0 0 1 0.00 500.00 Tm'), ops);
  });

  it('sizes words on one line alike, which the word boxes alone would not', () => {
    const shared = { b: 500, s: 20 };
    const ops = textLayerOps([
      { t: 'one', x0: 0, y0: 485, x1: 30, y1: 500, ...shared },
      { t: 'gap', x0: 40, y0: 485, x1: 70, y1: 504, ...shared }
    ], place);
    assert.equal(ops.match(/\/F1 20\.00 Tf/g)?.length, 2);
  });

  it('skips whitespace-only and degenerate boxes', () => {
    assert.equal(textLayerOps([word('   ', 0, 0, 40, 10)], place), '');
    assert.equal(textLayerOps([word('a', 10, 10, 10, 20)], place), '');
    assert.equal(textLayerOps([word('a', 10, 10, 40, 10)], place), '');
  });

  it('returns nothing at all when no word survived, so no empty BT/ET is written', () => {
    assert.equal(textLayerOps([], place), '');
    assert.equal(textLayerOps([word('中', 0, 0, 20, 20)], place), '');
  });

  it('paints the glyphs in text mode, and measures them in the serif', () => {
    const ops = textLayerOps([{ t: 'll', x0: 0, y0: 0, x1: 5.56, y1: 10, b: 10, s: 10 }],
      place, 'text');
    assert.ok(ops.startsWith('BT\n0 Tr\n'));
    // Times 'l' is 278/1000, so 'll' is 5.56pt at a 10pt size: no stretch needed.
    assert.ok(ops.includes('100.00 Tz'), ops);
  });

  it('leaves the slack after a painted word rather than letterspacing it', () => {
    // A box far wider than the serif needs: the word keeps its own proportions
    // and starts where it was found, and the gap falls where a space goes.
    const ops = textLayerOps([word('ll', 0, 0, 100, 10)], place, 'text');
    assert.ok(ops.includes('105.00 Tz'), ops);
  });

  it('still condenses a painted word that would otherwise run into the next', () => {
    const ops = textLayerOps([word('milliner', 0, 0, 10, 10)], place, 'text');
    assert.ok(/ (\d\d?\.\d\d) Tz/.test(ops), ops);
    assert.ok(Number(ops.match(/ (\d+\.\d\d) Tz/)![1]) < 100, ops);
  });

  it('reads the letters to size a painted word the line gave no metrics for', () => {
    // A 9px box of x-height only: 'one' reaches neither up nor down, so the em
    // is 9 / 0.45 = 20 and the baseline is the bottom of the box.
    const ops = textLayerOps([word('one', 0, 491, 30, 500)], place, 'text');
    assert.ok(ops.includes('/F1 20.00 Tf'), ops);
    assert.ok(ops.includes('1 0 0 1 0.00 500.00 Tm'), ops);
  });

  it('lifts a painted word off its descenders rather than sitting the line on them', () => {
    // 'flight' has ascenders and a descender: 0.7 + 0.21 of a 20px em is 18.2px,
    // and the baseline is 0.21 em above the bottom of the box.
    const ops = textLayerOps([word('flight', 0, 481.8, 30, 500)], place, 'text');
    assert.ok(ops.includes('/F1 20.00 Tf'), ops);
    assert.ok(ops.includes('1 0 0 1 0.00 504.20 Tm'), ops);
  });

  it('leaves the invisible layer measuring boxes as it always did', () => {
    const ops = textLayerOps([word('one', 0, 491, 30, 500)], place);
    assert.ok(ops.includes('/F1 9.00 Tf'), ops);
    assert.ok(ops.includes('1 0 0 1 0.00 500.00 Tm'), ops);
  });

  it('keeps the words of a page in one text object', () => {
    const ops = textLayerOps([
      word('one', 0, 0, 30, 10), word('two', 40, 0, 70, 10)
    ], place);
    assert.equal(ops.match(/BT\n/g)?.length, 1);
    assert.equal(ops.match(/ Tj/g)?.length, 2);
  });
});
