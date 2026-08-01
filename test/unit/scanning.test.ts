import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { scanRunning } from '../../src/shared/scanning.ts';

interface FakeTab {
  id?: number;
  url?: string;
  /** What getState resolves to, or a thrower for a tab with no content script. */
  reply?: Partial<BookState> | ReaderFailure | (() => never);
}

const READER = 'https://read.amazon.com/?asin=B001';

/** Just enough of chrome.tabs to exercise the module. */
function fakeTabs(tabs: FakeTab[]): { asked: number[] } {
  const asked: number[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    tabs: {
      query: async () => tabs.map(({ id, url }) => ({ id, url })),
      sendMessage: async (id: number) => {
        asked.push(id);
        const reply = tabs.find((tab) => tab.id === id)?.reply;
        if (typeof reply === 'function') reply();
        return reply;
      }
    }
  };
  return { asked };
}

const scanning = (bookId: string): Partial<BookState> => ({ bookId, scanning: true });
const idle = (bookId: string): Partial<BookState> => ({ bookId, scanning: false });

describe('scanRunning', () => {
  it('is false when no tab is on the reader', async () => {
    const { asked } = fakeTabs([{ id: 1, url: 'https://example.com/' }]);
    assert.equal(await scanRunning('B001'), false);
    assert.deepEqual(asked, []);
  });

  it('is true when a reader tab is scanning this book', async () => {
    fakeTabs([{ id: 7, url: READER, reply: scanning('B001') }]);
    assert.equal(await scanRunning('B001'), true);
  });

  it('is false when the reader tab is idle', async () => {
    fakeTabs([{ id: 7, url: READER, reply: idle('B001') }]);
    assert.equal(await scanRunning('B001'), false);
  });

  it('ignores a scan of a different book', async () => {
    fakeTabs([{ id: 7, url: READER, reply: scanning('B002') }]);
    assert.equal(await scanRunning('B001'), false);
  });

  it('finds the scan in a tab other than the first reader tab', async () => {
    fakeTabs([
      { id: 1, url: READER, reply: idle('B001') },
      { id: 2, url: READER, reply: scanning('B001') }
    ]);
    assert.equal(await scanRunning('B001'), true);
  });

  it('treats a tab with no content script as not scanning', async () => {
    fakeTabs([{
      id: 7, url: READER, reply: () => { throw new Error('Could not establish connection'); }
    }]);
    assert.equal(await scanRunning('B001'), false);
  });

  it('keeps asking the other tabs when one of them fails', async () => {
    fakeTabs([
      { id: 1, url: READER, reply: () => { throw new Error('Receiving end does not exist'); } },
      { id: 2, url: READER, reply: scanning('B001') }
    ]);
    assert.equal(await scanRunning('B001'), true);
  });

  it('treats an error reply as not scanning rather than as a truthy state', async () => {
    fakeTabs([{ id: 7, url: READER, reply: { error: 'boom' } }]);
    assert.equal(await scanRunning('B001'), false);
  });

  it('skips a tab that reports no id', async () => {
    const { asked } = fakeTabs([{ url: READER, reply: scanning('B001') }]);
    assert.equal(await scanRunning('B001'), false);
    assert.deepEqual(asked, []);
  });
});
