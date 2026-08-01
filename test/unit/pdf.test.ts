import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bytesFromDataUrl, pdfBuilder } from '../../src/pdf/builder.ts';

const text = async (blob: Blob): Promise<string> =>
  new TextDecoder('latin1').decode(new Uint8Array(await blob.arrayBuffer()));

const jpeg = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 256);

const word = (t: string, x0: number, y0: number, x1: number, y1: number): OcrWord =>
  ({ t, x0, y0, x1, y1 });

describe('bytesFromDataUrl', () => {
  it('decodes the base64 payload after the comma', () => {
    assert.deepEqual([...bytesFromDataUrl('data:image/jpeg;base64,AAECAw==')!], [0, 1, 2, 3]);
  });

  it('keeps bytes above 0x7f intact rather than widening them to UTF-8', () => {
    const bytes = bytesFromDataUrl('data:image/jpeg;base64,/9j/4A==')!;
    assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0xe0]);
  });

  it('returns null for something that is not a data URL', () => {
    assert.equal(bytesFromDataUrl('blob:https://read.amazon.com/abc'), null);
  });
});

describe('pdfBuilder', () => {
  it('starts with a PDF header and a binary marker', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(16) });
    const body = await text(builder.finish());
    assert.ok(body.startsWith('%PDF-1.4\n'));
    assert.ok(body.includes('%\xe2\xe3\xcf\xd3'));
  });

  it('ends with the trailer and EOF marker', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(16) });
    assert.ok((await text(builder.finish())).endsWith('%%EOF'));
  });

  it('counts the pages it has been given', () => {
    const builder = pdfBuilder();
    assert.equal(builder.pages, 0);
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    assert.equal(builder.pages, 2);
  });

  it('ignores an image with no dimensions rather than emitting a broken page', () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 0, height: 1200, bytes: jpeg(8) });
    builder.addImage({ width: 800, height: 0, bytes: jpeg(8) });
    assert.equal(builder.pages, 0);
  });

  it('declares /Count and /Kids matching the pages added', async () => {
    const builder = pdfBuilder();
    for (let i = 0; i < 3; i++) builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    const body = await text(builder.finish());
    assert.ok(body.includes('/Type /Pages /Count 3 /Kids [4 0 R 7 0 R 10 0 R]'));
  });

  it('embeds each JPEG as a DCTDecode stream of the right length', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 640, height: 480, bytes: jpeg(37) });
    const body = await text(builder.finish());
    assert.ok(body.includes('/Filter /DCTDecode /Length 37'));
    assert.ok(body.includes('/Width 640 /Height 480'));
  });

  it('defaults to A4 pages with the bitmap fitted and centred', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 1200, height: 1600, bytes: jpeg(8) });
    const body = await text(builder.finish());
    assert.ok(body.includes('/MediaBox [0 0 595.28 841.89]'));
    // Fitted on width, so the bands are top and bottom: 595.28 * 1600/1200.
    assert.ok(body.includes('595.28 0 0 793.71 0.00 24.09 cm'));
  });

  it('writes the paper size it was asked for', async () => {
    const letter = pdfBuilder({ paper: 'letter' });
    letter.addImage({ width: 1200, height: 1600, bytes: jpeg(8) });
    assert.ok((await text(letter.finish())).includes('/MediaBox [0 0 612.00 792.00]'));
  });

  it('keeps the capture aspect ratio at 612 points wide for native paper', async () => {
    const builder = pdfBuilder({ paper: 'native' });
    builder.addImage({ width: 1200, height: 1600, bytes: jpeg(8) });
    const body = await text(builder.finish());
    assert.ok(body.includes('/MediaBox [0 0 612.00 816.00]'));
    assert.ok(body.includes('612.00 0 0 816.00 0.00 0.00 cm'));
  });

  it('turns the sheet sideways for a landscape capture', async () => {
    const builder = pdfBuilder({ paper: 'a4' });
    builder.addImage({ width: 2000, height: 1200, bytes: jpeg(8) });
    assert.ok((await text(builder.finish())).includes('/MediaBox [0 0 841.89 595.28]'));
  });

  it('leaves out the text layer when no words are given', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    const body = await text(builder.finish());
    assert.ok(!body.includes(' Tj'));
    assert.equal(builder.textPages, 0);
  });

  it('draws OCR words invisibly, after the image', async () => {
    const builder = pdfBuilder({ paper: 'native' });
    builder.addImage(
      { width: 1200, height: 1600, bytes: jpeg(8) },
      [word('Hello', 0, 0, 120, 40)]
    );
    const body = await text(builder.finish());
    assert.equal(builder.textPages, 1);
    assert.ok(body.indexOf('/Im0 Do') < body.indexOf('(Hello) Tj'), 'text must come after the image');
    assert.ok(body.includes('3 Tr'));
    // 612/1200 points per pixel: a 40px box is 20.40pt tall, and its top edge
    // sits at the top of the page, so the baseline is 816 - 20.40.
    assert.ok(body.includes('/F1 20.40 Tf'));
    assert.ok(body.includes('1 0 0 1 0.00 795.60 Tm'));
  });

  it('counts /Length over the text layer too, so the stream is not truncated', async () => {
    const builder = pdfBuilder();
    builder.addImage(
      { width: 800, height: 1200, bytes: jpeg(8) },
      [word('searchable', 10, 10, 200, 40)]
    );
    const body = await text(builder.finish());
    const declared = Number(body.match(/<< \/Length (\d+) >>\nstream\nq\n/)![1]);
    const start = body.indexOf('stream\nq\n') + 'stream\n'.length;
    assert.equal(body.slice(start, start + declared).endsWith('ET\n'), true);
    assert.equal(body.slice(start + declared, start + declared + 9), 'endstream');
  });

  it('names the Helvetica font every page refers to', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    const body = await text(builder.finish());
    assert.ok(body.includes('/Font << /F1 3 0 R >>'));
    assert.ok(body.includes('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  });

  it('writes an xref offset for every object it emitted', async () => {
    const builder = pdfBuilder();
    for (let i = 0; i < 2; i++) builder.addImage({ width: 800, height: 1200, bytes: jpeg(8) });
    const body = await text(builder.finish());
    // 3 fixed objects + 3 per page, plus the free entry at index 0.
    assert.ok(body.includes('xref\n0 10\n0000000000 65535 f \n'));
    assert.ok(body.includes('/Size 10 /Root 1 0 R'));
  });

  it('points startxref at the real byte offset of the xref table', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(64) });
    const body = await text(builder.finish());
    const declared = Number(body.match(/startxref\n(\d+)\n%%EOF$/)![1]);
    assert.equal(body.indexOf('xref\n0 ', declared), declared);
  });

  it('records byte offsets that land on each object header', async () => {
    const builder = pdfBuilder();
    builder.addImage({ width: 800, height: 1200, bytes: jpeg(24) }, [word('word', 1, 1, 50, 20)]);
    const body = await text(builder.finish());
    // '\nxref\n', not 'xref\n': the latter also matches inside 'startxref'.
    const table = body.slice(body.lastIndexOf('\nxref\n'));
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    assert.equal(offsets.length, 6);
    offsets.forEach((offset, i) => {
      assert.ok(body.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1} offset is wrong`);
    });
  });

  it('produces the same bytes whether or not flush was called mid-stream', async () => {
    const build = (withFlush: boolean): Blob => {
      const builder = pdfBuilder();
      for (let i = 0; i < 3; i++) {
        builder.addImage({ width: 800, height: 1200, bytes: jpeg(16) });
        if (withFlush) builder.flush();
      }
      return builder.finish();
    };
    assert.equal(await text(build(true)), await text(build(false)));
  });

  it('still writes a valid empty document when no page could be read', async () => {
    const body = await text(pdfBuilder().finish());
    assert.ok(body.includes('/Type /Pages /Count 0 /Kids []'));
    assert.ok(body.endsWith('%%EOF'));
  });
});
