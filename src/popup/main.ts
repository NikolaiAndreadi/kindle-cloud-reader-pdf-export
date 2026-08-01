import { READER_HOME, isReaderUrl } from '../shared/reader-hosts.ts';
import { clampDelay, clampJitter } from '../shared/timing.ts';
import { ui } from './elements.ts';
import { apply, showTiming } from './render.ts';

// A scan runs in the reader tab and the popup is a window onto it, so the
// numbers have to arrive on their own rather than when a button is clicked.
const POLL_MS = 1000;

let currentBook: string | null = null;

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
  try {
    const state = await send('getState');
    currentBook = state.bookId;
    apply(state);
  } catch (error) {
    currentBook = null;
    apply(null, describe(error));
  }
}

function onClick(button: HTMLButtonElement, run: () => Promise<string | null>): void {
  button.addEventListener('click', async () => {
    try {
      const message = await run();
      if (message !== null) ui.status.textContent = message;
      await refreshState();
    } catch (error) {
      ui.status.textContent = describe(error);
    }
  });
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

onClick(ui.preview, async () => {
  if (!currentBook) return null;
  await chrome.tabs.create({
    url: `${chrome.runtime.getURL('preview.html')}?book=${encodeURIComponent(currentBook)}`
  });
  window.close();
  return null;
});

onClick(ui.start, async () => {
  const options = uiOptions();
  await chrome.storage.local.set({ options });
  const result = await send('startScan', { options });
  return result.message || 'Scan started. You may close this popup.';
});

onClick(ui.save, async () => {
  ui.status.textContent = 'Building PDF in the reader tab…';
  return (await send('saveCached')).message;
});

onClick(ui.stop, async () => {
  await send('stopScan');
  return 'Stopping after the current page…';
});

onClick(ui.clear, async () => {
  if (!confirm('Delete all captured pages stored for this book?')) return null;
  return (await send('clearCached')).message;
});

/**
 * Every control writes through on change, so the popup reopens with what was
 * left set rather than the markup defaults. Starting a scan is no longer the
 * only thing that saves them.
 *
 * The pacing pair is also pushed to a scan already in flight: the settings used
 * to be read once at startup, so a scan turning out too fast could not be
 * slowed without stopping and resuming it.
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
    if (options.quality) ui.quality.value = String(options.quality);
    if (options.split !== undefined) ui.split.checked = options.split;
    showTiming();
  }
});

void refreshState();

// Chrome destroys the popup when it closes, so this interval lives exactly as
// long as the window it updates — there is nothing to tear down. Skipped while
// a request is still out so a slow reader tab cannot queue them up.
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void refreshState().finally(() => {
    polling = false;
  });
}, POLL_MS);
