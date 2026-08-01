import { scanRunning } from '../shared/scanning.ts';
import {
  deleteCapture, fingerprintCounts, recognisedIndexes, reorderCaptures
} from '../shared/storage.ts';
import { message, plural, span, ui } from './elements.ts';

/** How long a delete button stays armed before it goes back to being safe. */
const ARM_MS = 3000;
const LOCK_TEXT = 'A scan is running — reordering and deleting are paused until it finishes.';

interface Tile {
  figure: HTMLElement;
  /** The caption's left span, rewritten when duplicate status changes. */
  label: HTMLSpanElement;
  /** Caption text without the duplicate marker. */
  text: string;
  /** Says "text" once this page has an OCR layer stored. */
  mark: HTMLSpanElement;
  remove: HTMLButtonElement;
  fingerprint: string;
}

export class PreviewGrid {
  private readonly book: string;
  private records: CaptureRecord[] = [];
  private total: number | null = null;
  private readonly tiles = new Map<number, Tile>();
  private recognised = new Set<number>();
  private armed: HTMLButtonElement | null = null;
  private armTimer = 0;
  private dragged: HTMLElement | null = null;
  private editLocked = false;

  onChange: () => void = () => {};

  constructor(book: string) {
    this.book = book;
    ui.lock.textContent = LOCK_TEXT;
    ui.viewer.addEventListener('click', () => ui.viewer.close());
    this.bindDragging();
  }

  get captures(): readonly CaptureRecord[] {
    return this.records;
  }

  get locked(): boolean {
    return this.editLocked;
  }

  recognisedCount(): number {
    return this.records.filter((capture) => this.recognised.has(capture.index)).length;
  }

  showMessage(text: string): void {
    this.tiles.clear();
    this.records = [];
    this.recognised.clear();
    ui.summary.textContent = text;
    ui.grid.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'empty', textContent: text
    }));
    this.onChange();
  }

  showError(error: unknown): void {
    ui.summary.textContent = message(error);
  }

  setMeta(meta: BookMeta): void {
    this.records = meta.captures;
    this.total = meta.total;
    this.refresh();
  }

  clearTiles(): void {
    this.tiles.clear();
    ui.grid.replaceChildren();
  }

  append(capture: CaptureRecord, page: StoredPage | undefined): void {
    ui.grid.append(this.createTile(capture, page));
  }

  async refreshRecognised(): Promise<void> {
    this.recognised = await recognisedIndexes(this.book, this.records);
    this.refresh();
  }

  markRecognised(index: number): void {
    this.recognised.add(index);
    const tile = this.tiles.get(index);
    if (tile) tile.mark.textContent = 'text';
  }

  setLocked(value: boolean): void {
    if (this.editLocked === value) return;
    this.editLocked = value;
    ui.lock.hidden = !value;
    ui.grid.classList.toggle('locked', value);
    this.disarm();
    for (const tile of this.tiles.values()) {
      tile.figure.draggable = !value;
      tile.remove.disabled = value;
    }
  }

  /**
   * Redraw everything that depends on the set of captures rather than on one
   * page: the summary line and the repeat markers, both of which change when a
   * page is deleted.
   */
  refresh(): void {
    const counts = fingerprintCounts(this.records);
    let duplicates = 0;
    for (const count of counts.values()) duplicates += count - 1;

    for (const [index, tile] of this.tiles) {
      const repeated = (counts.get(tile.fingerprint) || 0) > 1;
      tile.figure.classList.toggle('dupe', repeated);
      tile.label.textContent = tile.text + (repeated ? ' · repeat' : '');
      tile.mark.textContent = this.recognised.has(index) ? 'text' : '';
    }

    // Built from nodes rather than innerHTML: this is an extension page, so
    // anything injected here would run with extension privileges.
    ui.summary.replaceChildren(span(plural(this.records.length, 'page')));
    if (this.total) ui.summary.append(span(` of about ${this.total}`));
    if (duplicates) {
      ui.summary.append(span(' · '), span(plural(duplicates, 'duplicate'), 'warn'));
    }
    ui.summary.append(span(' · drag to reorder · the PDF follows this order'));
    this.onChange();
  }

  private openViewer(dataUrl: string, label: string): void {
    ui.viewerImage.src = dataUrl;
    ui.viewerImage.alt = label;
    ui.viewer.showModal();
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed.classList.remove('armed');
    this.armed.textContent = '×';
    this.armed = null;
    clearTimeout(this.armTimer);
  }

  private arm(button: HTMLButtonElement): void {
    this.disarm();
    this.armed = button;
    button.classList.add('armed');
    button.textContent = 'Delete?';
    this.armTimer = window.setTimeout(() => this.disarm(), ARM_MS);
  }

  /**
   * Whether this page may write to the index right now. Asked immediately before
   * every edit rather than trusting the poll: a scan started in the last couple
   * of seconds would otherwise swallow the edit at its next flush, silently.
   */
  private async mayEdit(): Promise<boolean> {
    const running = await scanRunning(this.book);
    this.setLocked(running);
    return !running;
  }

  /**
   * Deleting a page cannot be undone short of scanning it again, so the first
   * click only arms the button. Same idea as holding "Clear this book" in the
   * popup, scaled down to one page.
   */
  private deleteButton(index: number, figure: HTMLElement): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'del';
    button.textContent = '×';
    button.title = `Delete capture #${index}`;
    button.setAttribute('aria-label', `Delete capture #${index}`);
    button.disabled = this.editLocked;

    button.addEventListener('click', () => void this.delete(index, figure, button));
    return button;
  }

  private async delete(
    index: number, figure: HTMLElement, button: HTMLButtonElement
  ): Promise<void> {
    if (this.armed !== button) {
      this.arm(button);
      return;
    }
    this.disarm();
    button.disabled = true;
    try {
      // Refused means a scan just started, and the lock it turned on has already
      // disabled this button — re-enabling it unconditionally would undo that.
      if (!await this.mayEdit()) {
        button.disabled = this.editLocked;
        return;
      }
      const meta = await deleteCapture(this.book, index);
      this.records = meta.captures;
      this.tiles.delete(index);
      figure.remove();
      if (!this.records.length) this.showMessage('Nothing cached for this book yet.');
      else this.refresh();
    } catch (error) {
      button.disabled = this.editLocked;
      this.showError(error);
    }
  }

  private createTile(capture: CaptureRecord, page: StoredPage | undefined): HTMLElement {
    const figure = document.createElement('figure');
    figure.draggable = !this.editLocked;
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
      image.addEventListener('click', () => this.openViewer(page.dataUrl, text));
      figure.append(image);
      caption.append(label, span(`${page.width}×${page.height}`));
    } else {
      figure.classList.add('gone');
      label.textContent = `${text} — missing from storage`;
      caption.append(label);
    }

    const mark = span(this.recognised.has(capture.index) ? 'text' : '', 'text');
    const remove = this.deleteButton(capture.index, figure);
    caption.append(mark, remove);
    figure.append(caption);
    this.tiles.set(capture.index, {
      figure, label, text, mark, remove, fingerprint: capture.fingerprint
    });
    return figure;
  }

  private shownOrder(): number[] {
    return [...ui.grid.children]
      .map((node) => Number((node as HTMLElement).dataset.index))
      .filter((index) => Number.isFinite(index) && index > 0);
  }

  /** Put the tiles back in stored order, after an edit that was refused. */
  private restoreOrder(): void {
    for (const capture of this.records) {
      const tile = this.tiles.get(capture.index);
      if (tile) ui.grid.append(tile.figure);
    }
  }

  private async persistOrder(): Promise<void> {
    const order = this.shownOrder();
    // Pages still loading are not in the grid yet, so compare against the tiles
    // that exist rather than against the whole index.
    if (order.every((index, at) => this.records[at]?.index === index)) return;
    if (!await this.mayEdit()) {
      this.restoreOrder();
      return;
    }
    const meta = await reorderCaptures(this.book, order);
    this.records = meta.captures;
    this.refresh();
  }

  private bindDragging(): void {
    ui.grid.addEventListener('dragstart', (event) => {
      const figure = (event.target as HTMLElement | null)?.closest('figure');
      // draggable is already off while locked; this is the backstop for a drag
      // that began just before a scan started.
      if (!figure || this.editLocked) {
        event.preventDefault();
        return;
      }
      this.disarm();
      this.dragged = figure;
      figure.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', figure.dataset.index ?? '');
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });

    // The tile follows the pointer as it moves, so what the grid shows on drop is
    // what gets written. No separate drop-target highlight to keep in step.
    ui.grid.addEventListener('dragover', (event) => {
      if (!this.dragged) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const over = (event.target as HTMLElement | null)?.closest('figure');
      if (!over || over === this.dragged) return;
      const box = over.getBoundingClientRect();
      const after = event.clientX > box.left + box.width / 2;
      ui.grid.insertBefore(this.dragged, after ? over.nextSibling : over);
    });

    ui.grid.addEventListener('drop', (event) => event.preventDefault());
    // dragend rather than drop: a drag cancelled with Escape or released outside
    // the grid still leaves the tile where the user last saw it, and the stored
    // order should agree with the screen.
    ui.grid.addEventListener('dragend', () => {
      this.dragged?.classList.remove('dragging');
      this.dragged = null;
      void this.persistOrder().catch((error) => {
        this.restoreOrder();
        this.showError(error);
      });
    });
  }
}
