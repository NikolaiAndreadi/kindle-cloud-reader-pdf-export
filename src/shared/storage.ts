// Everything that knows the shape of chrome.storage.local lives here. The
// content script and the preview page previously carried their own copies of
// the key format and the duplicate count, so changing either one silently broke
// the other.

export const READ_BATCH = 20;

/**
 * How many captures may be written before the index is flushed. The index has
 * to hold every capture (chrome.storage has no key-listing API), so writing it
 * per page re-serialises a growing array on every page — O(n²) over a scan. The
 * cost of batching is that a tab killed mid-scan orphans up to this many page
 * records, which is why it is small.
 */
export const META_FLUSH_EVERY = 10;

export const metaKey = (book: string): string => `book:${book}:meta`;

export const pageKey = (book: string, index: number): string =>
  `book:${book}:page:${String(index).padStart(6, '0')}`;

/**
 * OCR records are keyed by capture *identity*, not by index alone.
 *
 * An index is not unique over time: nextIndex only moves past the highest one
 * still present, so deleting the newest capture frees its index for the next
 * scan. A page written to a reused index overwrites the old page, but nothing
 * overwrites an OCR record — and every page of a book shares one bitmap size, so
 * the dimension check in the exporter would wave the old words through onto the
 * new page. With the fingerprint in the key, a record belonging to a capture that
 * no longer exists is simply never found again, by any caller.
 */
export const ocrKey = (book: string, index: number, fingerprint: string): string =>
  `book:${book}:ocr:${String(index).padStart(6, '0')}:${fingerprint}`;

export const ocrKeyFor = (book: string, capture: CaptureRecord): string =>
  ocrKey(book, capture.index, capture.fingerprint);

export const emptyMeta = (book: string): BookMeta => ({
  version: 2,
  bookId: book,
  captures: [],
  total: null,
  kind: null,
  split: null,
  quality: null,
  turnStrategy: null
});

export async function loadMeta(book: string): Promise<BookMeta> {
  const key = metaKey(book);
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key] as BookMeta | undefined;
  if (raw?.version === 2 && Array.isArray(raw.captures)) {
    // Caches written before split mode was recorded remain readable/exportable,
    // but scan.ts will not append to them without knowing their page layout.
    return {
      ...raw,
      split: typeof raw.split === 'boolean' ? raw.split : null,
      quality: typeof raw.quality === 'number' ? raw.quality : null
    };
  }
  return emptyMeta(book);
}

export const saveMeta = (meta: BookMeta): Promise<void> =>
  chrome.storage.local.set({ [metaKey(meta.bookId)]: meta });

export const nextIndex = (meta: BookMeta): number =>
  meta.captures.reduce((highest, capture) => Math.max(highest, capture.index), 0) + 1;

/**
 * Write one page and record it in the in-memory index. The index is not
 * persisted here — the caller decides when to flush it, see META_FLUSH_EVERY.
 */
export async function storePage(
  meta: BookMeta, record: CaptureRecord, image: CapturedPage
): Promise<void> {
  // No sort: index is handed out monotonically, so pushing keeps capture order.
  meta.captures.push(record);
  const page: StoredPage = {
    index: record.index,
    page: record.page,
    width: image.width,
    height: image.height,
    dataUrl: image.dataUrl
  };
  await chrome.storage.local.set({ [pageKey(meta.bookId, record.index)]: page });
}

/**
 * Stored pages for the given captures, a batch at a time. Both the PDF writer
 * and the preview grid consume this; neither can afford every data URL at once.
 */
export async function* pagesInBatches(
  book: string, captures: CaptureRecord[], size = READ_BATCH
): AsyncGenerator<{ capture: CaptureRecord; page: StoredPage | undefined }[]> {
  for (let start = 0; start < captures.length; start += size) {
    const batch = captures.slice(start, start + size);
    const stored = await chrome.storage.local.get(batch.map((c) => pageKey(book, c.index)));
    yield batch.map((capture) => ({
      capture,
      page: stored[pageKey(book, capture.index)] as StoredPage | undefined
    }));
  }
}

/**
 * Store the words for one capture. The capture is passed whole rather than as an
 * index because its fingerprint is half of the key — see ocrKey.
 */
export const storeOcr = (
  book: string, capture: CaptureRecord, result: StoredOcr
): Promise<void> => chrome.storage.local.set({ [ocrKeyFor(book, capture)]: result });

/**
 * The OCR records for a batch of captures, keyed by capture index. Absent
 * entries simply do not appear: a page that has not been recognised yet is
 * exported as an image, which is what the whole cache was before OCR existed.
 */
export async function loadOcrBatch(
  book: string, captures: CaptureRecord[]
): Promise<Map<number, StoredOcr>> {
  const stored = await chrome.storage.local.get(captures.map((c) => ocrKeyFor(book, c)));
  const found = new Map<number, StoredOcr>();
  for (const capture of captures) {
    const record = stored[ocrKeyFor(book, capture)] as StoredOcr | undefined;
    // An empty word list counts as recognised: a plate or a chapter break has no
    // words, and treating that as "not done yet" would re-run it every time.
    if (Array.isArray(record?.words)) found.set(capture.index, record);
  }
  return found;
}

/** Index and fingerprint out of an OCR key, or null if the key is not one. */
export function ocrKeyParts(
  book: string, key: string
): { index: number; fingerprint: string } | null {
  const prefix = `book:${book}:ocr:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const split = rest.indexOf(':');
  if (split < 0) return null;
  const index = Number(rest.slice(0, split));
  if (!Number.isInteger(index) || index <= 0) return null;
  return { index, fingerprint: rest.slice(split + 1) };
}

/**
 * Which of these captures already have a text layer.
 *
 * Asked on every popup poll and on every preview refresh, so it goes by key
 * rather than by value where it can: reading the records themselves to count
 * them would pull tens of megabytes of words through for a number. The key
 * carries the fingerprint, so identity is checked without reading anything —
 * a record left behind by a deleted capture is not counted as that capture's.
 */
export async function recognisedIndexes(
  book: string, captures: CaptureRecord[], size = READ_BATCH
): Promise<Set<number>> {
  const wanted = new Set(captures.map((capture) => `${capture.index}:${capture.fingerprint}`));
  const found = new Set<number>();
  const local = chrome.storage.local;

  // getKeys landed after the extension's minimum Chrome version; the fallback
  // pays for the values because there is no other way to ask.
  if (typeof local.getKeys === 'function') {
    for (const key of await local.getKeys()) {
      const parts = ocrKeyParts(book, key);
      if (parts && wanted.has(`${parts.index}:${parts.fingerprint}`)) found.add(parts.index);
    }
    return found;
  }

  for (let start = 0; start < captures.length; start += size) {
    for (const index of (await loadOcrBatch(book, captures.slice(start, start + size))).keys()) {
      found.add(index);
    }
  }
  return found;
}

/**
 * Rewrite the capture order for a book. `order` lists capture indexes in the
 * order they should be exported; the index of a record never changes, because
 * it is the storage key of the page it points at.
 *
 * The stored index is re-read rather than taking the caller's copy: a scan
 * running in another tab may have appended pages since the caller loaded it,
 * and those keep their place at the end instead of being dropped. Nothing here
 * can protect an edit made *while* a scan is running — that scan holds the
 * index in memory and its next flush wins.
 */
export async function reorderCaptures(book: string, order: number[]): Promise<BookMeta> {
  const meta = await loadMeta(book);
  const remaining = new Map(meta.captures.map((capture) => [capture.index, capture]));
  const ordered: CaptureRecord[] = [];
  for (const index of order) {
    const capture = remaining.get(index);
    if (!capture) continue;
    ordered.push(capture);
    remaining.delete(index);
  }
  // A Map iterates in insertion order, so anything the caller did not name is
  // appended still in capture order.
  meta.captures = [...ordered, ...remaining.values()];
  await saveMeta(meta);
  return meta;
}

/**
 * Drop one capture, the page it points at, and its text layer. The index is
 * freed and may be handed out again: nextIndex only ever moves past the highest
 * one still present, so deleting the newest capture and scanning again writes to
 * that key afresh. Which is why OCR records are keyed by fingerprint too — see
 * ocrKey — and why this sweeps every record at the index rather than only the one
 * it can name. An OCR run in another tab may still be holding this capture and
 * store its words after this returns; that record is then unreachable, and the
 * next sweep or clearBook collects it.
 */
export async function deleteCapture(book: string, index: number): Promise<BookMeta> {
  const local = chrome.storage.local;
  const meta = await loadMeta(book);
  meta.captures = meta.captures.filter((capture) => capture.index !== index);
  // Index first: a failure after this leaves an unreferenced page, which
  // clearBook sweeps, rather than an index pointing at nothing.
  await saveMeta(meta);

  const stale = typeof local.getKeys === 'function'
    ? (await local.getKeys()).filter((key) => ocrKeyParts(book, key)?.index === index)
    : [];
  await local.remove([pageKey(book, index), ...stale]);
  return meta;
}

export async function clearBook(book: string): Promise<number> {
  const local = chrome.storage.local;
  // getKeys landed after the extension's minimum Chrome version. get(null) is
  // the compatible fallback; clearing is deliberately the only path that may
  // enumerate storage so interrupted, unindexed page writes can be removed.
  const allKeys = typeof local.getKeys === 'function'
    ? await local.getKeys()
    : Object.keys(await local.get(null));
  const pagePrefix = `book:${book}:page:`;
  const ocrPrefix = `book:${book}:ocr:`;
  const pages = allKeys.filter((key) => key.startsWith(pagePrefix));
  const ocr = allKeys.filter((key) => key.startsWith(ocrPrefix));
  await local.remove([metaKey(book), ...pages, ...ocr]);
  // Pages, not records: the count is reported as pages cleared, and a page and
  // its text layer are one thing to anyone reading that number.
  return pages.length;
}

export function countDuplicates(captures: CaptureRecord[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const capture of captures) {
    if (!capture.fingerprint) continue;
    if (seen.has(capture.fingerprint)) duplicates += 1;
    seen.add(capture.fingerprint);
  }
  return duplicates;
}

export function fingerprintCounts(captures: CaptureRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const capture of captures) {
    if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
  }
  return counts;
}
