import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  clearBook, countDuplicates, deleteCapture, emptyMeta, fingerprintCounts, loadMeta, loadOcrBatch,
  loadPaper, metaKey, nextIndex, ocrKey, ocrKeyParts, pageKey, pagesInBatches, recognisedIndexes,
  reorderCaptures, saveMeta, savePaper, storeOcr, storePage
} from '../../src/shared/storage.ts';

/** Just enough of chrome.storage.local to exercise the module. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  const local = {
    get: async (keys: string | string[] | null) => {
      if (keys === null) return Object.fromEntries(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(
        list.filter((key) => data.has(key)).map((key) => [key, data.get(key)])
      );
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    getKeys: async () => [...data.keys()],
    remove: async (keys: string[]) => {
      for (const key of keys) data.delete(key);
    }
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
  return data;
}

const capture = (index: number, fingerprint = `fp-${index}`): CaptureRecord =>
  ({ index, position: '', fingerprint, page: null });

const image = (): CapturedPage => ({ width: 800, height: 1200, dataUrl: 'data:image/jpeg;base64,AA==' });

const ocr = (index: number, words = 1): StoredOcr => ({
  index,
  width: 800,
  height: 1200,
  words: Array.from({ length: words }, (_, i) => ({ t: `w${i}`, x0: i, y0: 0, x1: i + 5, y1: 10 })),
  confidence: 90
});

let data: Map<string, unknown>;
beforeEach(() => {
  data = fakeStorage();
});

describe('keys', () => {
  it('namespaces by book so two books never collide', () => {
    assert.notEqual(pageKey('B001', 1), pageKey('B002', 1));
    assert.notEqual(metaKey('B001'), metaKey('B002'));
  });

  it('zero-pads the index so keys sort in capture order', () => {
    const keys = [pageKey('B', 2), pageKey('B', 10), pageKey('B', 1)].sort();
    assert.deepEqual(keys, [pageKey('B', 1), pageKey('B', 2), pageKey('B', 10)]);
  });
});

describe('nextIndex', () => {
  it('starts at 1 for an empty book', () => {
    assert.equal(nextIndex(emptyMeta('B')), 1);
  });

  it('continues past the highest index, so resuming never overwrites', () => {
    const meta = { ...emptyMeta('B'), captures: [capture(1), capture(7), capture(3)] };
    assert.equal(nextIndex(meta), 8);
  });
});

describe('countDuplicates', () => {
  it('counts repeats, not distinct values', () => {
    const captures = [capture(1, 'a'), capture(2, 'a'), capture(3, 'a'), capture(4, 'b')];
    assert.equal(countDuplicates(captures), 2);
  });

  it('ignores captures with no fingerprint', () => {
    assert.equal(countDuplicates([capture(1, ''), capture(2, '')]), 0);
  });
});

describe('fingerprintCounts', () => {
  it('reports how many times each fingerprint occurs', () => {
    const counts = fingerprintCounts([capture(1, 'a'), capture(2, 'a'), capture(3, 'b')]);
    assert.equal(counts.get('a'), 2);
    assert.equal(counts.get('b'), 1);
  });
});

describe('loadMeta', () => {
  it('returns an empty index for a book never scanned', async () => {
    assert.deepEqual(await loadMeta('B001'), emptyMeta('B001'));
  });

  it('round-trips a saved index', async () => {
    const meta = { ...emptyMeta('B001'), captures: [capture(1)], total: 40, kind: 'page' as const };
    await saveMeta(meta);
    assert.deepEqual(await loadMeta('B001'), meta);
  });

  it('discards a record of the wrong version rather than trusting it', async () => {
    data.set(metaKey('B001'), { version: 1, pages: [1, 2, 3], total: 3 });
    assert.deepEqual(await loadMeta('B001'), emptyMeta('B001'));
  });

  it('discards a record whose captures are not an array', async () => {
    data.set(metaKey('B001'), { version: 2, bookId: 'B001', captures: null });
    assert.deepEqual(await loadMeta('B001'), emptyMeta('B001'));
  });
});

describe('storePage', () => {
  it('writes the page but leaves the index unpersisted until it is flushed', async () => {
    const meta = emptyMeta('B001');
    await storePage(meta, capture(1), image());
    assert.equal(meta.captures.length, 1);
    assert.ok(data.has(pageKey('B001', 1)));
    assert.equal(data.has(metaKey('B001')), false);

    await saveMeta(meta);
    assert.equal((await loadMeta('B001')).captures.length, 1);
  });

  it('keeps capture order without sorting', async () => {
    const meta = emptyMeta('B001');
    for (const index of [1, 2, 3]) await storePage(meta, capture(index), image());
    assert.deepEqual(meta.captures.map((c) => c.index), [1, 2, 3]);
  });

  it('stores the dimensions the PDF writer needs', async () => {
    const meta = emptyMeta('B001');
    await storePage(meta, capture(1), image());
    const stored = data.get(pageKey('B001', 1)) as StoredPage;
    assert.equal(stored.width, 800);
    assert.equal(stored.height, 1200);
  });
});

describe('OCR records', () => {
  it('keys by book and capture, apart from the page itself', () => {
    assert.notEqual(ocrKey('B001', 1, 'fp'), ocrKey('B002', 1, 'fp'));
    assert.notEqual(ocrKey('B001', 1, 'fp'), pageKey('B001', 1));
  });

  it('keys by capture identity, so one index can hold two different captures', () => {
    assert.notEqual(ocrKey('B001', 1, 'fp-a'), ocrKey('B001', 1, 'fp-b'));
  });

  it('reads back the words for the captures asked for', async () => {
    await storeOcr('B001', capture(1), ocr(1, 2));
    await storeOcr('B001', capture(3), ocr(3, 1));

    const found = await loadOcrBatch('B001', [capture(1), capture(2), capture(3)]);
    assert.deepEqual([...found.keys()], [1, 3]);
    assert.equal(found.get(1)!.words.length, 2);
    assert.equal(found.get(2), undefined);
  });

  it('counts a page with no words as recognised, so it is not tried forever', async () => {
    await storeOcr('B001', capture(1), ocr(1, 0));
    const found = await loadOcrBatch('B001', [capture(1)]);
    assert.deepEqual(found.get(1)!.words, []);
    assert.deepEqual(
      [...await recognisedIndexes('B001', [capture(1)])], [1]
    );
  });

  it('reports which captures have a text layer, ignoring other books', async () => {
    await storeOcr('B001', capture(2), ocr(2));
    await storeOcr('B002', capture(1), ocr(1));

    const found = await recognisedIndexes('B001', [capture(1), capture(2), capture(3)]);
    assert.deepEqual([...found].sort(), [2]);
  });

  it('ignores an OCR record whose capture is no longer in the index', async () => {
    await storeOcr('B001', capture(9), ocr(9));
    assert.equal((await recognisedIndexes('B001', [capture(1)])).size, 0);
  });

  /**
   * The whole reason identity is in the key. Deleting the newest capture frees
   * its index, the next scan hands that index to a different page, and every page
   * of a book is the same size — so a record found by index alone would be drawn
   * onto a page it was never read from.
   */
  it('does not hand a reused index the words of the capture it replaced', async () => {
    const old = capture(4, 'fp-old');
    await storeOcr('B001', old, ocr(4));
    assert.equal((await loadOcrBatch('B001', [old])).size, 1);

    const reused = capture(4, 'fp-new');
    assert.equal((await loadOcrBatch('B001', [reused])).size, 0);
    assert.equal((await recognisedIndexes('B001', [reused])).size, 0);
  });

  it('does not count a stale record on the getKeys-less path either', async () => {
    await storeOcr('B001', capture(4, 'fp-old'), ocr(4));
    const local = (globalThis as { chrome: { storage: { local: { getKeys?: unknown } } } })
      .chrome.storage.local;
    const original = local.getKeys;
    local.getKeys = undefined;
    try {
      assert.equal((await recognisedIndexes('B001', [capture(4, 'fp-new')])).size, 0);
    } finally {
      local.getKeys = original;
    }
  });

  it('counts by key when getKeys is missing, which is the older-Chrome path', async () => {
    await storeOcr('B001', capture(2), ocr(2));
    const local = (globalThis as { chrome: { storage: { local: { getKeys?: unknown } } } })
      .chrome.storage.local;
    const original = local.getKeys;
    local.getKeys = undefined;
    try {
      // Batch size 1, so the fallback has to stitch several reads together.
      const found = await recognisedIndexes('B001', [capture(1), capture(2)], 1);
      assert.deepEqual([...found], [2]);
    } finally {
      local.getKeys = original;
    }
  });

  it('reads the index and fingerprint back out of a key', () => {
    assert.deepEqual(ocrKeyParts('B001', ocrKey('B001', 42, 'fp-x')), {
      index: 42, fingerprint: 'fp-x'
    });
    assert.equal(ocrKeyParts('B001', pageKey('B001', 42)), null);
    assert.equal(ocrKeyParts('B001', ocrKey('B002', 42, 'fp')), null);
    assert.equal(ocrKeyParts('B001', metaKey('B001')), null);
    // A key from before identity was part of it has no fingerprint field.
    assert.equal(ocrKeyParts('B001', 'book:B001:ocr:000042'), null);
  });
});

describe('pagesInBatches', () => {
  it('yields every capture, in order, across batch boundaries', async () => {
    const meta = emptyMeta('B001');
    for (let i = 1; i <= 7; i++) await storePage(meta, capture(i), image());

    const seen: number[] = [];
    const sizes: number[] = [];
    for await (const batch of pagesInBatches('B001', meta.captures, 3)) {
      sizes.push(batch.length);
      seen.push(...batch.map(({ capture: c }) => c.index));
    }
    assert.deepEqual(sizes, [3, 3, 1]);
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
  });

  it('reports a capture whose page went missing as undefined rather than skipping it', async () => {
    const meta = emptyMeta('B001');
    for (const i of [1, 2]) await storePage(meta, capture(i), image());
    data.delete(pageKey('B001', 1));

    const rows = [];
    for await (const batch of pagesInBatches('B001', meta.captures, 10)) rows.push(...batch);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.page, undefined);
    assert.ok(rows[1]!.page);
  });

  it('yields nothing for a book with no captures', async () => {
    let batches = 0;
    for await (const _ of pagesInBatches('B001', [])) batches += 1;
    assert.equal(batches, 0);
  });
});

/** A book with `count` stored pages, indexed and flushed. */
async function seed(book: string, count: number): Promise<BookMeta> {
  const meta = { ...emptyMeta(book), total: 40 };
  for (let i = 1; i <= count; i++) await storePage(meta, capture(i), image());
  await saveMeta(meta);
  return meta;
}

const order = (meta: BookMeta): number[] => meta.captures.map((c) => c.index);

describe('reorderCaptures', () => {
  it('rewrites export order without touching the storage keys', async () => {
    await seed('B001', 3);
    const meta = await reorderCaptures('B001', [3, 1, 2]);

    assert.deepEqual(order(meta), [3, 1, 2]);
    assert.deepEqual(order(await loadMeta('B001')), [3, 1, 2]);
    for (const i of [1, 2, 3]) assert.ok(data.has(pageKey('B001', i)));
  });

  it('keeps the rest of the index intact', async () => {
    await seed('B001', 2);
    const meta = await reorderCaptures('B001', [2, 1]);
    assert.equal(meta.total, 40);
    assert.equal(meta.captures[0]!.fingerprint, 'fp-2');
  });

  it('appends captures the caller never saw, so a scan mid-edit loses nothing', async () => {
    await seed('B001', 4);
    // The caller was showing only the first three when it reordered them.
    const meta = await reorderCaptures('B001', [3, 1, 2]);
    assert.deepEqual(order(meta), [3, 1, 2, 4]);
  });

  it('ignores indexes that are no longer cached', async () => {
    await seed('B001', 2);
    assert.deepEqual(order(await reorderCaptures('B001', [2, 99, 1])), [2, 1]);
  });
});

describe('deleteCapture', () => {
  it('drops the record and the page it points at', async () => {
    await seed('B001', 3);
    const meta = await deleteCapture('B001', 2);

    assert.deepEqual(order(meta), [1, 3]);
    assert.deepEqual(order(await loadMeta('B001')), [1, 3]);
    assert.equal(data.has(pageKey('B001', 2)), false);
    assert.ok(data.has(pageKey('B001', 1)));
    assert.ok(data.has(pageKey('B001', 3)));
  });

  it('takes the text layer with the page, not leaving words behind', async () => {
    await seed('B001', 2);
    await storeOcr('B001', capture(1), ocr(1));
    await storeOcr('B001', capture(2), ocr(2));

    await deleteCapture('B001', 1);
    assert.equal(data.has(ocrKey('B001', 1, 'fp-1')), false);
    assert.ok(data.has(ocrKey('B001', 2, 'fp-2')));
  });

  it('leaves the index unchanged when the capture is already gone', async () => {
    await seed('B001', 2);
    assert.deepEqual(order(await deleteCapture('B001', 9)), [1, 2]);
  });

  it('lets the freed index be written again rather than reusing a stale page', async () => {
    await seed('B001', 3);
    const meta = await deleteCapture('B001', 3);
    assert.equal(nextIndex(meta), 3);
    assert.equal(data.has(pageKey('B001', 3)), false);
  });
});

describe('clearBook', () => {
  it('removes every page and the index, and reports the count', async () => {
    const meta = emptyMeta('B001');
    for (const i of [1, 2, 3]) await storePage(meta, capture(i), image());
    await saveMeta(meta);

    assert.equal(await clearBook('B001'), 3);
    assert.equal(data.size, 0);
  });

  it('removes the text layers too, and still counts only pages', async () => {
    const meta = emptyMeta('B001');
    for (const i of [1, 2]) await storePage(meta, capture(i), image());
    await saveMeta(meta);
    for (const i of [1, 2]) await storeOcr('B001', capture(i), ocr(i));

    assert.equal(await clearBook('B001'), 2);
    assert.equal(data.size, 0);
  });

  it('leaves another book untouched', async () => {
    const a = emptyMeta('B001');
    await storePage(a, capture(1), image());
    await saveMeta(a);
    const b = emptyMeta('B002');
    await storePage(b, capture(1), image());
    await saveMeta(b);

    await clearBook('B001');
    assert.equal((await loadMeta('B002')).captures.length, 1);
  });

  it('removes page writes that were not flushed into the metadata index', async () => {
    const meta = emptyMeta('B001');
    await storePage(meta, capture(1), image());

    assert.equal(data.has(metaKey('B001')), false);
    assert.equal(await clearBook('B001'), 1);
    assert.equal(data.has(pageKey('B001', 1)), false);
  });
});

describe('paper size', () => {
  it('defaults to A4 with nothing stored', async () => {
    assert.equal(await loadPaper(), 'a4');
  });

  it('reads back what was saved', async () => {
    await savePaper('letter');
    assert.equal(await loadPaper(), 'letter');
  });

  it('ignores a size no writer knows', async () => {
    data.set('paper', 'foolscap');
    assert.equal(await loadPaper(), 'a4');
  });

  /**
   * The select used to live in the popup, which kept it inside the scan
   * options. That blob is rewritten on every slider change and no longer
   * carries a paper size, so the old choice has to be moved rather than read
   * where it lies.
   */
  it('takes the choice a previous version left in the scan options', async () => {
    data.set('options', { delay: 1100, jitter: 2, paper: 'native' });
    assert.equal(await loadPaper(), 'native');
    assert.equal(data.get('paper'), 'native');
  });

  it('prefers its own key over the one it migrated from', async () => {
    data.set('options', { paper: 'native' });
    await savePaper('letter');
    assert.equal(await loadPaper(), 'letter');
  });

  it('falls back to A4 when the old options carry no size', async () => {
    data.set('options', { delay: 1100 });
    assert.equal(await loadPaper(), 'a4');
    assert.equal(data.has('paper'), false);
  });
});
