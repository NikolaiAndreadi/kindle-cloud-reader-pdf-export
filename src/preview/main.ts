import { scanRunning } from '../shared/scanning.ts';
import {
  deleteCapture, fingerprintCounts, loadMeta, pagesInBatches, reorderCaptures
} from '../shared/storage.ts';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const grid = el('grid');
const summary = el('summary');
const title = el('title');
const lock = el('lock');
const viewer = el<HTMLDialogElement>('viewer');
const viewerImage = el<HTMLImageElement>('viewer-image');

const book = new URLSearchParams(location.search).get('book') || '';

/** How long a delete button stays armed before it goes back to being safe. */
const ARM_MS = 3000;

/**
 * How often the reader tabs are asked whether a scan has started. Slower than
 * the popup's poll: this only turns the controls on and off, and every edit
 * re-checks for itself anyway.
 */
const WATCH_MS = 2000;

const LOCK_TEXT = 'A scan is running — reordering and deleting are paused until it finishes.';

/** The cached index as this page last saw it, in export order. */
let captures: CaptureRecord[] = [];
let total: number | null = null;

/** True while a scan owns the index, so this page must not write to it. */
let locked = false;

interface Tile {
  figure: HTMLElement;
  /** The caption's left span, rewritten when duplicate status changes. */
  label: HTMLSpanElement;
  /** Caption text without the duplicate marker. */
  text: string;
  remove: HTMLButtonElement;
  fingerprint: string;
}

const tiles = new Map<number, Tile>();

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const span = (text: string, className?: string): HTMLSpanElement => {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
};

function openViewer(dataUrl: string, label: string): void {
  viewerImage.src = dataUrl;
  viewerImage.alt = label;
  viewer.showModal();
}

// Anywhere inside the dialog closes it, including the image itself and the
// backdrop, which reports the dialog as its target.
viewer.addEventListener('click', () => viewer.close());

function message(text: string): void {
  tiles.clear();
  summary.textContent = text;
  grid.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'empty', textContent: text
  }));
}

function describeCache(duplicates: number): void {
  // Built from nodes rather than innerHTML: this is an extension page, so
  // anything injected here would run with extension privileges.
  summary.replaceChildren(span(plural(captures.length, 'page')));
  if (total) summary.append(span(` of about ${total}`));
  if (duplicates) summary.append(span(' · '), span(plural(duplicates, 'duplicate'), 'warn'));
  summary.append(span(' · drag to reorder · the PDF follows this order'));
}

/**
 * Redraw everything that depends on the set of captures rather than on one
 * page: the summary line and the repeat markers, both of which change when a
 * page is deleted.
 */
function refresh(): void {
  const counts = fingerprintCounts(captures);
  let duplicates = 0;
  for (const count of counts.values()) duplicates += count - 1;

  for (const tile of tiles.values()) {
    const repeated = (counts.get(tile.fingerprint) || 0) > 1;
    tile.figure.classList.toggle('dupe', repeated);
    tile.label.textContent = tile.text + (repeated ? ' · repeat' : '');
  }
  describeCache(duplicates);
}

let armed: HTMLButtonElement | null = null;
let armTimer = 0;

function disarm(): void {
  if (!armed) return;
  armed.classList.remove('armed');
  armed.textContent = '×';
  armed = null;
  clearTimeout(armTimer);
}

function arm(button: HTMLButtonElement): void {
  disarm();
  armed = button;
  button.classList.add('armed');
  button.textContent = 'Delete?';
  armTimer = window.setTimeout(disarm, ARM_MS);
}

/** Put the tiles back in stored order, after an edit that was refused. */
function restoreOrder(): void {
  for (const capture of captures) {
    const tile = tiles.get(capture.index);
    if (tile) grid.append(tile.figure);
  }
}

function setLocked(value: boolean): void {
  if (locked === value) return;
  locked = value;
  lock.hidden = !value;
  grid.classList.toggle('locked', value);
  disarm();
  for (const tile of tiles.values()) {
    tile.figure.draggable = !value;
    tile.remove.disabled = value;
  }
}

/**
 * Whether this page may write to the index right now. Asked immediately before
 * every edit rather than trusting the poll: a scan started in the last couple
 * of seconds would otherwise swallow the edit at its next flush, silently.
 */
async function mayEdit(): Promise<boolean> {
  const running = await scanRunning(book);
  setLocked(running);
  return !running;
}

/**
 * Deleting a page cannot be undone short of scanning it again, so the first
 * click only arms the button. Same idea as holding "Clear this book" in the
 * popup, scaled down to one page.
 */
function deleteButton(index: number, figure: HTMLElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'del';
  button.textContent = '×';
  button.title = `Delete capture #${index}`;
  button.setAttribute('aria-label', `Delete capture #${index}`);
  button.disabled = locked;

  button.addEventListener('click', async () => {
    if (armed !== button) {
      arm(button);
      return;
    }
    disarm();
    button.disabled = true;
    // Refused means a scan just started, and the lock it turned on has already
    // disabled this button — re-enabling it unconditionally would undo that.
    if (!await mayEdit()) {
      button.disabled = locked;
      return;
    }
    const meta = await deleteCapture(book, index);
    captures = meta.captures;
    tiles.delete(index);
    figure.remove();
    if (!tiles.size) {
      message('Nothing cached for this book yet.');
      return;
    }
    refresh();
  });

  return button;
}

function tile(capture: CaptureRecord, page: StoredPage | undefined): HTMLElement {
  const figure = document.createElement('figure');
  figure.draggable = !locked;
  figure.dataset.index = String(capture.index);

  const text = `#${capture.index}${page?.page ? ` · page ${page.page}` : ''}`;
  const label = span(text);
  const caption = document.createElement('figcaption');

  if (page?.dataUrl) {
    const image = document.createElement('img');
    image.src = page.dataUrl;
    image.loading = 'lazy';
    image.alt = text;
    // Images drag themselves by default, which would take the drag away from
    // the figure and reorder nothing.
    image.draggable = false;
    image.addEventListener('click', () => openViewer(page.dataUrl, text));
    figure.append(image);
    caption.append(label, span(`${page.width}×${page.height}`));
  } else {
    figure.classList.add('gone');
    label.textContent = `${text} — missing from storage`;
    caption.append(label);
  }

  const remove = deleteButton(capture.index, figure);
  caption.append(remove);
  figure.append(caption);
  tiles.set(capture.index, { figure, label, text, remove, fingerprint: capture.fingerprint });
  return figure;
}

/** The capture indexes in the order the grid shows them right now. */
const shownOrder = (): number[] =>
  [...grid.children]
    .map((node) => Number((node as HTMLElement).dataset.index))
    .filter((index) => Number.isFinite(index) && index > 0);

async function persistOrder(): Promise<void> {
  const order = shownOrder();
  // Pages still loading are not in the grid yet, so compare against the tiles
  // that exist rather than against the whole index.
  if (order.every((index, at) => captures[at]?.index === index)) return;
  if (!await mayEdit()) {
    restoreOrder();
    return;
  }
  const meta = await reorderCaptures(book, order);
  captures = meta.captures;
  refresh();
}

let dragged: HTMLElement | null = null;

grid.addEventListener('dragstart', (event) => {
  const figure = (event.target as HTMLElement | null)?.closest('figure');
  // draggable is already off while locked; this is the backstop for a drag that
  // began just before a scan started.
  if (!figure || locked) {
    event.preventDefault();
    return;
  }
  disarm();
  dragged = figure;
  figure.classList.add('dragging');
  event.dataTransfer?.setData('text/plain', figure.dataset.index ?? '');
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
});

// The tile follows the pointer as it moves, so what the grid shows on drop is
// what gets written. No separate drop-target highlight to keep in step.
grid.addEventListener('dragover', (event) => {
  if (!dragged) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

  const over = (event.target as HTMLElement | null)?.closest('figure');
  if (!over || over === dragged) return;
  const box = over.getBoundingClientRect();
  const after = event.clientX > box.left + box.width / 2;
  grid.insertBefore(dragged, after ? over.nextSibling : over);
});

grid.addEventListener('drop', (event) => event.preventDefault());

// dragend rather than drop: a drag cancelled with Escape or released outside
// the grid still leaves the tile where the user last saw it, and the stored
// order should agree with the screen.
grid.addEventListener('dragend', () => {
  dragged?.classList.remove('dragging');
  dragged = null;
  void persistOrder();
});

/**
 * Which load() call owns the grid. A scan finishing reloads the page contents
 * while the previous load may still be walking its batches; the stale one drops
 * out rather than appending tiles for an index nobody is looking at any more.
 */
let generation = 0;

async function load(): Promise<void> {
  const mine = ++generation;
  title.textContent = `Captured pages · ${book}`;
  if (!book) {
    message('No book specified.');
    return;
  }

  const meta = await loadMeta(book);
  if (mine !== generation) return;
  if (!meta.captures.length) {
    message('Nothing cached for this book yet.');
    return;
  }

  captures = meta.captures;
  total = meta.total;
  refresh();

  for await (const batch of pagesInBatches(book, meta.captures)) {
    if (mine !== generation) return;
    grid.append(...batch.map(({ capture, page }) => tile(capture, page)));
    refresh();
  }
}

async function reload(): Promise<void> {
  tiles.clear();
  grid.replaceChildren();
  await load();
}

// Poll rather than listen: the scan lives in another tab and announces nothing,
// and the storage writes it does make say nothing about when it stopped.
async function watchScan(): Promise<void> {
  const wasLocked = locked;
  setLocked(await scanRunning(book));
  // A scan that has just finished leaves this grid short of everything it
  // captured, so pick the pages up rather than showing a stale count.
  if (wasLocked && !locked) await reload();
}

// Skipped while a query is still out, so an unresponsive reader tab cannot
// queue them up.
let watching = false;
function tick(): void {
  if (watching) return;
  watching = true;
  void watchScan().finally(() => {
    watching = false;
  });
}

lock.textContent = LOCK_TEXT;
void load().then(tick);
setInterval(tick, WATCH_MS);
