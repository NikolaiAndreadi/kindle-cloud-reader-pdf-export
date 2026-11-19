const DEFAULT_BACKGROUND = '#ffffff';
const DECODE_TIMEOUT = 3000;

// Only images at least this wide are candidates for splitting.
const SPREAD_ASPECT = 1.2;

// Side of the downscale used to identify a rendered view. Big enough that two
// different pages of prose do not average out to the same thumbnail.
const SIGNATURE_SIDE = 128;
const GUTTER_TOLERANCE = 12;

export type SplitMode = 'off' | 'gutter' | 'aspect';

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

// The rectangles of a bitmap that should each become a PDF page.
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

function samplePixels(element: PageElement, region: Region): Uint8ClampedArray | null {
  signatureCanvas ??= document.createElement('canvas');
  signatureCanvas.width = SIGNATURE_SIDE;
  signatureCanvas.height = SIGNATURE_SIDE;
  const context = signatureCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) return null;
  try {
    context.fillStyle = DEFAULT_BACKGROUND;
    context.fillRect(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
    context.drawImage(element, region.sx, region.sy, region.sw, region.sh, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
    return context.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
  } catch {
    // A cross-origin source taints the canvas and blocks getImageData.
    return null;
  }
}

// The colors on the two sides of a gutter can differ. Check each center column
// against its own first pixel, then require visible content beside the gutter
// so a blank landscape view stays whole.
function hasCenterGutter(pixels: Uint8ClampedArray): boolean {
  const rowBytes = SIGNATURE_SIDE * 4;
  const center = rowBytes / 2;
  let hasContent = false;
  for (let i = 0; i < pixels.length; i += 4) {
    const column = i % rowBytes;
    const gutter = column < center ? center - 4 : center;
    const contrast = Math.max(
      Math.abs(pixels[i]! - pixels[gutter]!),
      Math.abs(pixels[i + 1]! - pixels[gutter + 1]!),
      Math.abs(pixels[i + 2]! - pixels[gutter + 2]!)
    );
    if (contrast <= GUTTER_TOLERANCE) continue;
    if (column === gutter) return false;
    hasContent = true;
  }
  return hasContent;
}

// The signature depends on the sampled source pixels, so JPEG quality does
// not affect it. Keep the hash identical for regions already held in storage.
function signatureOf(region: Region, pixels: Uint8ClampedArray | null): string | null {
  if (!pixels) return null;
  let hash = FNV_OFFSET;
  for (let i = 0; i < pixels.length; i++) {
    if ((i & 3) === 3) continue;
    hash ^= pixels[i]!;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return `${region.sw}x${region.sh}-${hash.toString(36)}`;
}

// One rendered element can hold two book pages, so this returns each region
// with its hash and the caller skips encoding anything already captured.
export async function viewsOf(element: PageElement, split: SplitMode): Promise<RegionView[]> {
  if (!await decoded(element)) return [];
  const { width, height } = naturalSize(element);
  if (!width || !height) return [];
  const whole = { sx: 0, sy: 0, sw: width, sh: height };
  const wide = isWide(width, height);
  // Splitting by aspect alone is preserved for scans that began with that rule.
  if (split === 'aspect' && wide) return splitViews(element, width, height);

  const pixels = samplePixels(element, whole);
  if (split === 'gutter' && wide && pixels && hasCenterGutter(pixels)) {
    return splitViews(element, width, height);
  }
  return [{ region: whole, signature: signatureOf(whole, pixels) }];
}

function splitViews(element: PageElement, width: number, height: number): RegionView[] {
  return regionsFor(width, height, true).map((region) => ({
    region,
    signature: signatureOf(region, samplePixels(element, region))
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
