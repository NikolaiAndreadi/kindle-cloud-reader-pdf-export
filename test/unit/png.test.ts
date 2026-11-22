import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, inflateSync } from 'node:zlib';

import { encodePng, filterRows, isPng, pngDataUrl, readPng } from '../../src/shared/png.ts';

/** Reverses PNG filtering for 8-bit RGB, so a round trip can be checked pixel for pixel. */
function unfilter(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 3;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!;
      const a = i >= 3 ? out[y * stride + i - 3]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= 3 && y > 0 ? out[(y - 1) * stride + i - 3]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
        ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return out;
}

/** A page-like mix: flat paper, a gradient, and noise, so every filter gets picked somewhere. */
function picture(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      seed = (seed * 1103515245 + 12345) >>> 0;
      const region = y % 3;
      rgba[o] = region === 0 ? 250 : region === 1 ? x * 9 : seed & 0xff;
      rgba[o + 1] = region === 0 ? 248 : region === 1 ? y * 13 : (seed >> 8) & 0xff;
      rgba[o + 2] = region === 0 ? 240 : region === 1 ? x + y : (seed >> 16) & 0xff;
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

const rgbOf = (rgba: Uint8ClampedArray): number[] => [...rgba].filter((_, i) => (i & 3) !== 3);

describe('encodePng', () => {
  it('writes an 8-bit RGB PNG that decodes back to the exact pixels', async () => {
    const width = 23;
    const height = 17;
    const rgba = picture(width, height);
    const png = await encodePng(rgba, width, height);

    assert.ok(isPng(png));
    const parsed = readPng(png);
    assert.ok(parsed);
    assert.equal(parsed.width, width);
    assert.equal(parsed.height, height);
    assert.equal(parsed.colors, 3);
    const pixels = unfilter(new Uint8Array(inflateSync(parsed.data)), width, height);
    assert.deepEqual([...pixels], rgbOf(rgba));
  });

  it('gives every chunk a correct CRC', async () => {
    const png = await encodePng(picture(4, 4), 4, 4);
    const view = new DataView(png.buffer);
    const types: string[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = view.getUint32(offset);
      types.push(String.fromCharCode(...png.subarray(offset + 4, offset + 8)));
      assert.equal(view.getUint32(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
      offset += 12 + length;
    }
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
  });

  it('filters flat rows to almost nothing', async () => {
    const rgba = new Uint8ClampedArray(64 * 2 * 4).fill(200);
    const rows = await filterRows(rgba, 64, 2);
    // Every byte after the first pixel of each row predicts exactly.
    const nonzero = [...rows].filter((byte, i) => i % (64 * 3 + 1) !== 0 && byte !== 0);
    assert.ok(nonzero.length <= 6, `${nonzero.length} unpredicted bytes`);
  });
});

describe('readPng', () => {
  const header = (color: number, depth = 8, interlace = 0): Uint8Array => {
    const bytes = new Uint8Array(8 + 25 + 12 + 1 + 12);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([...'IHDR'].map((c) => c.charCodeAt(0)), 12);
    view.setUint32(16, 2);
    view.setUint32(20, 2);
    bytes[24] = depth;
    bytes[25] = color;
    bytes[28] = interlace;
    view.setUint32(33, 1);
    bytes.set([...'IDAT'].map((c) => c.charCodeAt(0)), 37);
    view.setUint32(46, 0);
    bytes.set([...'IEND'].map((c) => c.charCodeAt(0)), 50);
    for (const offset of [8, 33, 46]) {
      const end = offset + 8 + view.getUint32(offset);
      view.setUint32(end, crc32(bytes.subarray(offset + 4, end)));
    }
    return bytes;
  };

  it('accepts gray and RGB', () => {
    assert.equal(readPng(header(0))?.colors, 1);
    assert.equal(readPng(header(2))?.colors, 3);
  });

  it('refuses layouts a PDF cannot take without decoding', () => {
    assert.equal(readPng(header(6)), null, 'alpha');
    assert.equal(readPng(header(3)), null, 'palette');
    assert.equal(readPng(header(2, 16)), null, '16-bit');
    assert.equal(readPng(header(2, 8, 1)), null, 'interlaced');
  });

  it('refuses a truncated file and anything that is not a PNG', () => {
    assert.equal(readPng(header(2).subarray(0, 40)), null);
    assert.equal(readPng(header(2).subarray(0, 46)), null);
    assert.equal(readPng(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), null);
  });
});

describe('pngDataUrl', () => {
  it('base64-encodes payloads longer than one chunk', () => {
    const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 31) & 0xff);
    const url = pngDataUrl(bytes);
    assert.ok(url.startsWith('data:image/png;base64,'));
    assert.deepEqual(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'), Buffer.from(bytes));
  });
});
