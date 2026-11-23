import { bindHoldToDelete } from '../shared/hold-to-delete.ts';
import { READER_HOME, isReaderUrl } from '../shared/reader-hosts.ts';
import { SCAN_LOCKS_KEY } from '../shared/scan-lock.ts';
import { clampDelay, clampJitter } from '../shared/timing.ts';
import { ui } from './elements.ts';
import { apply, notice, showTiming } from './render.ts';

// A scan runs in the reader tab and the popup is a window onto it, so the
// numbers have to arrive on their own rather than when a button is clicked.
const POLL_MS = 1000;

let currentBook: string | null = null;
// What the one scan button will do when pressed. Kept here rather than read off
// the button's own label, so the two cannot disagree about which action is
// meant, and refreshed on every poll so a scan that ended by itself is noticed.
let scanning = false;

const uiOptions = (): ScanOptions => ({
  delay: Number(ui.delay.value),
  jitter: Number(ui.jitter.value),
  quality: Number(ui.quality.value),
  split: ui.split.checked
});

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send<A extends ReaderAction>(
  action: A, extra: Record<string, unknown> = {}
): Promise<ReaderReplies[A]> {
  const tab = await activeTab();
  if (!tab?.id || !isReaderUrl(tab.url)) {
    throw new Error('Open a book at read.amazon.com first.');
  }
  const response = await chrome.tabs.sendMessage<ReaderRequest, ReaderReplies[A] | ReaderFailure>(
    tab.id, { action, ...extra } as ReaderRequest
  );
  if ('error' in response) throw new Error(response.error);
  return response;
}

/**
 * A content script is only injected at page load, so a tab opened before the
 * extension was installed or reloaded has none. Chrome reports that as a bare
 * "Could not establish connection", which says nothing about the fix.
 */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /Could not establish connection|Receiving end does not exist/i.test(message)
    ? 'Reload the reader tab, then try again — the extension was not loaded when the page opened.'
    : message;
}

async function refreshState(): Promise<void> {
  // Inside the try, and read before asking the tab anything: what the popup
  // shows depends on where the tab is, which is knowable even when the tab
  // cannot answer — and apply() has to run on every path, or the popup is left
  // showing the neither-state it starts in.
  let onReader = false;
  try {
    onReader = isReaderUrl((await activeTab())?.url);
    const state = await send('getState');
    currentBook = state.bookId;
    scanning = state.scanning;
    apply(state, onReader);
  } catch (error) {
    currentBook = null;
    // A tab that cannot answer is not a tab with a scan running in it.
    scanning = false;
    apply(null, onReader, describe(error));
  }
  updateDeleteButton();
}

async function perform(run: () => Promise<string | null>): Promise<void> {
  try {
    const message = await run();
    // notice(), not an assignment: the refresh below rewrites the status line
    // from the state and would erase this before it was read.
    if (message !== null) notice(message);
    await refreshState();
  } catch (error) {
    notice(describe(error));
  }
}

function onClick(button: HTMLButtonElement, run: () => Promise<string | null>): void {
  button.addEventListener('click', () => void perform(run));
}

// Prefer an existing reader tab over stacking up duplicates. Querying every tab
// is fine without the "tabs" permission: url is only populated for tabs the
// extension already has host access to, which is exactly the reader tabs.
onClick(ui.open, async () => {
  const tabs = await chrome.tabs.query({});
  const reader = tabs.find((tab) => isReaderUrl(tab.url));
  if (reader?.id !== undefined) {
    await chrome.tabs.update(reader.id, { active: true });
    if (reader.windowId !== undefined) await chrome.windows.update(reader.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: READER_HOME });
  }
  window.close();
  return null;
});

let scanLocksActive: boolean | undefined;
let clearing = false;

function updateDeleteButton(): void {
  ui.clearAll.disabled = clearing || scanning || scanLocksActive !== false;
  if (ui.clearAll.disabled) cancelDeleteHold();
  ui.clearAll.title = scanning || scanLocksActive ? 'Stop all scans to delete cached books.' : '';
}

const cancelDeleteHold = bindHoldToDelete(ui.clearAll, () => void perform(async () => {
  clearing = true;
  updateDeleteButton();
  try {
    const reply = await chrome.runtime.sendMessage({ action: 'clearAllBooks' });
    if (reply?.error) throw new Error(reply.error);
    if (typeof reply?.cleared !== 'boolean') {
      throw new Error('Deletion could not be confirmed. Reload the extension in chrome://extensions, then try again.');
    }
    return reply.cleared ? 'Deleted all cached books.' : 'No cached books to delete.';
  } finally {
    clearing = false;
    updateDeleteButton();
  }
}));

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes[SCAN_LOCKS_KEY]) return;
  scanLocksActive = Object.keys(changes[SCAN_LOCKS_KEY].newValue ?? {}).length > 0;
  updateDeleteButton();
});
void chrome.storage.session.get(SCAN_LOCKS_KEY).then((stored) => {
  // A change delivered while the initial read was in flight is newer.
  scanLocksActive ??= Object.keys(stored[SCAN_LOCKS_KEY] ?? {}).length > 0;
  updateDeleteButton();
}).catch((error) => notice(describe(error)));

onClick(ui.preview, async () => {
  if (!currentBook) return null;
  await chrome.tabs.create({
    url: `${chrome.runtime.getURL('preview.html')}?book=${encodeURIComponent(currentBook)}`
  });
  window.close();
  return null;
});

// The branch is on the tracked state, not on what the label happens to say. The
// reply is relayed rather than assumed, because a scan can end in the second
// between two polls: the content script refuses a second start and answers a
// late stop with "No scan is running" instead of claiming it stopped one.
onClick(ui.scan, async () => {
  if (scanning) return (await send('stopScan')).message;
  const options = uiOptions();
  await chrome.storage.local.set({ options });
  const result = await send('startScan', { options });
  return result.message || 'Scan started. You may close this popup.';
});

/**
 * Every control writes through on change, so the popup reopens with what was
 * left set rather than the markup defaults. The pacing pair is also pushed to a
 * scan already in flight, so a scan turning out too fast can be slowed without
 * stopping and resuming it.
 */
async function remember(pacing: boolean): Promise<void> {
  const options = uiOptions();
  await chrome.storage.local.set({ options });
  if (!pacing) return;
  try {
    await send('retune', { options });
  } catch {
    // No reader tab, or nothing running. Either way the values are saved and
    // the next scan starts with them, so this is not worth reporting.
  }
}

for (const control of [ui.quality, ui.split]) {
  control.addEventListener('change', () => void remember(false));
}

for (const slider of [ui.delay, ui.jitter]) {
  // input for the label so it tracks the thumb, change for the write so a drag
  // is one save and one message rather than one per pixel.
  slider.addEventListener('input', showTiming);
  slider.addEventListener('change', () => void remember(true));
}

// Label the markup defaults first: the stored options arrive a tick later, and
// a popup that opens showing no timing at all reads as broken.
showTiming();

chrome.storage.local.get('options').then(({ options }: { options?: ScanOptions }) => {
  if (options) {
    // Clamped on the way in as well as in the content script, so a value saved
    // by an older build cannot leave the slider showing something it cannot set.
    if (options.delay !== undefined) ui.delay.value = String(clampDelay(options.delay));
    if (options.jitter !== undefined) ui.jitter.value = String(clampJitter(options.jitter));
    // Not over a control the cache has already pinned: whichever of the two
    // arrives second would otherwise win, and the cache is the authority.
    if (options.quality && !ui.quality.disabled) ui.quality.value = String(options.quality);
    if (options.split !== undefined && !ui.split.disabled) ui.split.checked = options.split;
    showTiming();
  }
});

void refreshState();

// Chrome destroys the popup when it closes, so this interval lives exactly as
// long as the window it updates. Skipped while a request is still out, so a
// slow reader tab cannot queue them up.
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void refreshState().finally(() => {
    polling = false;
  });
}, POLL_MS);
