import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { type Recogniser, type PageWords } from '../../src/ocr/engine.ts';
import { runOcr } from '../../src/ocr/run.ts';
import {
  emptyMeta, loadOcrBatch, ocrKey, recognisedIndexes, saveMeta, storePage
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

const image = (): CapturedPage =>
  ({ width: 800, height: 1200, dataUrl: 'data:image/jpeg;base64,AA==' });

/** Write `count` captures with their pages, and persist the index. */
async function seed(book: string, count: number): Promise<BookMeta> {
  const meta = emptyMeta(book);
  for (let i = 1; i <= count; i++) await storePage(meta, capture(i), image());
  await saveMeta(meta);
  return meta;
}

/** A recogniser that returns one word per page and counts what it was asked. */
function fakeRecogniser(onPage?: () => Promise<void> | void) {
  const seen: string[] = [];
  let closed = false;
  const recogniser: Recogniser = {
    async page(dataUrl: string, width: number): Promise<PageWords> {
      seen.push(`${dataUrl.slice(-4)}@${width}`);
      await onPage?.();
      return { words: [{ t: 'word', x0: 0, y0: 0, x1: 10, y1: 10 }], confidence: 90 };
    },
    async close(): Promise<void> {
      closed = true;
    }
  };
  let opened = 0;
  return {
    seen,
    get closed() { return closed; },
    get opened() { return opened; },
    open: async () => {
      opened += 1;
      return recogniser;
    }
  };
}

beforeEach(() => {
  fakeStorage();
});

const silent = { onProgress: (): void => {}, shouldStop: (): boolean => false };

describe('runOcr', () => {
  it('recognises every capture that has no text layer, then closes the engine', async () => {
    await seed('B001', 3);
    const engine = fakeRecogniser();

    const result = await runOcr('B001', { ...silent, open: engine.open });

    assert.deepEqual(result, { recognised: 3, skipped: 0, stopped: false });
    assert.equal(engine.seen.length, 3);
    assert.equal(engine.closed, true);
    assert.deepEqual(
      [...await recognisedIndexes('B001', [capture(1), capture(2), capture(3)])], [1, 2, 3]
    );
  });

  it('stores the words under the capture identity, not the index alone', async () => {
    await seed('B001', 1);
    await runOcr('B001', { ...silent, open: fakeRecogniser().open });

    const found = await loadOcrBatch('B001', [capture(1)]);
    assert.equal(found.get(1)!.words.length, 1);
    // The same index with another fingerprint is a different page, and unread.
    assert.equal((await loadOcrBatch('B001', [capture(1, 'other')])).size, 0);
  });

  it('skips the pages it has already done, so a second run costs nothing', async () => {
    await seed('B001', 2);
    await runOcr('B001', { ...silent, open: fakeRecogniser().open });

    const again = fakeRecogniser();
    const result = await runOcr('B001', { ...silent, open: again.open });
    assert.deepEqual(result, { recognised: 0, skipped: 0, stopped: false });
    // Not even started: nothing to do should not pay for loading the engine.
    assert.equal(again.opened, 0);
  });

  /** The comment in runOcr promises this; it used to snapshot the index once. */
  it('picks up captures a scan appended while it was working', async () => {
    const meta = await seed('B001', 1);
    let appended = false;
    const engine = fakeRecogniser(async () => {
      if (appended) return;
      appended = true;
      // What a scan in the reader tab does: another page, then a flushed index.
      await storePage(meta, capture(2), image());
      await saveMeta(meta);
    });

    const result = await runOcr('B001', { ...silent, open: engine.open });

    assert.equal(result.recognised, 2);
    assert.equal(engine.opened, 1, 'the engine is loaded once for the whole run');
    assert.deepEqual([...await recognisedIndexes('B001', meta.captures)], [1, 2]);
  });

  it('tries a capture whose page is missing once, rather than for ever', async () => {
    const meta = await seed('B001', 2);
    // A page write that was interrupted: indexed, but no image behind it.
    (globalThis as { chrome: { storage: { local: { remove(keys: string[]): Promise<void> } } } })
      .chrome.storage.local.remove([`book:B001:page:${String(1).padStart(6, '0')}`]);

    const engine = fakeRecogniser();
    const result = await runOcr('B001', { ...silent, open: engine.open });

    assert.equal(result.skipped, 1);
    assert.equal(result.recognised, 1);
    assert.equal(engine.seen.length, 1);
    // Nothing was stored for it, so only `attempted` can be keeping the loop out.
    assert.equal((await recognisedIndexes('B001', meta.captures)).has(1), false);
  });

  it('stops between pages and leaves the rest for the next run', async () => {
    await seed('B001', 4);
    const engine = fakeRecogniser();
    let done = 0;

    const result = await runOcr('B001', {
      onProgress: (progress) => {
        if (progress.index !== undefined) done += 1;
      },
      shouldStop: () => done >= 2,
      open: engine.open
    });

    assert.equal(result.stopped, true);
    assert.equal(result.recognised, 2);
    assert.equal(engine.closed, true, 'the engine is closed even on a stop');

    const rest = fakeRecogniser();
    const second = await runOcr('B001', { ...silent, open: rest.open });
    assert.equal(second.recognised, 2);
  });

  it('reports a total that counts the pages taken on mid-run', async () => {
    const meta = await seed('B001', 1);
    let appended = false;
    const engine = fakeRecogniser(async () => {
      if (appended) return;
      appended = true;
      await storePage(meta, capture(2), image());
      await saveMeta(meta);
    });

    const totals: string[] = [];
    await runOcr('B001', {
      onProgress: (progress) => {
        if (progress.index !== undefined) totals.push(`${progress.done}/${progress.total}`);
      },
      shouldStop: () => false,
      open: engine.open
    });

    // The first round only knew of one page; the second counts both.
    assert.deepEqual(totals, ['1/1', '2/2']);
  });

  it('closes the engine even when a page throws', async () => {
    await seed('B001', 1);
    const engine = fakeRecogniser(() => {
      throw new Error('wasm fell over');
    });

    await assert.rejects(
      runOcr('B001', { ...silent, open: engine.open }), /wasm fell over/
    );
    assert.equal(engine.closed, true);
  });

  it('leaves no record behind for a capture it never finished', async () => {
    await seed('B001', 1);
    const engine = fakeRecogniser(() => {
      throw new Error('nope');
    });
    await assert.rejects(runOcr('B001', { ...silent, open: engine.open }));
    assert.equal((await loadOcrBatch('B001', [capture(1)])).size, 0);
    assert.equal((await recognisedIndexes('B001', [capture(1)])).size, 0);
    assert.equal(ocrKey('B001', 1, 'fp-1').includes('fp-1'), true);
  });
});
