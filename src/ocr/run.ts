// Driving OCR across a whole book: which pages still need it, one recogniser
// for all of them, and a result written to storage as each page finishes.
//
// Deliberately resumable and interruptible. A 400-page book is ten minutes of
// work, the tab it runs in can be closed at any moment, and a page whose words
// are already stored is never recognised twice.

import { loadMeta, pagesInBatches, recognisedIndexes, storeOcr } from '../shared/storage.ts';
import { type Recogniser, createRecogniser } from './engine.ts';

export interface OcrRunOptions {
  /** Called before each page and after each result. */
  onProgress: (progress: OcrProgress) => void;
  /** Checked between pages, so a stop takes effect within one page. */
  shouldStop: () => boolean;
  /**
   * How to start the engine. Defaults to the real one; the seam exists because
   * the engine needs a browser and the loop around it — what gets picked up, what
   * is only tried once, when a stop lands — is worth testing without one.
   */
  open?: (onLoad: (status: string) => void) => Promise<Recogniser>;
}

export interface OcrProgress {
  done: number;
  total: number;
  /** Capture index just finished, so the caller can mark that page alone. */
  index?: number;
  /** What the engine is doing, when it has said. */
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

/** Recognise every capture of this book that has no text layer yet. */
export async function runOcr(book: string, options: OcrRunOptions): Promise<OcrRunResult> {
  const result: OcrRunResult = { recognised: 0, skipped: 0, stopped: false };
  const attempted = new Set<number>();

  let pending = await pendingCaptures(book, attempted);
  // Before the engine is loaded: nothing to do should cost nothing.
  if (!pending.length) return result;

  options.onProgress({ done: 0, total: pending.length, status: 'loading the OCR engine' });
  const recogniser = await (options.open ?? createRecogniser)((status) => {
    options.onProgress({ done: 0, total: pending.length, status });
  });

  try {
    while (pending.length && !result.stopped) {
      // Fixed for the round, so the count does not jump about while pages a scan
      // appended are being taken on.
      const total = result.recognised + result.skipped + pending.length;

      for await (const batch of pagesInBatches(book, pending)) {
        if (result.stopped) break;
        for (const { capture, page } of batch) {
          if (options.shouldStop()) {
            result.stopped = true;
            break;
          }
          attempted.add(capture.index);
          if (!page?.dataUrl || !page.width || !page.height) {
            result.skipped += 1;
            continue;
          }
          const { words, confidence } = await recogniser.page(page.dataUrl, page.width, page.height);
          // A page with no words at all — a plate, a chapter break — is still
          // stored, empty. Otherwise every run would try it again forever.
          await storeOcr(book, capture, {
            index: capture.index, width: page.width, height: page.height, words, confidence
          });
          result.recognised += 1;
          options.onProgress({
            done: result.recognised + result.skipped, total, index: capture.index
          });
        }
      }

      if (result.stopped) break;
      pending = await pendingCaptures(book, attempted);
    }
  } finally {
    await recogniser.close();
  }

  return result;
}
