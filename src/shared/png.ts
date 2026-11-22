// Our own encoder instead of canvas.toDataURL('image/png'): Chrome picks the PNG
// colour type itself and may emit RGBA, and a PDF can only take IDAT as-is when
// the pixels are plain RGB or gray. With alpha interleaved, every page would
// need inflating, unfiltering and re-deflating on export.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const COLOR_GRAY = 0;
const COLOR_RGB = 2;

export interface PngImage {
  width: number;
  height: number;
  colors: 1 | 3;
  /** The concatenated IDAT payload: a zlib stream of PNG-filtered rows. */
  data: Uint8Array;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= SIGNATURE.length && SIGNATURE.every((value, i) => bytes[i] === value);
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Magnitude of a filtered byte read as signed, which is what the heuristic sums. */
const weight = (value: number): number => {
  const byte = value & 0xff;
  return byte < 128 ? byte : 256 - byte;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export async function filterRows(rgba: ArrayLike<number>, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const out = new Uint8Array(height * (stride + 1));
  let previous = new Uint8Array(stride);
  let row = new Uint8Array(stride);

  let sliceStart = performance.now();
  for (let y = 0; y < height; y++) {
    if (performance.now() - sliceStart >= 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
    for (let x = 0, source = y * width * 4; x < stride; x += 3, source += 4) {
      row[x] = rgba[source]!;
      row[x + 1] = rgba[source + 1]!;
      row[x + 2] = rgba[source + 2]!;
    }

    const scores = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const value = row[i]!;
      const a = i >= 3 ? row[i - 3]! : 0;
      const b = previous[i]!;
      const c = i >= 3 ? previous[i - 3]! : 0;
      scores[0]! += weight(value);
      scores[1]! += weight(value - a);
      scores[2]! += weight(value - b);
      scores[3]! += weight(value - ((a + b) >> 1));
      scores[4]! += weight(value - paeth(a, b, c));
    }
    let filter = 0;
    for (let f = 1; f < 5; f++) if (scores[f]! < scores[filter]!) filter = f;

    let o = y * (stride + 1);
    out[o++] = filter;
    for (let i = 0; i < stride; i++, o++) {
      const value = row[i]!;
      const a = i >= 3 ? row[i - 3]! : 0;
      const b = previous[i]!;
      const c = i >= 3 ? previous[i - 3]! : 0;
      const predicted = filter === 0 ? 0
        : filter === 1 ? a
          : filter === 2 ? b
            : filter === 3 ? (a + b) >> 1
              : paeth(a, b, c);
      out[o] = (value - predicted) & 0xff;
    }
    [previous, row] = [row, previous];
  }
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(rgba: ArrayLike<number>, width: number, height: number): Promise<Uint8Array> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = COLOR_RGB;

  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(await filterRows(rgba, width, height))),
    chunk('IEND', new Uint8Array(0))
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function readPng(bytes: Uint8Array): PngImage | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let colors: 1 | 3 | 0 = 0;
  const idat: Uint8Array[] = [];
  let complete = false;

  for (let offset = SIGNATURE.length; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length || view.getUint32(end) !== crc32(bytes, offset + 4, end)) return null;

    if (type === 'IHDR') {
      if (length !== 13 || offset !== SIGNATURE.length) return null;
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const color = bytes[start + 9];
      const interlace = bytes[start + 12];
      if (depth !== 8 || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || interlace !== 0) return null;
      if (color === COLOR_RGB) colors = 3;
      else if (color === COLOR_GRAY) colors = 1;
      else return null;
    } else if (!colors || type === 'tRNS') {
      return null;
    } else if (type === 'IDAT') {
      if (length) idat.push(bytes.subarray(start, end));
    } else if (type === 'IEND') {
      complete = length === 0;
      break;
    }
    offset = end + 4;
  }

  if (!complete || !width || !height || !colors || !idat.length) return null;
  const data = idat.length === 1 ? idat[0]! : new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  if (idat.length > 1) {
    let offset = 0;
    for (const part of idat) {
      data.set(part, offset);
      offset += part.length;
    }
  }
  return { width, height, colors, data };
}

/** Chunked so a multi-megabyte page does not blow the argument limit of fromCharCode. */
export function pngDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
