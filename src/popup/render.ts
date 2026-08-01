import { jitterCeiling } from '../shared/timing.ts';
import { ui } from './elements.ts';

const NOTICE_MS = 4000;

let noticeUntil = 0;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Say something that happened, as opposed to what is currently true. apply()
 * rewrites the status line from the state on every poll, so without this the
 * result of an action is overwritten before it can be read.
 */
export function notice(message: string): void {
  noticeUntil = Date.now() + NOTICE_MS;
  ui.status.textContent = message;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// Jitter is a bare 0–5 level, which means nothing on its own, so it is shown as
// the range of waits it produces at the chosen delay.
export function showTiming(): void {
  const delay = Number(ui.delay.value);
  const jitter = Number(ui.jitter.value);
  ui.delayValue.textContent = seconds(delay);
  ui.jitterValue.textContent = jitter
    ? `${seconds(delay)}–${seconds(jitterCeiling(delay, jitter))}`
    : 'off';
}

// Deliberately says nothing about where the reader is: the counter it comes
// from is repaginated for the window width, so "page 39 of 329" is a different
// page 39 at a different zoom and reads as precision the number does not have.
function statusFor(state: BookState): string {
  if (state.scanning) return 'Scanning — watch the banner in the reader tab.';
  if (!state.bookOpen) return 'No book is open in this tab. Open one, then scan.';
  return 'Ready to scan.';
}

function cacheFor(state: BookState): string {
  if (!state.count) return `No saved pages yet · ${state.bookId}`;
  const dupes = state.duplicates ? ` · ${plural(state.duplicates, 'duplicate')}` : '';
  const outOf = state.total ? ` of ~${state.total}` : '';
  const text = state.recognised === state.count
    ? ' · all searchable'
    : state.recognised
      ? ` · ${state.recognised}/${state.count} searchable`
      : ' · no text layer yet';
  return `${plural(state.count, 'saved view')}${outOf}${dupes}${text} · ${state.bookId}`;
}

/**
 * Quality and split are properties of a book's cache, not of one run: every
 * page has to share them, so the first scan fixes them and only clearing the
 * book lets them move again. Disabling the pair says so before a scan, which
 * beats refusing one afterwards.
 */
function lockBookOptions(state: BookState | null): void {
  const locked = Boolean(state?.count);
  ui.quality.disabled = locked;
  ui.split.disabled = locked;
  ui.bookOptions.classList.toggle('locked', locked);

  if (locked) ui.bookOptions.title = 'Available only for a new scan';
  else ui.bookOptions.removeAttribute('title');
  ui.bookNote.hidden = locked;

  // Only once locked, and only from the cache: while they are still editable the
  // poll would otherwise overwrite the value being chosen a second ago.
  if (!locked || !state) return;
  if (state.split !== null) ui.split.checked = state.split;
  // Matched against the options rather than assigned: an older build may have
  // stored a quality this list no longer offers, and an unknown value on a
  // <select> selects nothing and shows the control blank.
  const choice = [...ui.quality.options].find((option) => Number(option.value) === state.quality);
  if (choice) ui.quality.value = choice.value;
}

export function apply(state: BookState | null, onReader: boolean, problem?: string): void {
  const ready = state?.bookOpen === true;
  // Everything else here describes the current state and is safe to rewrite
  // every tick. Only the status line can be holding a notice().
  const spoken = Date.now() < noticeUntil;

  // Whether the tab is the reader comes from its URL rather than from whether
  // getState answered: a reader tab that predates the extension has no content
  // script, and offering "Open read.amazon.com" there would point at itself
  // when the answer in the status line is "reload this tab".
  ui.open.hidden = onReader;
  ui.controls.hidden = !ready;

  lockBookOptions(state);
  ui.preview.hidden = !state?.count;
  ui.start.disabled = !ready;
  ui.stop.disabled = !state?.scanning;
  ui.save.disabled = !state?.count;
  ui.clear.disabled = !state?.count || state.scanning;

  if (!state) {
    if (!spoken) ui.status.textContent = problem || 'Open read.amazon.com to begin.';
    ui.cache.textContent = '';
    return;
  }

  if (!spoken) ui.status.textContent = statusFor(state);
  ui.cache.textContent = cacheFor(state);
}
