import { META_FLUSH_EVERY, loadMeta, nextIndex, saveMeta, storePage } from '../shared/storage.ts';
import { bookId, pageCandidates, positionKey, readerPosition } from './dom.ts';
import { fingerprintOf, renderRegion, viewsOf } from './capture.ts';
import { notify, removeNoticeLater } from './notice.ts';
import { turnProber } from './turning.ts';

const STALL_LIMIT = 3;
const MAX_ITERATIONS = 10000;
const MAX_SPREAD = 4;

const DELAY_MIN = 400;
const DELAY_DEFAULT = 1100;
const QUALITY_MIN = .6;
const QUALITY_MAX = .98;
const QUALITY_DEFAULT = .88;

// How much of the configured delay to wait before looking at the page, as
// opposed to after turning it.
const SETTLE_RATIO = .7;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

let running = false;
let stopRequested = false;

export const isRunning = (): boolean => running;

export function requestStop(): void {
  stopRequested = true;
}

interface Settings {
  delay: number;
  quality: number;
  split: boolean;
}

function settingsFrom(options: ScanOptions | undefined): Settings {
  return {
    delay: Math.max(DELAY_MIN, Number(options?.delay) || DELAY_DEFAULT),
    quality: Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Number(options?.quality) || QUALITY_DEFAULT)),
    split: options?.split !== false
  };
}

interface ViewResult {
  /** Identity of the first region of the first candidate, '' if unreadable. */
  primary: string;
  stored: number;
}

/**
 * Capture everything rendered right now. Regions already in `known` are skipped
 * before encoding, so resuming a book costs a downscale per view rather than a
 * full JPEG encode.
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

  for (const candidate of candidates.slice(0, MAX_SPREAD)) {
    let views: RegionView[] = [];
    try {
      views = await viewsOf(candidate.element, settings.split);
    } catch (error) {
      console.warn('Could not read a rendered page', error);
    }

    for (const view of views) {
      const isPrimary = offset === 0;
      if (isPrimary) primary = view.signature ?? '';

      // Hashing the source pixels is cheap, so a view already captured costs
      // nothing: the full JPEG encode only happens for something new.
      if (view.signature && known.has(view.signature)) {
        offset += 1;
        continue;
      }

      let image: CapturedPage | null = null;
      try {
        image = renderRegion(candidate.element, view.region, settings.quality);
      } catch (error) {
        console.warn('Could not copy a rendered page', error);
      }
      if (!image) {
        offset += 1;
        continue;
      }

      // Falls back to hashing the JPEG when the source cannot be read back.
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

export async function scan(book: string, options: ScanOptions | undefined): Promise<void> {
  running = true;
  stopRequested = false;

  const settings = settingsFrom(options);
  const meta = await loadMeta(book);
  const known = new Set(meta.captures.map((capture) => capture.fingerprint).filter(Boolean));
  const startCount = meta.captures.length;
  const prober = turnProber(meta.turnStrategy);

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
    await wait(Math.round(settings.delay * SETTLE_RATIO));

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

    // The counter is recorded for display only. It skips and repeats as the
    // reader reflows for the window width, so it decides nothing here: a stale
    // repeat used to make the scan skip a view that had in fact moved on.
    const result = await captureRendered(meta, candidates, known, settings, position, index);
    index += result.stored;
    sinceFlush += result.stored;
    if (sinceFlush >= META_FLUSH_EVERY) await flush();

    // Identical pixels are the only trustworthy evidence that the reader did
    // not turn, so movement is decided by the hash rather than the counter.
    const moved = result.primary !== '' && result.primary !== lastView;
    if (result.primary) lastView = result.primary;

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

    const where = position ? ` · reader at ${position.kind} ${position.value} of ${position.total}` : '';
    const skipped = result.stored === 0 ? ' · nothing new on this view' : '';
    // Only a page counter gives a meaningful "of N pages".
    const outOf = meta.kind === 'page' && meta.total ? ` of ~${meta.total}` : '';
    notify(`Cached ${meta.captures.length}${outOf} pages${where}${skipped}`);

    if (position && position.value >= position.total) break;

    const tried = prober.turn();
    if (!tried) {
      outcome = 'None of the page-turn methods moved the reader. Click once inside the book, then scan again.';
      break;
    }
    if (prober.probing) notify(`Trying page turn: ${tried}…`);
    await wait(settings.delay);
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
  running = false;
  removeNoticeLater();
}
