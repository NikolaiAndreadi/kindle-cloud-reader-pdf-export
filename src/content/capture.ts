const DEFAULT_BACKGROUND = '#ffffff';
const DECODE_TIMEOUT = 3000;

// Above this width/height ratio a capture is a two-column spread, not one page.
const SPREAD_ASPECT = 1.2;

// Side of the downscale used to identify a rendered view. Big enough that two
// different pages of prose do not average out to the same thumbnail.
const SIGNATURE_SIDE = 128;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

let signatureCanvas: HTMLCanvasElement | null = null;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// localName rather than instanceof: elements pulled out of an iframe belong to
// another realm, where instanceof HTMLImageElement is false.
const asImage = (element: PageElement): HTMLImageElement | null =>
  element.localName === 'img' ? element as HTMLImageElement : null;

// Page images arrive as blob: URLs that may still be decoding when the loop
// comes round, which would otherwise store a blank page.
async function decoded(element: PageElement): Promise<boolean> {
  const image = asImage(element);
  if (!image) return true;
  if (image.complete && image.naturalWidth) return true;
  const settled = await Promise.race([
    image.decode().then(() => true, () => false),
    wait(DECODE_TIMEOUT).then(() => false)
  ]);
  return settled && image.naturalWidth > 0;
}

export function naturalSize(element: PageElement): { width: number; height: number } {
  const image = asImage(element);
  // naturalWidth/Height, not the layout box: the element is styled with
  // object-fit: cover, so the box is a crop while the bitmap is a whole page.
  return {
    width: image ? (image.naturalWidth || image.width) : (element as HTMLCanvasElement).width,
    height: image ? (image.naturalHeight || image.height) : (element as HTMLCanvasElement).height
  };
}

export const isWide = (width: number, height: number): boolean =>
  height > 0 && width / height >= SPREAD_ASPECT;

/**
 * The rectangles of a bitmap that should each become a PDF page. A landscape
 * bitmap is a two-column spread, so splitting cuts it down the middle.
 */
export function regionsFor(width: number, height: number, split: boolean): Region[] {
  if (!width || !height) return [];
  if (!split || !isWide(width, height)) return [{ sx: 0, sy: 0, sw: width, sh: height }];
  const half = Math.floor(width / 2);
  return [
    { sx: 0, sy: 0, sw: half, sh: height },
    { sx: half, sy: 0, sw: width - half, sh: height }
  ];
}

/**
 * Short, cheap content identity taken from an encoded page. Sampling beats
 * hashing a whole 400 KB data URL, and this only has to tell one rendered page
 * from another. Used only when signatureOf could not read the source pixels.
 */
export function fingerprintOf(dataUrl: string, width: number, height: number): string {
  let hash = FNV_OFFSET;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
  };
  const middle = Math.floor(dataUrl.length / 2);
  mix(`${width}x${height}:${dataUrl.length}`);
  mix(dataUrl.slice(-512));
  mix(dataUrl.slice(middle, middle + 512));
  return `${width}x${height}-${dataUrl.length.toString(36)}-${hash.toString(36)}`;
}

/**
 * Identity of a rendered region, taken from a small downscale of the source
 * pixels. Cheap enough to run before deciding whether to encode, and unlike a
 * hash of the JPEG it does not change when the quality setting changes.
 */
function signatureOf(element: PageElement, region: Region): string | null {
  signatureCanvas ??= document.createElement('canvas');
  signatureCanvas.width = SIGNATURE_SIDE;
  signatureCanvas.height = SIGNATURE_SIDE;
  const context = signatureCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) return null;
  try {
    context.fillStyle = DEFAULT_BACKGROUND;
    context.fillRect(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
    context.drawImage(element, region.sx, region.sy, region.sw, region.sh, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
    const data = context.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
    let hash = FNV_OFFSET;
    for (let i = 0; i < data.length; i++) {
      if ((i & 3) === 3) continue; // alpha carries nothing here
      hash ^= data[i]!;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return `${region.sw}x${region.sh}-${hash.toString(36)}`;
  } catch {
    // A cross-origin source taints the canvas and blocks getImageData.
    return null;
  }
}

/**
 * One rendered element can hold two book pages: in two-column mode the reader
 * paints the whole spread as a single landscape bitmap. Returns each region
 * with its hash so the caller can skip encoding anything already captured.
 */
export async function viewsOf(element: PageElement, split: boolean): Promise<RegionView[]> {
  if (!await decoded(element)) return [];
  const { width, height } = naturalSize(element);
  return regionsFor(width, height, split).map((region) => ({
    region,
    signature: signatureOf(element, region)
  }));
}

export function renderRegion(
  element: PageElement, region: Region, quality: number
): CapturedPage | null {
  const { sx, sy, sw, sh } = region;
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return null;
  // An alpha-free canvas starts out black, so transparent page margins would
  // come out black without this. The reader publishes the color it used.
  const background = element.closest<HTMLElement>('[data-background-color]')?.dataset.backgroundColor;
  context.fillStyle = /^#[0-9a-f]{3,8}$/i.test(background || '') ? background! : DEFAULT_BACKGROUND;
  context.fillRect(0, 0, sw, sh);
  context.drawImage(element, sx, sy, sw, sh, 0, 0, sw, sh);
  return { width: sw, height: sh, dataUrl: canvas.toDataURL('image/jpeg', quality) };
}
