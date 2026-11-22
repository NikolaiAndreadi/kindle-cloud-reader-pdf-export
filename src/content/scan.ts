import { META_FLUSH_EVERY, loadMeta, nextIndex, saveMeta, storePage } from '../shared/storage.ts';
import { clampDelay, clampJitter, jitteredDelay } from '../shared/timing.ts';
import { bookId, pageCandidates, positionKey, readerPosition } from './dom.ts';
import { LOSSLESS_QUALITY, fingerprintOf, renderRegion, viewsOf } from './capture.ts';
import type { SplitMode } from './capture.ts';
import { notify, removeNoticeLater } from './notice.ts';
import { turnProber } from './turning.ts';

const STALL_LIMIT = 3;
const MAX_ITERATIONS = 10000;
const MAX_SPREAD = 4;

/**
 * How many turns in a row may land on a view this run has already been shown
 * before the scan gives up. Higher than STALL_LIMIT because this catches a
 * reader that is still moving, just not forwards, and a few wasted turns are
 * cheaper than ending a good scan early.
 */
const REVISIT_LIMIT = 10;

const QUALITY_MIN = .6;
const QUALITY_MAX = .98;
const QUALITY_DEFAULT = .88;

function clampQuality(value: unknown): number {
  const quality = Number(value);
  if (quality === LOSSLESS_QUALITY) return LOSSLESS_QUALITY;
  return Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, quality || QUALITY_DEFAULT));
}

// How much of the configured delay to wait before looking at the page, as
// opposed to after turning it.
const SETTLE_RATIO = .7;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

let running = false;
let stopRequested = false;

// The settings the running scan is reading, so the pacing controls can be
// retuned without stopping it. Null whenever no scan is in flight.
let live: Settings | null = null;

export const isRunning = (): boolean => running;

export function requestStop(): void {
  stopRequested = true;
}

export interface Settings {
  delay: number;
  /** 0–5. How much random extra time to add on top of `delay`. */
  jitter: number;
  quality: number;
  split: boolean;
}

/**
 * Re-pace the running scan from its next wait onwards. Only the timing controls
 * move: quality would leave one book holding pages encoded two ways, and split
 * decides the page boundaries the cache is keyed on.
 */
export function retune(options: ScanOptions | undefined): boolean {
  if (!live) return false;
  // Each field is applied only when it was actually sent, so a partial message
  // cannot silently reset the other control to its default.
  if (options?.delay !== undefined) live.delay = clampDelay(options.delay);
  if (options?.jitter !== undefined) live.jitter = clampJitter(options.jitter);
  return true;
}

export function settingsFrom(options: ScanOptions | undefined): Settings {
  return {
    delay: clampDelay(options?.delay),
    jitter: clampJitter(options?.jitter),
    quality: clampQuality(options?.quality),
    split: options?.split !== false
  };
}

/**
 * Watches for a reader that has stopped going anywhere new. The stall counter
 * only compares against the previous view, so it cannot see a reader that keeps
 * changing without advancing — bouncing between the last page and a trailing
 * blank, or looping a section.
 *
 * Scoped to the run, not to the cache: resuming a part-captured book walks back
 * over pages that are already stored, and re-treading those is progress.
 */
export function revisitWatch(limit: number = REVISIT_LIMIT) {
  const seen = new Set<string>();
  let consecutive = 0;

  return {
    get revisits(): number {
      return consecutive;
    },
    /** Records the view just captured. True once the run should give up. */
    saw(primary: string): boolean {
      // '' means the pixels could not be read, which says nothing either way.
      if (!primary) return false;
      if (seen.has(primary)) {
        consecutive += 1;
      } else {
        consecutive = 0;
        seen.add(primary);
      }
      return consecutive >= limit;
    }
  };
}

interface ViewResult {
  /** Identity of the first region of the first candidate, '' if unreadable. */
  primary: string;
  stored: number;
}

/**
 * Reconcile the settings that belong to the whole book with what the cache was
 * built with, adjusting `settings` in place. The popup disables both controls
 * once a book has pages; this is the backstop that makes them properties of the
 * cache rather than of the run, whatever a stale message asks for.
 */
export function prepareBookMode(meta: BookMeta, settings: Settings): void {
  if (!meta.captures.length) {
    meta.split = settings.split;
    meta.splitByGutter = settings.split;
    meta.quality = settings.quality;
    return;
  }
  if (meta.split === null) {
    throw new Error('This cache predates layout tracking. Save it or clear it before starting a new scan.');
  }
  // Page boundaries decide what a capture even is, so a mismatch is refused
  // rather than corrected: half the book would be spreads and half single pages.
  if (meta.split !== settings.split) {
    throw new Error('The split setting differs from this cache. Clear the cached pages before changing it.');
  }
  // Caches that predate the quality field contain JPEGs.
  meta.quality ??= settings.quality === LOSSLESS_QUALITY ? QUALITY_DEFAULT : settings.quality;
  settings.quality = meta.quality;
}

/**
 * Capture everything rendered right now. Regions already in `known` are skipped
 * before encoding, so resuming a book costs a downscale per view rather than a
 * full encode.
 */
async function captureRendered(
  meta: BookMeta, candidates: PageCandidate[], known: Set<string>,
  settings: Settings, position: ReaderPosition | null, startIndex: number
): Promise<ViewResult> {
  const key = positionKey(position);
  let primary = '';
  let stored = 0;
  let index = startIndex;
  let offset = 0;
  const split: SplitMode = !meta.split ? 'off' : meta.splitByGutter ? 'gutter' : 'aspect';

  for (const candidate of candidates.slice(0, MAX_SPREAD)) {
    let views: RegionView[] = [];
    try {
      views = await viewsOf(candidate.element, split);
    } catch (error) {
      console.warn('Could not read a rendered page', error);
    }

    for (const view of views) {
      const isPrimary = offset === 0;
      if (isPrimary) primary = view.signature ?? '';

      if (view.signature && known.has(view.signature)) {
        offset += 1;
        continue;
      }

      let image: CapturedPage | null = null;
      try {
        image = await renderRegion(candidate.element, view.region, settings.quality);
      } catch (error) {
        console.warn('Could not copy a rendered page', error);
      }
      if (!image) {
        offset += 1;
        continue;
      }

      const identity = view.signature ?? fingerprintOf(image.dataUrl, image.width, image.height);
      if (isPrimary) primary = identity;

      if (!known.has(identity)) {
        known.add(identity);
        await storePage(meta, {
          index,
          position: isPrimary ? key : '',
          fingerprint: identity,
          page: position?.kind === 'page' ? position.value + offset : null
        }, image);
        index += 1;
        stored += 1;
      }
      offset += 1;
    }
  }

  return { primary, stored };
}

async function performScan(book: string, options: ScanOptions | undefined): Promise<void> {
  const settings = settingsFrom(options);
  // Published so retune() can move the pacing under the loop while it waits.
  live = settings;
  const meta = await loadMeta(book);
  prepareBookMode(meta, settings);
  const known = new Set(meta.captures.map((capture) => capture.fingerprint).filter(Boolean));
  const startCount = meta.captures.length;
  const prober = turnProber(meta.turnStrategy);
  const revisited = revisitWatch();

  let index = nextIndex(meta);
  let iterations = 0;
  let unmoved = 0;
  let sinceFlush = 0;
  let lastView = '';
  let outcome = '';

  const flush = async (): Promise<void> => {
    sinceFlush = 0;
    await saveMeta(meta);
  };

  while (!stopRequested && iterations < MAX_ITERATIONS) {
    iterations += 1;
    await wait(jitteredDelay(settings.delay * SETTLE_RATIO, settings.jitter));

    if (bookId() !== book) {
      outcome = `The reader moved to another book. ${meta.captures.length} pages stay cached.`;
      break;
    }

    const position = readerPosition();
    if (position) {
      meta.total = position.total;
      meta.kind = position.kind;
    }

    const candidates = pageCandidates();
    if (!candidates.length) {
      unmoved += 1;
      if (unmoved >= STALL_LIMIT) {
        outcome = meta.captures.length
          ? `No page is rendered any more. ${meta.captures.length} pages stay cached.`
          : 'No rendered page found. Open a book and try again.';
        break;
      }
      notify('Waiting for a rendered page…');
      continue;
    }

    const result = await captureRendered(meta, candidates, known, settings, position, index);
    index += result.stored;
    sinceFlush += result.stored;
    if (sinceFlush >= META_FLUSH_EVERY) await flush();

    // Movement is decided by the hash, never by the position counter: the
    // counter skips and repeats as the reader reflows for the window width, and
    // a stale repeat used to make the scan skip a view that had in fact moved.
    const moved = result.primary !== '' && result.primary !== lastView;
    if (result.primary) lastView = result.primary;

    // Checked before the stall counter: a reader going in circles is still
    // "moving", so unmoved would sit at 0 and never end the scan.
    if (revisited.saw(result.primary)) {
      outcome = `The reader stopped reaching new pages. ${plural(meta.captures.length, 'page')} cached.`;
      break;
    }

    unmoved = moved ? 0 : unmoved + 1;
    if (unmoved >= prober.stallBudget(STALL_LIMIT)) {
      outcome = prober.probing
        ? `None of the page-turn methods moved the reader. ${plural(meta.captures.length, 'page')} cached. Click once inside the book, then scan again.`
        : `The reader stopped advancing. ${meta.captures.length} pages cached.`;
      break;
    }

    if (moved) {
      const settled = prober.settle();
      if (settled) {
        meta.turnStrategy = settled;
        await flush();
      }
    }

    const skipped = result.stored === 0 ? ' · nothing new on this view' : '';
    // Approximate even for a page counter: the reader repaginates for the
    // window size, so the total is not a fixed property of the book.
    const outOf = meta.kind === 'page' && meta.total ? ` of ~${meta.total}` : '';
    notify(`Cached ${meta.captures.length}${outOf} pages${skipped}`);

    if (position && position.value >= position.total) break;

    const tried = prober.turn();
    if (!tried) {
      outcome = 'None of the page-turn methods moved the reader. Click once inside the book, then scan again.';
      break;
    }
    if (prober.probing) notify(`Trying page turn: ${tried}…`);
    await wait(jitteredDelay(settings.delay, settings.jitter));
  }

  if (!outcome && iterations >= MAX_ITERATIONS) {
    outcome = `Stopped after ${MAX_ITERATIONS} iterations · ${meta.captures.length} pages cached.`;
  }
  if (!outcome) {
    const added = meta.captures.length - startCount;
    outcome = added
      ? `Scan stopped with ${meta.captures.length} pages cached (${added} new). Use “Save cached pages as PDF” when ready.`
      : `No new pages captured · ${meta.captures.length} already cached.`;
  }

  await flush();
  notify(outcome);
  removeNoticeLater();
}

export async function scan(book: string, options: ScanOptions | undefined): Promise<void> {
  running = true;
  stopRequested = false;
  try {
    await performScan(book, options);
  } finally {
    // Storage and DOM operations can reject. Never make a transient failure
    // permanently block scan, clear, and retry until the reader tab is reloaded.
    running = false;
    live = null;
  }
}
