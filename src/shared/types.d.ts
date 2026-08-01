// Shapes shared by the content script, the popup and the preview page.
//
// Declared as ambient globals rather than exported: three independent bundles
// use them, none of them at runtime, and a declaration file emits nothing. The
// alternative is an `import type` line in every module for no benefit.

/** A page element the reader has painted. */
type PageElement = HTMLImageElement | HTMLCanvasElement;

/**
 * Where the reader says it is. Kindle shows "Page X of Y" for some books and
 * "Location X of Y" for others, and hides the footer entirely when the reader
 * chrome auto-hides — so this is a movement hint, never a page number.
 */
interface ReaderPosition {
  kind: 'page' | 'location';
  value: number;
  total: number;
}

/** One captured view, in capture order. */
interface CaptureRecord {
  /** 1-based capture order. Decides PDF order and the storage key. */
  index: number;
  /** Position key such as "page:124", or '' when the footer was hidden. */
  position: string;
  /** Content identity, used to skip re-storing a view we already have. */
  fingerprint: string;
  /** Reader page number when it was visible, for display only. */
  page: number | null;
}

/** Per-book index kept alongside the stored pages. */
interface BookMeta {
  version: 2;
  bookId: string;
  captures: CaptureRecord[];
  total: number | null;
  kind: 'page' | 'location' | null;
  /** Split setting used to create this cache; null means legacy/unknown. */
  split: boolean | null;
  /**
   * JPEG quality the pages were encoded at. Fixed by the first scan so one book
   * cannot end up holding pages encoded two ways. Null for caches written
   * before it was recorded.
   */
  quality: number | null;
  /** Which page-turn strategy worked for this book, so later scans skip probing. */
  turnStrategy: string | null;
}

/** One captured page as persisted in chrome.storage.local. */
interface StoredPage {
  index: number;
  page: number | null;
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * The OCR result for one stored page, persisted beside it rather than inside it:
 * a page record is read back for the preview grid, where the words would be dead
 * weight, and OCR is added long after the page was captured.
 */
interface StoredOcr {
  index: number;
  /** Size of the page the boxes were measured on, so a mismatch is detectable. */
  width: number;
  height: number;
  words: OcrWord[];
  /** Mean word confidence, 0–100. Kept for display, not used when exporting. */
  confidence: number;
}

/**
 * A freshly encoded page, before it is persisted. It carries no identity: the
 * signature of the source pixels is computed before encoding, and hashing the
 * JPEG is only a fallback for a tainted canvas.
 */
interface CapturedPage {
  width: number;
  height: number;
  dataUrl: string;
}

/** A candidate page element together with the geometry used to order it. */
interface PageCandidate {
  element: PageElement;
  rect: DOMRect;
  area: number;
}

/** A rectangle of a source bitmap that should become one PDF page. */
interface Region {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** A region together with the hash of the pixels inside it. */
interface RegionView {
  region: Region;
  /** null when the source canvas is tainted and cannot be read back. */
  signature: string | null;
}

/** JPEG ready to be written into the PDF. */
interface PdfImage {
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** Sheet the pages are written on. 'native' keeps the capture's own aspect. */
type PaperName = 'a4' | 'letter' | 'native';

/** Where a captured bitmap sits on a PDF page, all in points. */
interface PageLayout {
  pageWidth: number;
  pageHeight: number;
  /** Bottom-left corner of the drawn image, in page space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One OCR word, in the pixel space of the stored page: x to the right, y down
 * from the top-left corner. Short keys because a book's worth of these is held
 * in chrome.storage and read back on every export.
 */
interface OcrWord {
  t: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /**
   * Baseline and em size taken from the line this word is on, when the
   * recogniser reported a usable line box. Both optional: without them the word
   * box alone has to do, which puts the glyphs a descender too low and sizes a
   * word of lowercase letters by its x-height.
   */
  b?: number;
  s?: number;
}

/** How to map OCR pixel coordinates onto a PDF page. */
interface TextPlacement {
  /** Points per source pixel. */
  scale: number;
  /** Page-space x of the image's left edge. */
  left: number;
  /** Page-space y of the image's bottom edge. */
  bottom: number;
  /** Height of the source bitmap in pixels, since OCR y counts from the top. */
  imageHeight: number;
}

interface PdfOptions {
  paper?: PaperName;
}

interface PdfBuilder {
  readonly pages: number;
  /** Pages that ended up carrying a text layer. */
  readonly textPages: number;
  addImage(image: PdfImage, words?: OcrWord[]): void;
  /** Coalesce buffered output into a Blob so it can leave the JS heap. */
  flush(): void;
  finish(): Blob;
}

interface ScanOptions {
  /** Base wait around a page turn, in milliseconds. */
  delay?: number;
  /**
   * 0–5. How much random extra time to add to each wait, so a scan does not
   * turn pages on a metronome. 0 keeps the base delay exactly.
   */
  jitter?: number;
  quality?: number;
  /**
   * Cut a landscape capture down the middle into two portrait pages. The reader
   * paints a two-column spread as one wide bitmap, so this gives one PDF page
   * per book page without having to change the reader's layout.
   */
  split?: boolean;
  /**
   * Sheet the PDF is written on. Unlike quality and split this is not pinned by
   * the first scan: it is applied when the export runs, so the same cache can be
   * saved as A4 today and Letter tomorrow.
   */
  paper?: PaperName;
}

/** What the popup shows about the reader and the cache for one book. */
interface BookState {
  bookId: string;
  /** False when the tab is on the reader but no book is rendered. */
  bookOpen: boolean;
  scanning: boolean;
  count: number;
  /** Total pages, only when the reader actually reports pages. */
  total: number | null;
  /** What the reader counts in. Location totals are not page counts. */
  kind: 'page' | 'location' | null;
  position: ReaderPosition | null;
  /** Captures whose image bytes are identical to another capture. */
  duplicates: number;
  /** Captures that already have an OCR text layer stored. */
  recognised: number;
  /**
   * What the cache has already committed to for the whole book. Null until the
   * first scan pins it, or for a cache written before it was recorded. The
   * popup shows these rather than the last values it was left set to.
   */
  split: boolean | null;
  quality: number | null;
}

type ReaderRequest =
  | { action: 'startScan'; options?: ScanOptions }
  | { action: 'retune'; options?: ScanOptions }
  | { action: 'stopScan' }
  | { action: 'getState' }
  | { action: 'saveCached'; paper?: PaperName }
  | { action: 'clearCached' };

type ReaderAction = ReaderRequest['action'];

interface ReaderMessage {
  message: string;
}

/** An action that failed before it could produce its normal reply. */
interface ReaderFailure {
  error: string;
}

/** Reply type for each action, so callers know what they get back. */
interface ReaderReplies {
  startScan: ReaderMessage;
  retune: ReaderMessage;
  stopScan: ReaderMessage;
  getState: BookState;
  saveCached: ReaderMessage;
  clearCached: ReaderMessage;
}
