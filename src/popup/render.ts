import { ui } from './elements.ts';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusFor(state: BookState): string {
  if (state.scanning) return 'Scanning — watch the banner in the reader tab.';
  if (!state.bookOpen) return 'No book is open in this tab. Open one, then scan.';
  if (state.position) {
    return `Ready · reader at ${state.position.kind} ${state.position.value} of ${state.position.total}.`;
  }
  return 'Ready to scan.';
}

// Saying so up front saves a wasted scan and a trip to the reader settings.
function layoutFor(state: BookState, splitting: boolean): string {
  if (!state.wideView) return 'Single-column layout detected — one PDF page per book page.';
  return splitting
    ? 'Two-column layout detected — each spread will be split into two pages.'
    : 'Two-column layout detected — each PDF page will hold two book pages.';
}

function cacheFor(state: BookState): string {
  if (!state.count) return `No saved pages yet · ${state.bookId}`;
  const dupes = state.duplicates ? ` · ${plural(state.duplicates, 'duplicate')}` : '';
  // state.total is null for location-counted books, so this never claims a page
  // count the reader never gave us.
  const outOf = state.total ? ` of ~${state.total}` : '';
  return `${plural(state.count, 'saved view')}${outOf}${dupes} · ${state.bookId}`;
}

/**
 * The popup reflects what the reader is actually doing: there is no point
 * telling someone to open a book when they are already reading one, and no
 * point offering a scan when nothing is rendered.
 */
export function apply(state: BookState | null, problem?: string): void {
  const ready = state?.bookOpen === true;

  ui.open.hidden = ready;
  ui.preview.hidden = !state?.count;
  ui.start.disabled = !ready;
  ui.stop.disabled = !state?.scanning;
  ui.save.disabled = !state?.count;
  ui.clear.disabled = !state?.count || state.scanning;
  ui.layout.hidden = !ready;

  if (!state) {
    ui.status.textContent = problem || 'Open read.amazon.com to begin.';
    ui.cache.textContent = '';
    return;
  }

  ui.status.textContent = statusFor(state);
  if (ready) ui.layout.textContent = layoutFor(state, ui.split.checked);
  ui.cache.textContent = cacheFor(state);
}
