// Stops two reader tabs scanning the same book into one index, where the two
// capture streams would interleave into an unreadable PDF. The state lives in
// the service worker because it is the only context both tabs can reach.

export const SCAN_LOCKS_KEY = 'activeScanLocks';

export interface ScanLockOwner {
  tabId: number;
  /** Fresh per scan, so a release cannot be honoured for an earlier run. */
  token: string;
}

export type ScanLockRequest =
  | { action: 'acquireScanLock'; book: string; token: string }
  | { action: 'releaseScanLock'; book: string; token: string };

export interface ScanLockReply {
  acquired: boolean;
}

export function claimScanLock(
  locks: Record<string, ScanLockOwner>, book: string, owner: ScanLockOwner
): boolean {
  const current = locks[book];
  // A lock this tab already holds is one its own earlier scan failed to release.
  // Refusing it would wedge the tab out of scanning until it was reloaded, and
  // the content script has already checked that no scan of its own is running.
  if (current && current.tabId !== owner.tabId) return false;
  locks[book] = owner;
  return true;
}

export function releaseScanLock(
  locks: Record<string, ScanLockOwner>, book: string, owner: ScanLockOwner
): boolean {
  const current = locks[book];
  if (!current || current.tabId !== owner.tabId || current.token !== owner.token) return false;
  delete locks[book];
  return true;
}

export function removeTabScanLocks(
  locks: Record<string, ScanLockOwner>, tabId: number
): boolean {
  let changed = false;
  for (const [book, owner] of Object.entries(locks)) {
    if (owner.tabId !== tabId) continue;
    delete locks[book];
    changed = true;
  }
  return changed;
}

/**
 * True when this tab may scan the book. An unreachable worker also answers yes:
 * the lock is a guard against a rare mistake, not a correctness invariant, and
 * refusing every scan whenever the worker is restarting would be far worse.
 */
export async function acquireBookScan(book: string, token: string): Promise<boolean> {
  try {
    const reply = await chrome.runtime.sendMessage<ScanLockRequest, ScanLockReply>({
      action: 'acquireScanLock', book, token
    });
    return reply?.acquired ?? true;
  } catch (error) {
    console.warn('Could not reach the scan lock — scanning without it', error);
    return true;
  }
}

export async function releaseBookScan(book: string, token: string): Promise<void> {
  await chrome.runtime.sendMessage<ScanLockRequest, ScanLockReply>({
    action: 'releaseScanLock', book, token
  });
}
