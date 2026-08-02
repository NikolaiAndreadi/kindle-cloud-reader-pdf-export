import { scanRunning } from '../shared/scanning.ts';
import { loadMeta, pagesInBatches } from '../shared/storage.ts';
import { BookActions } from './actions.ts';
import { EMPTY_TEXT, message, ui } from './elements.ts';
import { PreviewGrid } from './grid.ts';
import { OcrController } from './ocr.ts';

/**
 * How often the reader tabs are asked whether a scan has started. Slower than
 * the popup's poll: this only turns the controls on and off, and every edit
 * re-checks for itself anyway.
 */
const WATCH_MS = 2000;
const book = new URLSearchParams(location.search).get('book') || '';
const grid = new PreviewGrid(book);
const ocr = new OcrController(book, grid);
const actions = new BookActions(book, grid);

grid.onChange = () => {
  ocr.describe();
  actions.describe();
};
ocr.onBusy = (busy) => actions.setOcrBusy(busy);

/**
 * Which load() call owns the grid. A scan finishing reloads the page contents
 * while the previous load may still be walking its batches; the stale one drops
 * out rather than appending tiles for an index nobody is looking at any more.
 */
let generation = 0;

async function load(): Promise<void> {
  const mine = ++generation;
  ui.title.textContent = `Captured pages · ${book}`;
  if (!book) {
    grid.showMessage('No book specified.');
    return;
  }

  const meta = await loadMeta(book);
  if (mine !== generation) return;
  if (!meta.captures.length) {
    grid.showMessage(EMPTY_TEXT);
    return;
  }

  grid.setMeta(meta);
  await grid.refreshRecognised();
  if (mine !== generation) return;

  for await (const batch of pagesInBatches(book, meta.captures)) {
    if (mine !== generation) return;
    for (const { capture, page } of batch) grid.append(capture, page);
    // refresh, not setMeta: a page deleted while the batches are still arriving
    // has already left the grid's own list, and this meta predates it.
    grid.refresh();
  }
}

async function reload(): Promise<void> {
  grid.clearTiles();
  await load();
}

// Poll rather than listen: the scan lives in another tab and announces nothing,
// and the storage writes it does make say nothing about when it stopped.
async function watchScan(): Promise<void> {
  const wasLocked = grid.locked;
  grid.setLocked(await scanRunning(book));
  // setLocked only reaches the grid's own controls; clearing is disabled by the
  // same lock and is not one of them.
  actions.describe();
  // A scan that has just finished leaves this grid short of everything it
  // captured, so pick the pages up rather than showing a stale count.
  if (wasLocked && !grid.locked) await reload();
}

// Skipped while a query is still out, so an unresponsive reader tab cannot
// queue them up.
let watching = false;
function tick(): void {
  if (watching) return;
  watching = true;
  void watchScan()
    .catch((error) => grid.showError(error))
    .finally(() => {
      watching = false;
    });
}

void load().then(tick, (error) => grid.showMessage(`Could not load this book: ${message(error)}`));
setInterval(tick, WATCH_MS);
