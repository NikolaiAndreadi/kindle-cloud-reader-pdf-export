// The slice of tesseract.js this extension actually uses.
//
// Hand-written rather than taken from the package's own types: the library
// arrives as a vendored <script> in preview.html, not through the bundle, so
// there is no import for tsc to follow — and the package is a devDependency
// present only to vendor its files, which a typecheck should not depend on.
//
// Flat names in the project's ambient style; `erasableSyntaxOnly` rules out the
// namespace this would otherwise be.

interface TessBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface TessWord {
  text: string;
  /** 0–100. */
  confidence: number;
  bbox: TessBbox;
}

/**
 * The line's baseline, in page pixels: (x0,y0) to (x1,y1) along the line, so a
 * skewed scan has y0 !== y1.
 */
interface TessBaseline {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Vertical metrics the recogniser measured for the row. rowHeight comes out at
 * x-height plus ascender plus descender, which is within a few percent of the
 * type size — and unlike the line box it does not shrink for a line of capitals.
 */
interface TessRowAttributes {
  rowHeight: number;
  ascenders: number;
  descenders: number;
}

interface TessLine {
  words: TessWord[];
  /** Ascender top to descender bottom, for the whole line. */
  bbox: TessBbox;
  // Optional in this declaration though every observed build reports both: they
  // are vendored third-party output, and the fallback for missing metrics costs
  // three lines.
  baseline?: TessBaseline;
  rowAttributes?: TessRowAttributes;
}

interface TessParagraph {
  lines: TessLine[];
}

interface TessBlock {
  paragraphs: TessParagraph[];
}

/** Null unless the recognise call asked for `blocks`. */
interface TessPage {
  blocks: TessBlock[] | null;
}

interface TessLoggerMessage {
  status: string;
  progress: number;
}

interface TessWorkerOptions {
  workerPath: string;
  corePath: string;
  langPath: string;
  /** False to load the worker from its own URL instead of a blob: copy. */
  workerBlobURL: boolean;
  /** 'none' to skip the IndexedDB cache for language data. */
  cacheMethod: string;
  logger: (message: TessLoggerMessage) => void;
}

interface TessOutputFormats {
  text: boolean;
  blocks: boolean;
}

interface TessWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: HTMLCanvasElement,
    options?: Record<string, never>,
    output?: Partial<TessOutputFormats>
  ): Promise<{ data: TessPage }>;
  terminate(): Promise<unknown>;
}

/**
 * Undefined in the type as well as at runtime: the <script> tag is a separate
 * file that can be missing from an unbuilt checkout, and a clear message beats a
 * ReferenceError from inside a click handler.
 */
declare const Tesseract: {
  createWorker(
    langs: string, oem?: number, options?: Partial<TessWorkerOptions>
  ): Promise<TessWorker>;
} | undefined;
