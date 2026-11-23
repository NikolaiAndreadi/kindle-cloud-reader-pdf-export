"use strict";
(() => {
  // src/shared/scan-lock.ts
  var SCAN_LOCKS_KEY = "activeScanLocks";
  function claimScanLock(locks, book, owner) {
    const current = locks[book];
    if (current && current.tabId !== owner.tabId) return false;
    locks[book] = owner;
    return true;
  }
  function releaseScanLock(locks, book, owner) {
    const current = locks[book];
    if (!current || current.tabId !== owner.tabId || current.token !== owner.token) return false;
    delete locks[book];
    return true;
  }
  function removeTabScanLocks(locks, tabId) {
    let changed = false;
    for (const [book, owner] of Object.entries(locks)) {
      if (owner.tabId !== tabId) continue;
      delete locks[book];
      changed = true;
    }
    return changed;
  }

  // src/shared/storage.ts
  async function storageKeys() {
    const local = chrome.storage.local;
    return typeof local.getKeys === "function" ? await local.getKeys() : Object.keys(await local.get(null));
  }
  async function clearAllBooks() {
    const keys = (await storageKeys()).filter((key) => key.startsWith("book:"));
    if (!keys.length) return false;
    await chrome.storage.local.remove(keys);
    return true;
  }

  // src/background/main.ts
  var queue = Promise.resolve();
  function serial(work) {
    const result = queue.then(work);
    queue = result.then(() => void 0, () => void 0);
    return result;
  }
  async function loadLocks() {
    const stored = await chrome.storage.session.get(SCAN_LOCKS_KEY);
    const locks = stored[SCAN_LOCKS_KEY];
    return locks && typeof locks === "object" ? locks : {};
  }
  var saveLocks = (locks) => chrome.storage.session.set({ [SCAN_LOCKS_KEY]: locks });
  function isScanLockRequest(value) {
    if (!value || typeof value !== "object") return false;
    const request = value;
    return (request.action === "acquireScanLock" || request.action === "releaseScanLock") && typeof request.book === "string" && typeof request.token === "string";
  }
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.url === chrome.runtime.getURL("popup.html") && request?.action === "clearAllBooks") {
      void serial(async () => {
        if (Object.keys(await loadLocks()).length) throw new Error("Stop all scans before deleting cached books.");
        const cleared = await navigator.locks.request("book-cache", { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error("Stop OCR before deleting cached books.");
          return clearAllBooks();
        });
        if (cleared) {
          await chrome.runtime.sendMessage({ action: "booksCleared" }).catch(() => {
          });
        }
        sendResponse({ cleared });
      }).catch((error) => sendResponse({ error: error.message }));
      return true;
    }
    if (!isScanLockRequest(request)) return false;
    const tabId = sender.tab?.id;
    if (tabId === void 0) {
      sendResponse({ acquired: false });
      return false;
    }
    const owner = { tabId, token: request.token };
    void serial(async () => {
      const locks = await loadLocks();
      const changed = request.action === "acquireScanLock" ? claimScanLock(locks, request.book, owner) : releaseScanLock(locks, request.book, owner);
      if (changed) await saveLocks(locks);
      sendResponse({ acquired: request.action === "acquireScanLock" && changed });
    }).catch((error) => {
      console.warn("Scan lock update failed", error);
      sendResponse({ acquired: false });
    });
    return true;
  });
  function clearTab(tabId) {
    void serial(async () => {
      const locks = await loadLocks();
      if (removeTabScanLocks(locks, tabId)) await saveLocks(locks);
    }).catch((error) => console.warn("Could not clear the scan locks of a tab", error));
  }
  chrome.tabs.onRemoved.addListener(clearTab);
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") clearTab(tabId);
  });
})();
