import { saveCachedPdf } from '../pdf/export.ts';
import { DEFAULT_PAPER, isPaperName } from '../pdf/paper.ts';
import { scanRunning } from '../shared/scanning.ts';
import { clearBook, loadPaper, savePaper } from '../shared/storage.ts';
import { EMPTY_TEXT, message, plural, ui } from './elements.ts';
import type { PreviewGrid } from './grid.ts';

/** How long "Clear this book" is held before it fires. */
const HOLD_MS = 2000;

/**
 * Writing the PDF and clearing the book both act on the whole cache, so they
 * live here rather than in the popup: the pages are on this page, in the order
 * the export will use, and a popup closes the moment attention moves elsewhere —
 * halfway through encoding a 300-page book, in the case of the export.
 */
export class BookActions {
  private readonly book: string;
  private readonly grid: PreviewGrid;
  private saving = false;
  private ocrBusy = false;

  constructor(book: string, grid: PreviewGrid) {
    this.book = book;
    this.grid = grid;

    ui.save.addEventListener('click', () => void this.save('scan'));
    ui.saveText.addEventListener('click', () => void this.save('text'));
    this.bindHold();

    void loadPaper().then((paper) => {
      ui.paper.value = paper;
    });
    ui.paper.addEventListener('change', () => {
      if (isPaperName(ui.paper.value)) void savePaper(ui.paper.value);
    });

    // An export interrupted halfway leaves no file and no sign of why.
    addEventListener('beforeunload', (event) => {
      if (this.saving) event.preventDefault();
    });

    // The markup cannot know whether this book has any pages, and a Save PDF
    // that is live before the grid has loaded would export nothing.
    this.describe();
  }

  /** Told by the OCR controller, which owns the other long job on this page. */
  setOcrBusy(busy: boolean): void {
    this.ocrBusy = busy;
    this.describe();
  }

  /**
   * Called on every grid change as well as at the ends of both long jobs, so the
   * two buttons always agree with what there is to act on. Clearing is held to a
   * stricter rule than saving: reading the cache while a scan appends to it is
   * merely incomplete, while deleting it underneath a scan or an OCR run breaks
   * the job that is running.
   */
  describe(): void {
    const empty = !this.grid.captures.length;
    ui.save.disabled = empty || this.saving;
    // The text PDF is made of the OCR and nothing else, so it has nothing to
    // write until some page has been recognised. Said on the button rather than
    // after the click, since the run it asks for takes minutes.
    const recognised = this.grid.recognisedCount();
    const pictures = this.grid.imageCount();
    ui.saveText.disabled = empty || this.saving || !recognised;
    ui.saveText.title = recognised
      ? `Vector text from ${plural(recognised, 'recognised page')}${
        pictures ? `, keeping ${plural(pictures, 'page')} as images` : ' — no page images'}.`
      : 'Add searchable text (OCR) first: a text PDF is made of the recognised words.';
    ui.clear.disabled = empty || this.saving || this.ocrBusy || this.grid.locked;
  }

  private async save(mode: PdfMode): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.describe();
    try {
      const paper = isPaperName(ui.paper.value) ? ui.paper.value : DEFAULT_PAPER;
      const result = await saveCachedPdf(this.book, { paper, mode }, (text) => {
        ui.saveStatus.textContent = text;
      });
      ui.saveStatus.textContent = result.message;
    } catch (error) {
      ui.saveStatus.textContent = `Save failed: ${message(error)}`;
    } finally {
      this.saving = false;
      this.describe();
    }
  }

  private async clear(): Promise<void> {
    ui.saveStatus.textContent = '';
    // Asked immediately rather than trusting the two-second poll behind
    // grid.locked: a scan started a moment ago is still writing pages, and the
    // ones it writes after the sweep would survive as an unreachable remainder.
    if (await scanRunning(this.book)) {
      this.grid.setLocked(true);
      this.describe();
      return;
    }
    await clearBook(this.book);
    // The same empty state the page shows for a book with nothing in it: the
    // grid going empty is the confirmation, and a count of what was just
    // deliberately deleted is not news.
    this.grid.showMessage(EMPTY_TEXT);
  }

  /**
   * Clearing is the only irreversible thing here, so it is held rather than
   * clicked: a confirm() dialog is dismissed by reflex, and it asks the question
   * somewhere other than where the action was taken. The button fills as it is
   * held so the wait reads as progress rather than a dead press.
   */
  private bindHold(): void {
    // The CSS transition reads this back, so the duration is set once here.
    ui.clear.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Dropping the class leaves no transition on the way back, so the bar
      // empties at once and a cancelled hold never looks like a partial one.
      ui.clear.classList.remove('holding');
    };

    const start = (): void => {
      if (timer !== undefined || ui.clear.disabled) return;
      ui.clear.classList.add('holding');
      timer = setTimeout(() => {
        reset();
        // A poll may have disabled the button mid-hold, e.g. a scan just started
        // in the reader tab. Whatever the state says now wins.
        if (ui.clear.disabled) return;
        void this.clear().catch((error) => {
          ui.saveStatus.textContent = `Clear failed: ${message(error)}`;
        });
      }, HOLD_MS);
    };

    // Nothing is said about a hold that was let go: the label already asks for
    // one, and the bar emptying is the answer.
    const cancel = reset;

    ui.clear.addEventListener('pointerdown', start);
    // Sliding off the button is the other half of how people back out of a hold.
    for (const event of ['pointerup', 'pointerleave', 'pointercancel']) {
      ui.clear.addEventListener(event, cancel);
    }
    // Nothing would end the hold if the window lost focus mid-press.
    addEventListener('blur', cancel);

    // A button that only responds to pointers cannot be reached by keyboard.
    ui.clear.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') start();
    });
    ui.clear.addEventListener('keyup', cancel);
  }
}
