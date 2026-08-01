import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { PageWords, Recogniser } from '../../src/ocr/engine.ts';
import { LANES, runOcr } from '../../src/ocr/run.ts';
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

/**
 * A recogniser that returns one word per page and counts what it was asked. Every
 * lane gets the same object, so `seen` is every page the run read, by any lane.
 */
function fakeRecogniser(onPage?: () => Promise<void> | void) {
  const seen: string[] = [];
  let closed = false;
  let inFlight = 0;
  let mostInFlight = 0;
  const recogniser: Recogniser = {
    async page(dataUrl: string, width: number): Promise<PageWords> {
      seen.push(`${dataUrl.slice(-4)}@${width}`);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        await onPage?.();
      } finally {
        inFlight -= 1;
      }
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
    /** The most pages being read at the same moment. */
    get mostInFlight() { return mostInFlight; },
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
    assert.equal(engine.opened, LANES, 'the lanes are loaded once for the whole run');
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
    const pages = LANES * 4;
    await seed('B001', pages);
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
    // Not exactly 2: every lane finishes the page it holds, so a stop asked for
    // after the second page can land up to one page per lane later. What matters
    // is that it landed early and that nothing was lost.
    assert.ok(result.recognised >= 2 && result.recognised < pages, `${result.recognised} pages`);
    assert.equal(engine.closed, true, 'the engine is closed even on a stop');

    const rest = fakeRecogniser();
    const second = await runOcr('B001', { ...silent, open: rest.open });
    assert.equal(
      result.recognised + second.recognised, pages, 'every page read exactly once across the two'
    );
  });

  it('reads a page in every lane at once, and each page only once', async () => {
    const pages = LANES * 3;
    await seed('B001', pages);
    // Each page blocks until there are as many in flight as there are lanes, so
    // this cannot pass on the luck of the microtask ordering. Divisible by LANES,
    // or the last round would wait for a page that is never taken on.
    let waiting: (() => void)[] = [];
    const engine = fakeRecogniser(() => new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length < LANES) return;
      const round = waiting;
      waiting = [];
      for (const release of round) release();
    }));

    const result = await runOcr('B001', { ...silent, open: engine.open });

    assert.equal(result.recognised, pages);
    assert.equal(engine.mostInFlight, LANES);
    assert.equal(engine.seen.length, pages, 'no page was handed to two lanes');
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

  it('stops reporting what the engine is doing once it has loaded', async () => {
    await seed('B001', 2);
    let logger: ((status: string) => void) | undefined;
    // What tesseract.js does on every page: the logger the worker was made with
    // fires with 'recognizing text', which would otherwise land on top of the
    // page count for the whole run.
    const engine = fakeRecogniser(() => logger?.('recognizing text'));
    const open = async (onLoad: (status: string) => void): Promise<Recogniser> => {
      // Lane 0's, the only one whose messages are passed on.
      logger ??= onLoad;
      onLoad('loading language traineddata');
      return engine.open();
    };

    const statuses: string[] = [];
    await runOcr('B001', {
      onProgress: (progress) => {
        if (progress.status) statuses.push(progress.status);
      },
      shouldStop: () => false,
      open
    });

    assert.deepEqual(statuses, ['loading the OCR engine', 'loading language traineddata']);
  });

  it('closes the lanes that did load when another fails to load', async () => {
    await seed('B001', 1);
    const engine = fakeRecogniser();
    let opens = 0;
    const open = async (): Promise<Recogniser> => {
      opens += 1;
      // The last lane to be asked is the one that cannot start.
      if (opens === LANES) throw new Error('OCR engine is missing');
      return engine.open();
    };

    await assert.rejects(runOcr('B001', { ...silent, open }), /engine is missing/);
    assert.equal(engine.closed, true, 'the lane that did start was not left running');
    assert.equal(engine.seen.length, 0, 'and no page was read');
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
