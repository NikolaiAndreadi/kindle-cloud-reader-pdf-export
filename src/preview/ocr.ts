import { runOcr } from '../ocr/run.ts';
import { message, plural, ui } from './elements.ts';
import type { PreviewGrid } from './grid.ts';

/**
 * OCR runs on the preview page rather than in the reader tab or the popup: it
 * needs the wasm engine, which an extension page may load and a content script
 * may not, and it needs somewhere that stays open for the twenty minutes a book
 * takes — which a popup does not.
 */
export class OcrController {
  private readonly book: string;
  private readonly grid: PreviewGrid;
  private running = false;
  private stopRequested = false;

  /** Clearing the book underneath a run would delete the pages it is reading. */
  onBusy: (busy: boolean) => void = () => {};

  constructor(book: string, grid: PreviewGrid) {
    this.book = book;
    this.grid = grid;
    ui.ocrStart.addEventListener('click', () => void this.start());
    ui.ocrStop.addEventListener('click', () => {
      this.stopRequested = true;
      ui.ocrStop.disabled = true;
    });
    // Closing the tab kills the worker mid-page and that page is simply not
    // stored. Warning about it is more use than trying to save it.
    addEventListener('beforeunload', (event) => {
      if (!this.running) return;
      event.preventDefault();
    });
  }

  describe(): void {
    if (this.running) return;
    const total = this.grid.captures.length;
    if (!total) {
      ui.ocrStatus.textContent = '';
      ui.ocrStart.disabled = true;
      return;
    }
    const done = this.grid.recognisedCount();
    ui.ocrStart.disabled = done === total;
    ui.ocrStatus.textContent = done === total
      ? `All ${plural(total, 'page')} carry searchable text.`
      : `${done} of ${total} pages have a text layer · the PDF gets one wherever it exists.`;
  }

  private async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onBusy(true);
    this.stopRequested = false;
    ui.ocrStart.hidden = true;
    ui.ocrStop.hidden = false;
    ui.ocrStop.disabled = false;
    ui.ocrStatus.textContent = 'Starting…';

    let outcome = '';
    try {
      const result = await runOcr(this.book, {
        onProgress: (progress) => {
          if (progress.index !== undefined) this.grid.markRecognised(progress.index);
          ui.ocrStatus.textContent = progress.status
            ? `${progress.status}…`
            : `Reading page ${progress.done} of ${progress.total}${
              this.stopRequested ? ' · stopping after this page' : ''}`;
        },
        shouldStop: () => this.stopRequested
      });
      const skipped = result.skipped ? `, ${plural(result.skipped, 'page')} skipped` : '';
      outcome = result.stopped
        ? `Stopped after ${plural(result.recognised, 'page')}${skipped}. Start again to carry on.`
        : `Finished — ${plural(result.recognised, 'page')} recognised${skipped}.`;
    } catch (error) {
      outcome = `OCR failed: ${message(error)}`;
    } finally {
      this.running = false;
      this.onBusy(false);
      ui.ocrStart.hidden = false;
      ui.ocrStop.hidden = true;
      try {
        await this.grid.refreshRecognised();
      } catch (error) {
        // Appended rather than assigned: how the run itself ended is the part
        // worth reading, and a failed recount does not change it.
        outcome += ` (the page count could not be refreshed: ${message(error)})`;
      }
      // After the refresh, not before: it rewrites this line from the counts,
      // which would erase the one thing worth reading here.
      if (outcome) ui.ocrStatus.textContent = outcome;
    }
  }
}
