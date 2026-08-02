// Driving OCR across a whole book: which pages still need it, a small pool of
// recognisers to read them, and a result written to storage as each page finishes.
//
// Deliberately resumable and interruptible. A 400-page book is ten minutes of
// work, the tab it runs in can be closed at any moment, and a page whose words
// are already stored is never recognised twice.

import {
  flagPictureCapture, loadMeta, pagesInBatches, recognisedIndexes, storeOcr
} from '../shared/storage.ts';
import { type Recogniser, createRecogniser } from './engine.ts';
import { looksLikePicture } from './picture.ts';

/**
 * How many pages are read at once.
 *
 * A lane is a whole Tesseract worker, with its own wasm core and its own copy of
 * the language data, so each one costs tens of megabytes and buys most of a core.
 * Recognising is almost all wasm — the page a lane decodes and draws on the main
 * thread first is a few milliseconds against a second and a half — so two lanes
 * do come close to twice the work. Two rather than navigator.hardwareConcurrency
 * because the machine is usually also rendering the reader tab this cache came
 * from, and because the gain past the second lane is not worth the memory.
 */
export const LANES = 2;

export interface OcrRunOptions {
  /** Called before each page and after each result. */
  onProgress: (progress: OcrProgress) => void;
  /** Checked before each page, so a stop lands within one page per lane. */
  shouldStop: () => boolean;
  /**
   * How to start one lane's engine. Defaults to the real one; the seam exists
   * because the engine needs a browser and the loop around it — what gets picked
   * up, what is only tried once, when a stop lands — is worth testing without one.
   */
  open?: (onLoad: (status: string) => void) => Promise<Recogniser>;
}

export interface OcrProgress {
  done: number;
  total: number;
  /** Capture index just finished, so the caller can mark that page alone. */
  index?: number;
  /**
   * What the engine is doing while it starts up, and only then. It goes on
   * reporting itself for the rest of the run — 'recognizing text', once per page
   * and then repeatedly within it — but by that point the page count is the more
   * useful thing to say, and a caller showing both in one line would only see
   * this one.
   */
  status?: string;
}

export interface OcrRunResult {
  recognised: number;
  skipped: number;
  stopped: boolean;
}

/**
 * Captures with no text layer yet, ignoring any this run has already had a go at.
 *
 * Re-read rather than computed once: OCR runs for minutes, and a scan in the
 * reader tab may append pages the whole time. `attempted` is what stops a page
 * that cannot be recognised — one whose image is missing, say — from coming back
 * round for ever, since nothing was stored for it to mark it done.
 */
async function pendingCaptures(book: string, attempted: Set<number>): Promise<CaptureRecord[]> {
  const meta = await loadMeta(book);
  const already = await recognisedIndexes(book, meta.captures);
  return meta.captures.filter(
    (capture) => !already.has(capture.index) && !attempted.has(capture.index)
  );
}

/**
 * Start every lane, or none of them.
 *
 * Promise.all would leave a loaded worker with nobody holding it when its sibling
 * failed, and a Tesseract worker keeps its wasm heap until something terminates
 * it. Only the first lane's loading messages are passed on: both report the same
 * few steps over the same local files, and two interleaved copies read as noise.
 */
async function openLanes(
  count: number,
  open: (onLoad: (status: string) => void) => Promise<Recogniser>,
  onLoad: (status: string) => void
): Promise<Recogniser[]> {
  const started = await Promise.allSettled(
    Array.from({ length: count }, (_, lane) => open(lane === 0 ? onLoad : () => {}))
  );
  const ready = started.flatMap((lane) => lane.status === 'fulfilled' ? [lane.value] : []);
  const failed = started.find((lane) => lane.status === 'rejected');
  if (failed) {
    // Nothing useful to do about a close that also fails: the throw below is what
    // the caller needs to hear.
    await Promise.all(ready.map((recogniser) => recogniser.close().catch(() => {})));
    throw failed.reason;
  }
  return ready;
}

/** Recognise every capture of this book that has no text layer yet. */
export async function runOcr(book: string, options: OcrRunOptions): Promise<OcrRunResult> {
  const result: OcrRunResult = { recognised: 0, skipped: 0, stopped: false };
  const attempted = new Set<number>();

  let pending = await pendingCaptures(book, attempted);
  // Before the engine is loaded: nothing to do should cost nothing.
  if (!pending.length) return result;

  options.onProgress({ done: 0, total: pending.length, status: 'loading the OCR engine' });
  // The lane's logger is fitted for the whole of its life and cannot be taken off,
  // so the gate is here: see OcrProgress.status.
  let loading = true;
  const recognisers = await openLanes(LANES, options.open ?? createRecogniser, (status) => {
    if (loading) options.onProgress({ done: 0, total: pending.length, status });
  });
  loading = false;

  /**
   * The first error a lane hit, rethrown once every lane has come to rest. Held
   * rather than propagated so the other lanes stop taking pages on, and so the
   * page one of them is part-way through is not abandoned with its worker being
   * terminated underneath it.
   */
  let failure: unknown;

  try {
    while (pending.length && !result.stopped && !failure) {
      // Fixed for the round, so the count does not jump about while pages a scan
      // appended are being taken on.
      const total = result.recognised + result.skipped + pending.length;

      for await (const batch of pagesInBatches(book, pending)) {
        if (result.stopped || failure) break;

        // Lanes pull from a shared cursor rather than being dealt a slice each: a
        // capture whose image is missing costs nothing to skip, so a fixed split
        // would leave one worker idle for the rest of the batch. Handing out the
        // next item is synchronous, which is all the mutual exclusion this needs.
        let cursor = 0;
        await Promise.all(recognisers.map(async (recogniser) => {
          while (cursor < batch.length && !result.stopped && !failure) {
            if (options.shouldStop()) {
              result.stopped = true;
              return;
            }
            const item = batch[cursor++];
            // Cannot happen after the bound check above; the index signature does
            // not know that, and taking the lane out is the harmless reading.
            if (!item) break;
            const { capture, page } = item;
            attempted.add(capture.index);
            if (!page?.dataUrl || !page.width || !page.height) {
              result.skipped += 1;
              continue;
            }
            try {
              const { words, confidence, picture } =
                await recogniser.page(page.dataUrl, page.width, page.height);
              // A page with no words at all — a plate, a chapter break — is still
              // stored, empty. Otherwise every run would try it again forever.
              await storeOcr(book, capture, {
                index: capture.index,
                width: page.width, height: page.height,
                words, confidence, picture
              });
              // Second write, and only for the pages that need it: a page whose
              // ink the words do not account for is one the text export should
              // keep as a bitmap, and the index is where that has to be said.
              if (looksLikePicture(picture)) await flagPictureCapture(book, capture);
            } catch (error) {
              failure ??= error;
              return;
            }
            result.recognised += 1;
            options.onProgress({
              done: result.recognised + result.skipped, total, index: capture.index
            });
          }
        }));
      }

      if (result.stopped || failure) break;
      pending = await pendingCaptures(book, attempted);
    }
  } finally {
    await Promise.all(recognisers.map((recogniser) => recogniser.close()));
  }

  if (failure) throw failure;
  return result;
}
