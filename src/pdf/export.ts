import {
  loadMeta, loadOcrBatch, loadPageBatch, ocrInBatches, pagesInBatches
} from '../shared/storage.ts';
import { bytesFromDataUrl, pdfBuilder } from './builder.ts';
import { paperLabel } from './paper.ts';

const REVOKE_AFTER_MS = 60000;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

export interface SaveOptions {
  paper: PaperName;
  /** Which of the two exports the preview page asked for — one button each. */
  mode: PdfMode;
}

/** What a writer has to say afterwards, beyond the pages it handed the builder. */
interface WriteResult {
  /** Set when nothing could be written and the reason is worth saying. */
  blocked?: string;
  /** Pages whose bitmap was missing or unreadable. */
  unreadable?: number;
}

/**
 * Reading a book back out of storage and encoding it takes long enough to need
 * saying so. Where that is said is the caller's business — this runs on the
 * preview page now, which has a status line of its own.
 */
export async function saveCachedPdf(
  book: string, options: SaveOptions, report: (text: string) => void
): Promise<ReaderMessage> {
  const meta = await loadMeta(book);
  if (!meta.captures.length) return { message: 'No saved pages for this book.' };

  const mode = options.mode;
  report(`Loading ${plural(meta.captures.length, 'cached page')}…`);
  const builder = pdfBuilder({ paper: options.paper, mode });

  const written = mode === 'text'
    ? await writeTextPages(book, meta, builder, report)
    : await writeScannedPages(book, meta, builder, report);
  if (written.blocked) return { message: written.blocked };

  if (!builder.pages) {
    return { message: 'Saved pages could not be read back from storage.' };
  }

  const date = new Date().toISOString().slice(0, 10);
  download(builder.finish(), `kindle-${book}${mode === 'text' ? '-text' : ''}-${date}.pdf`);

  const notes = [`${paperLabel(options.paper)} pages`];
  // In text mode the count is worth giving even when it is low: the pages it
  // leaves out are blank ones, and that is the thing to explain.
  if (mode === 'text') notes.push(`${builder.textPages} with recognised text`);
  else if (builder.textPages) notes.push(`${builder.textPages} with searchable text`);
  if (written.unreadable) notes.push(`${plural(written.unreadable, 'page')} could not be read`);
  // Returned rather than reported: this is the outcome, and it should stay on
  // screen after the progress line it replaces has stopped changing.
  return { message: `Saved ${builder.pages} pages as PDF · ${notes.join(' · ')}.` };
}

/** The photograph of each page, with the invisible text layer where there is one. */
async function writeScannedPages(
  book: string, meta: BookMeta, builder: PdfBuilder, report: (text: string) => void
): Promise<WriteResult> {
  let unreadable = 0;

  for await (const batch of pagesInBatches(book, meta.captures)) {
    // One extra read per batch rather than per page, and only the words for the
    // pages about to be written, so a book's OCR never lands on the heap at once.
    const ocr = await loadOcrBatch(book, batch.map(({ capture }) => capture));
    for (const { capture, page } of batch) {
      const bytes = page?.dataUrl ? bytesFromDataUrl(page.dataUrl) : null;
      if (!bytes || !page?.width || !page.height) {
        unreadable += 1;
        continue;
      }
      const words = ocr.get(capture.index);
      // Boxes measured on a differently-sized bitmap would land in the wrong
      // place, which is worse than having no text layer on that page.
      const usable = words && words.width === page.width && words.height === page.height;
      builder.addPage(
        { width: page.width, height: page.height, bytes },
        usable ? words.words : undefined
      );
    }
    builder.flush();
    report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
  }
  return { unreadable };
}

const sizeOf = (record: { width: number; height: number } | undefined): PdfPage | undefined =>
  record?.width && record.height ? { width: record.width, height: record.height } : undefined;

/**
 * The words alone, on empty sheets. Bitmaps are read only for the pages that
 * have no words, which is most of why this export is both quicker and a fraction
 * of the size — and why it can only carry what OCR has been over. A recognised
 * page that came out with no words, and a page that was never recognised at all,
 * both become a blank sheet rather than disappearing: page numbering is the one
 * thing a reader can check against the book.
 */
async function writeTextPages(
  book: string, meta: BookMeta, builder: PdfBuilder, report: (text: string) => void
): Promise<WriteResult> {
  let recognised = 0;
  let unreadable = 0;
  /**
   * The last size seen, for a page that has neither words nor a stored bitmap to
   * be measured from. Nothing else knows how big it was — the index records the
   * capture, not its dimensions — so a neighbour is the only answer available.
   */
  let previous: PdfPage | undefined;
  /**
   * Blank pages held back because nothing has reported a size yet. Only the run
   * of them before the first measurable page: after that `previous` answers.
   */
  let waiting = 0;

  for await (const batch of ocrInBatches(book, meta.captures)) {
    // A capture size is per page, not per book: split mode leaves a landscape
    // spread landscape, and the reader repaints at whatever size the window is
    // when a later session resumes. Borrowing a neighbour's dimensions for a
    // blank page would turn the sheet sideways on native paper, so the page's
    // own record is read where OCR cannot say — for the blanks alone, since
    // their data URLs are the weight this export exists to avoid.
    const blanks = batch.filter(({ ocr }) => !sizeOf(ocr)).map(({ capture }) => capture);
    const pages = blanks.length ? await loadPageBatch(book, blanks) : undefined;

    for (const { capture, ocr } of batch) {
      // A record with no dimensions cannot place its own boxes, so it is no
      // better than no record at all.
      const measured = sizeOf(ocr) ? ocr : undefined;
      const size = sizeOf(measured) ?? sizeOf(pages?.get(capture.index));
      if (!size) {
        // Neither words nor a bitmap: the page is gone from storage. It still
        // gets a sheet, at whatever size its neighbours were.
        unreadable += 1;
        if (!previous) {
          waiting += 1;
          continue;
        }
        builder.addPage(previous);
        continue;
      }

      previous = size;
      for (; waiting > 0; waiting--) builder.addPage(size);
      builder.addPage(size, measured?.words);
      if (measured) recognised += 1;
    }
    builder.flush();
    report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
  }

  if (!recognised) {
    return { blocked: 'No recognised text in this book yet — run "Add searchable text (OCR)" first.' };
  }
  // Only reachable if every page was missing from storage, which the check above
  // has already turned away — but the sheets are owed either way.
  for (; waiting > 0 && previous; waiting--) builder.addPage(previous);
  return { unreadable };
}
