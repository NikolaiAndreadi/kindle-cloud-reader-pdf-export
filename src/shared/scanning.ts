// A running scan holds the book's index in memory and flushes it every so
// often, so anything another page writes to that index in the meantime is
// overwritten by the next flush. Pages that edit the index — currently only the
// preview grid — ask here first rather than racing it.

import { isReaderUrl } from './reader-hosts.ts';

async function askTab(id: number): Promise<BookState | null> {
  try {
    const reply = await chrome.tabs.sendMessage<ReaderRequest, BookState | ReaderFailure | undefined>(
      id, { action: 'getState' }
    );
    return !reply || 'error' in reply ? null : reply;
  } catch {
    // No content script in that tab (it was open before the extension loaded),
    // or the tab went away while we asked. Neither one is a scan.
    return null;
  }
}

/**
 * Every reader tab is asked, not just the active one: the preview grid is
 * itself the active tab whenever it is being used, and the scan it must not
 * collide with is by definition running somewhere else. Querying all tabs needs
 * no "tabs" permission — url is only populated for tabs the extension already
 * has host access to, which is exactly the reader tabs.
 */
export async function scanRunning(book: string): Promise<boolean> {
  const tabs = await chrome.tabs.query({});
  const readerIds = tabs.flatMap((tab) =>
    tab.id !== undefined && isReaderUrl(tab.url) ? [tab.id] : []
  );
  const states = await Promise.all(readerIds.map(askTab));
  return states.some((state) => state?.scanning && state.bookId === book);
}
