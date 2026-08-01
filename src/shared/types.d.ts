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

interface PdfBuilder {
  readonly pages: number;
  addImage(image: PdfImage): void;
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
  /** True when the rendered view is landscape, i.e. a two-column spread. */
  wideView: boolean;
}

type ReaderRequest =
  | { action: 'startScan'; options?: ScanOptions }
  | { action: 'stopScan' }
  | { action: 'getState' }
  | { action: 'saveCached' }
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
  stopScan: ReaderMessage;
  getState: BookState;
  saveCached: ReaderMessage;
  clearCached: ReaderMessage;
}
