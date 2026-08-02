// Ambient globals rather than exports: three independent bundles use these,
// none of them at runtime, and a declaration file emits nothing. The
// alternative is an `import type` line in every module for no benefit.

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

interface CaptureRecord {
  index: number;
  /** "page:124" or "location:4879", '' when the footer was hidden. */
  position: string;
  fingerprint: string;
  /** For display only — see ReaderPosition. */
  page: number | null;
}

interface BookMeta {
  version: 2;
  bookId: string;
  captures: CaptureRecord[];
  total: number | null;
  kind: 'page' | 'location' | null;
  split: boolean | null;
  /**
   * Fixed by the first scan so one book cannot end up holding pages encoded two
   * ways. Null here and in `split` means a cache written before the setting was
   * recorded, not a default.
   */
  quality: number | null;
  turnStrategy: string | null;
}

interface StoredPage {
  index: number;
  page: number | null;
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * Persisted beside the page rather than inside it: a page record is read back
 * for the preview grid, where the words would be dead weight, and OCR is added
 * long after the page was captured.
 */
interface StoredOcr {
  index: number;
  /** Size of the page the boxes were measured on, so a mismatch is detectable. */
  width: number;
  height: number;
  words: OcrWord[];
  /** Mean word confidence, 0–100. */
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

interface PageCandidate {
  element: PageElement;
  rect: DOMRect;
  area: number;
}

interface Region {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

interface RegionView {
  region: Region;
  /** null when the source canvas is tainted and cannot be read back. */
  signature: string | null;
}

interface PdfImage {
  width: number;
  height: number;
  bytes: Uint8Array;
}

/** 'native' keeps the capture's own aspect instead of a fixed sheet. */
type PaperName = 'a4' | 'letter' | 'native';

/** All in points. */
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
  readonly textPages: number;
  addImage(image: PdfImage, words?: OcrWord[]): void;
  /** Coalesce buffered output into a Blob so it can leave the JS heap. */
  flush(): void;
  finish(): Blob;
}

interface ScanOptions {
  /** Base wait around a page turn, in milliseconds. */
  delay?: number;
  /** 0–5. Random extra time added to each wait; 0 keeps the base delay exactly. */
  jitter?: number;
  quality?: number;
  /**
   * Cut a landscape capture down the middle into two portrait pages. The reader
   * paints a two-column spread as one wide bitmap, so this gives one PDF page
   * per book page without having to change the reader's layout.
   */
  split?: boolean;
}

interface BookState {
  bookId: string;
  /** False when the tab is on the reader but no book is rendered. */
  bookOpen: boolean;
  scanning: boolean;
  count: number;
  /** Only when the reader actually counts in pages — see `kind`. */
  total: number | null;
  kind: 'page' | 'location' | null;
  position: ReaderPosition | null;
  duplicates: number;
  recognised: number;
  /**
   * What the cache has already committed to for the whole book. The popup shows
   * these rather than the last values it was left set to.
   */
  split: boolean | null;
  quality: number | null;
}

type ReaderRequest =
  | { action: 'startScan'; options?: ScanOptions }
  | { action: 'retune'; options?: ScanOptions }
  | { action: 'stopScan' }
  | { action: 'getState' };

type ReaderAction = ReaderRequest['action'];

interface ReaderMessage {
  message: string;
}

interface ReaderFailure {
  error: string;
}

interface ReaderReplies {
  startScan: ReaderMessage;
  retune: ReaderMessage;
  stopScan: ReaderMessage;
  getState: BookState;
}
