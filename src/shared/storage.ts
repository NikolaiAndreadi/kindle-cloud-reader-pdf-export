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

export async function clearBook(book: string): Promise<number> {
  const local = chrome.storage.local;
  // getKeys landed after the extension's minimum Chrome version. get(null) is
  // the compatible fallback; clearing is deliberately the only path that may
  // enumerate storage so interrupted, unindexed page writes can be removed.
  const allKeys = typeof local.getKeys === 'function'
    ? await local.getKeys()
    : Object.keys(await local.get(null));
  const prefix = `book:${book}:page:`;
  const pages = allKeys.filter((key) => key.startsWith(prefix));
  await local.remove([metaKey(book), ...pages]);
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
