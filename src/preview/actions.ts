import { bindHoldToDelete } from '../shared/hold-to-delete.ts';
import { defaultFileName, saveCachedPdf } from '../pdf/export.ts';
import { DEFAULT_PAPER, isPaperName } from '../pdf/paper.ts';
import { scanRunning } from '../shared/scanning.ts';
import { clearBook, loadFileName, loadPaper, saveFileName, savePaper } from '../shared/storage.ts';
import { message, plural, ui } from './elements.ts';
import type { PreviewGrid } from './grid.ts';

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
    bindHoldToDelete(ui.clear, () => {
      void this.clear().catch((error) => {
        ui.saveStatus.textContent = `Clear failed: ${message(error)}`;
      });
    });

    void loadPaper().then((paper) => {
      ui.paper.value = paper;
    });
    ui.paper.addEventListener('change', () => {
      if (isPaperName(ui.paper.value)) void savePaper(ui.paper.value);
    });

    ui.fileName.placeholder = defaultFileName(book, new Date().toISOString().slice(0, 10));
    let nameEdited = false;
    void loadFileName(book).then((name) => {
      if (!nameEdited) ui.fileName.value = name;
    });
    ui.fileName.addEventListener('input', () => {
      nameEdited = true;
      void saveFileName(book, ui.fileName.value).catch((error) => grid.showError(error));
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
      const fileName = ui.fileName.value;
      const result = await saveCachedPdf(this.book, { paper, mode, fileName }, (text) => {
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
    this.grid.showEmpty();
  }
}
