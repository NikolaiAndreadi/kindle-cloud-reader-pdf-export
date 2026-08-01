// Tesseract, driven from an extension page.
//
// Everything it needs is vendored under vendor/tesseract (see vendor.mjs), so
// none of the CDN paths tesseract.js defaults to are ever used: MV3 will not
// load code from off-package, and this has to work offline anyway. The library
// itself arrives as a plain <script> in preview.html rather than through the
// bundle, which keeps a 60 KB minified blob out of preview.js.

/** OEM.LSTM_ONLY. A number here because the enum lives in the vendored script. */
const OEM_LSTM_ONLY = 1;

/** PSM.AUTO: find the blocks, but do not go looking for a second column. */
const PSM_AUTO = '3';

/**
 * Kindle hands out roughly 150–200 dpi page bitmaps, which is below where the
 * LSTM recogniser does its best work: it wants an x-height of 30-odd pixels.
 * Upscaling adds no detail but does let the line finder separate the rows, and
 * it is worth several percent of word accuracy on a small capture. Coordinates
 * come back divided by the factor, so nothing downstream sees this.
 */
const TARGET_WIDTH = 1800;
const MAX_UPSCALE = 3;

/** Words the recogniser is this unsure of are usually marks on the page. */
const MIN_CONFIDENCE = 30;

/**
 * Fallback for a line the recogniser gave no row metrics for: its box runs from
 * the top of the ascenders to the bottom of the descenders, about 0.93 em in a
 * typical book face, with the baseline a descender up from the bottom.
 */
const LINE_BOX_EMS = .93;
const DESCENDER_EMS = .21;

const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * The baseline of a line as a function of x, in the stored page's pixel space.
 *
 * The recogniser reports it as a segment rather than a height, which matters on a
 * page it thinks is slightly rotated. When it reports nothing usable, the bottom
 * of the line box less a descender is the estimate — that is where the ink ends.
 */
function baselineFor(line: TessLine, factor: number, em: number): (x: number) => number {
  const { baseline, bbox } = line;
  const inside = baseline && baseline.x1 > baseline.x0 &&
    Math.min(baseline.y0, baseline.y1) >= bbox.y0 &&
    Math.max(baseline.y0, baseline.y1) <= bbox.y1;
  if (!baseline || !inside) {
    const flat = bbox.y1 / factor - em * DESCENDER_EMS;
    return () => flat;
  }
  const slope = (baseline.y1 - baseline.y0) / (baseline.x1 - baseline.x0);
  return (x) => (baseline.y0 + slope * (x - baseline.x0)) / factor;
}

const asset = (name: string): string => chrome.runtime.getURL(`vendor/tesseract/${name}`);

export interface Recogniser {
  page(dataUrl: string, width: number, height: number): Promise<PageWords>;
  close(): Promise<void>;
}

export interface PageWords {
  words: OcrWord[];
  confidence: number;
}

/**
 * A canvas holding the page, upscaled if it is small. Reused across pages: one
 * canvas per page of a 400-page book is a lot of garbage, and the OCR worker is
 * the only thing waiting on it.
 */
let scratch: HTMLCanvasElement | null = null;

async function prepare(dataUrl: string, width: number, height: number): Promise<{
  canvas: HTMLCanvasElement; factor: number;
}> {
  const factor = Math.min(MAX_UPSCALE, Math.max(1, TARGET_WIDTH / width));

  // createImageBitmap, not an <img> with decode(): a background tab never paints,
  // and HTMLImageElement.decode() does not resolve until it does. Since the whole
  // point of running OCR here is that it can be left alone for twenty minutes,
  // that would stall the run the moment the tab stopped being the front one.
  const blob = await fetch(dataUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(blob);

  try {
    scratch ??= document.createElement('canvas');
    scratch.width = Math.round(width * factor);
    scratch.height = Math.round(height * factor);
    const context = scratch.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not get a 2D context for OCR.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, scratch.width, scratch.height);
  } finally {
    bitmap.close();
  }
  return { canvas: scratch, factor };
}

/**
 * Start one recogniser. Loading the core and the language data takes a few
 * seconds, so a run creates this once and feeds every page through it.
 */
export async function createRecogniser(onLoad?: (status: string) => void): Promise<Recogniser> {
  if (typeof Tesseract === 'undefined') {
    throw new Error('OCR engine is missing — run "npm run vendor" and reload the extension.');
  }

  const worker = await Tesseract.createWorker('eng', OEM_LSTM_ONLY, {
    // Paths, not directories: naming the file directly is what stops the worker
    // probing for wasm features and reaching for a build we did not vendor.
    workerPath: asset('worker.min.js'),
    corePath: asset('tesseract-core-simd-lstm.wasm.js'),
    langPath: asset('').replace(/\/$/, ''),
    // The default fetches the worker and re-serves it as a blob: URL, which the
    // extension CSP refuses. Loading it from its own chrome-extension:// URL is
    // same-origin here, so the indirection buys nothing.
    workerBlobURL: false,
    // Nothing to cache to: IndexedDB caching exists to save re-downloading the
    // language data, and ours is a local file.
    cacheMethod: 'none',
    ...(onLoad ? { logger: (message) => onLoad(message.status) } : {})
  });

  await worker.setParameters({
    tessedit_pageseg_mode: PSM_AUTO,
    // Written into the PDF text layer, where a run of words is all there is.
    preserve_interword_spaces: '1'
  });

  return {
    async page(dataUrl: string, width: number, height: number): Promise<PageWords> {
      const { canvas, factor } = await prepare(dataUrl, width, height);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });

      const words: OcrWord[] = [];
      let confidence = 0;
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            // Every measurement is divided back into the stored page's own pixel
            // space, so a text layer outlives a change to the upscaling above.
            const lineHeight = (line.bbox.y1 - line.bbox.y0) / factor;
            // rowHeight is the recogniser's own measure of the type size, and
            // unlike the line box it does not collapse for a line of capitals.
            const em = (line.rowAttributes?.rowHeight || 0) / factor || lineHeight / LINE_BOX_EMS;
            const baselineAt = baselineFor(line, factor, em);

            for (const word of line.words) {
              if (word.confidence < MIN_CONFIDENCE || !word.text.trim()) continue;
              const box: OcrWord = {
                t: word.text,
                x0: round(word.bbox.x0 / factor),
                y0: round(word.bbox.y0 / factor),
                x1: round(word.bbox.x1 / factor),
                y1: round(word.bbox.y1 / factor)
              };
              // Skipped for a line whose box is shorter than the word in it: one
              // superscript or a stray mark makes the row metrics describe
              // something other than the text, and the word box is then safer.
              if (em > 0 && lineHeight >= box.y1 - box.y0) {
                box.b = round(baselineAt(word.bbox.x0));
                box.s = round(em);
              }
              words.push(box);
              confidence += word.confidence;
            }
          }
        }
      }
      return {
        words,
        confidence: words.length ? Math.round(confidence / words.length) : 0
      };
    },
    close(): Promise<void> {
      return worker.terminate().then(() => undefined);
    }
  };
}
