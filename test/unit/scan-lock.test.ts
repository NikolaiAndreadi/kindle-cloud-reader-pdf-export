import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type ScanLockOwner, claimScanLock, releaseScanLock, removeTabScanLocks
} from '../../src/shared/scan-lock.ts';

const owner = (tabId: number, token: string): ScanLockOwner => ({ tabId, token });

describe('scan locks', () => {
  it('allows only the first owner to claim a book', () => {
    const locks = {};
    assert.equal(claimScanLock(locks, 'B001', owner(1, 'first')), true);
    assert.equal(claimScanLock(locks, 'B001', owner(2, 'second')), false);
  });

  it('allows different books to scan concurrently', () => {
    const locks = {};
    assert.equal(claimScanLock(locks, 'B001', owner(1, 'first')), true);
    assert.equal(claimScanLock(locks, 'B002', owner(2, 'second')), true);
  });

  it('lets a tab reclaim a lock its own earlier scan failed to release', () => {
    const locks: Record<string, ScanLockOwner> = {};
    claimScanLock(locks, 'B001', owner(1, 'abandoned'));
    assert.equal(claimScanLock(locks, 'B001', owner(1, 'fresh')), true);
    assert.equal(locks.B001?.token, 'fresh');
  });

  it('only lets the exact owner release a lock', () => {
    const locks = {};
    claimScanLock(locks, 'B001', owner(1, 'current'));
    assert.equal(releaseScanLock(locks, 'B001', owner(1, 'stale')), false);
    assert.equal(releaseScanLock(locks, 'B001', owner(2, 'current')), false);
    assert.equal(releaseScanLock(locks, 'B001', owner(1, 'current')), true);
  });

  it('cleans every lock owned by a closed or navigating tab', () => {
    const locks = {};
    claimScanLock(locks, 'B001', owner(1, 'one'));
    claimScanLock(locks, 'B002', owner(1, 'two'));
    claimScanLock(locks, 'B003', owner(2, 'three'));
    assert.equal(removeTabScanLocks(locks, 1), true);
    assert.deepEqual(Object.keys(locks), ['B003']);
  });
});
