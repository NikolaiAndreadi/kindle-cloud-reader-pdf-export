import {
  SCAN_LOCKS_KEY, type ScanLockOwner, type ScanLockReply, type ScanLockRequest,
  claimScanLock, releaseScanLock, removeTabScanLocks
} from '../shared/scan-lock.ts';

import { clearAllBooks } from '../shared/storage.ts';

/**
 * Every lock change is a read-modify-write against session storage, so they run
 * one at a time. A worker restart empties this queue but not the storage, which
 * is where the state that matters lives.
 */
let queue: Promise<void> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function loadLocks(): Promise<Record<string, ScanLockOwner>> {
  const stored = await chrome.storage.session.get(SCAN_LOCKS_KEY);
  const locks = stored[SCAN_LOCKS_KEY];
  return locks && typeof locks === 'object' ? locks as Record<string, ScanLockOwner> : {};
}

const saveLocks = (locks: Record<string, ScanLockOwner>): Promise<void> =>
  chrome.storage.session.set({ [SCAN_LOCKS_KEY]: locks });

function isScanLockRequest(value: unknown): value is ScanLockRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (request.action === 'acquireScanLock' || request.action === 'releaseScanLock') &&
    typeof request.book === 'string' && typeof request.token === 'string';
}

chrome.runtime.onMessage.addListener((
  request: ScanLockRequest | unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (reply: ScanLockReply | { cleared: boolean } | { error: string }) => void
): boolean => {
  if (sender.url === chrome.runtime.getURL('popup.html') &&
      (request as { action?: string } | null)?.action === 'clearAllBooks') {
    void serial(async () => {
      if (Object.keys(await loadLocks()).length) throw new Error('Stop all scans before deleting cached books.');
      const cleared = await navigator.locks.request('book-cache', { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('Stop OCR before deleting cached books.');
        return clearAllBooks();
      });
      if (cleared) {
        // Refresh any open previews. There may be no listening preview tab.
        await chrome.runtime.sendMessage({ action: 'booksCleared' }).catch(() => {});
      }
      sendResponse({ cleared });
    }).catch((error: Error) => sendResponse({ error: error.message }));
    return true;
  }
  if (!isScanLockRequest(request)) return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    sendResponse({ acquired: false });
    return false;
  }

  const owner: ScanLockOwner = { tabId, token: request.token };
  void serial(async () => {
    const locks = await loadLocks();
    const changed = request.action === 'acquireScanLock'
      ? claimScanLock(locks, request.book, owner)
      : releaseScanLock(locks, request.book, owner);
    if (changed) await saveLocks(locks);
    sendResponse({ acquired: request.action === 'acquireScanLock' && changed });
  }).catch((error: Error) => {
    // Always answer: a channel left open closes with an error the caller reads
    // as "the worker is broken" rather than as a refusal.
    console.warn('Scan lock update failed', error);
    sendResponse({ acquired: false });
  });
  return true;
});

function clearTab(tabId: number): void {
  void serial(async () => {
    const locks = await loadLocks();
    if (removeTabScanLocks(locks, tabId)) await saveLocks(locks);
  }).catch((error: Error) => console.warn('Could not clear the scan locks of a tab', error));
}

// A tab that closes or navigates away takes its scan with it, and the dying
// content script never gets to release the lock.
chrome.tabs.onRemoved.addListener(clearTab);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Every tab, not only the reader ones: at 'loading' the tab already reports
  // its destination, so a tab leaving the reader looks like any other page —
  // and that is exactly the navigation whose lock has to be dropped. Filtering
  // here would save one session-storage read and no wakeup, since registering
  // the listener at all is what brings this worker back for a navigation.
  if (change.status === 'loading') clearTab(tabId);
});
