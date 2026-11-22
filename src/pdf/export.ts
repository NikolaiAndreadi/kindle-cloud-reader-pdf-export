import {
  BITMAP_BATCH, loadMeta, loadOcrBatch, loadPageBatch, ocrInBatches, pagesInBatches
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
  fileName?: string;
}

const MAX_BASE_BYTES = 150; // Leaves room for "-text.pdf" within a 255-byte filename.
const RESERVED = '<>:"/\\|?*';

export function cleanFileName(name: string): string {
  const replaced = [...name]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || RESERVED.includes(ch) ? ' ' : ch))
    .join('');
  const cleaned = replaced
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const encoder = new TextEncoder();
  let base = '';
  let bytes = 0;
  for (const ch of cleaned) {
    bytes += encoder.encode(ch).length;
    if (bytes > MAX_BASE_BYTES) break;
    base += ch;
  }
  return base.replace(/[.\s]+$/g, '');
}

export const defaultFileName = (book: string, date: string): string => `kindle-${book}-${date}`;

export function pdfFileName(book: string, mode: PdfMode, name: string | undefined, date: string): string {
  const suffix = mode === 'text' ? '-text' : '';
  const custom = cleanFileName(name ?? '');
  return custom ? `${custom}${suffix}.pdf` : `kindle-${book}${suffix}-${date}.pdf`;
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
  download(builder.finish(), pdfFileName(book, mode, options.fileName, date));

  const notes = [`${paperLabel(options.paper)} pages`];
  // In text mode the count is worth giving even when it is low: the pages it
  // leaves out are blank ones, and that is the thing to explain.
  if (mode === 'text') {
    notes.push(`${builder.textPages} with recognised text`);
    if (builder.imagePages) notes.push(`${plural(builder.imagePages, 'page')} kept as pictures`);
  } else if (builder.textPages) notes.push(`${builder.textPages} with searchable text`);
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
      const written = builder.addPage(
        { width: page.width, height: page.height, bytes },
        usable ? words.words : undefined
      );
      if (!written) unreadable += 1;
    }
    builder.flush();
    report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
  }
  return { unreadable };
}

const sizeOf = (record: { width: number; height: number } | undefined): PdfPage | undefined =>
  record?.width && record.height ? { width: record.width, height: record.height } : undefined;

// Preserve page numbering even when OCR has no words for a sheet.
async function writeTextPages(
  book: string, meta: BookMeta, builder: PdfBuilder, report: (text: string) => void
): Promise<WriteResult> {
  let recognised = 0;
  let unreadable = 0;
  let previous: PdfPage | undefined;
  // Leading blank sheets use the first known page size.
  let waiting = 0;

  for await (const batch of ocrInBatches(book, meta.captures, BITMAP_BATCH)) {
    // Pages without OCR still need their own size: split mode and window resizes
    // make sizes vary per page, so a neighbour's could turn a sheet sideways.
    const wanted = batch
      .filter(({ capture, ocr }) => capture.asImage || !sizeOf(ocr))
      .map(({ capture }) => capture);
    const pages = wanted.length ? await loadPageBatch(book, wanted) : undefined;

    for (const { capture, ocr } of batch) {
      // A record with no dimensions cannot place its own boxes, so it is no
      // better than no record at all.
      const measured = sizeOf(ocr) ? ocr : undefined;
      const stored = pages?.get(capture.index);
      const size = sizeOf(measured) ?? sizeOf(stored);
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

      const bytes = capture.asImage && stored?.dataUrl && sizeOf(stored)
        ? bytesFromDataUrl(stored.dataUrl) ?? undefined
        : undefined;
      const placeable = bytes
        ? measured?.width === stored?.width && measured?.height === stored?.height
        : true;

      previous = bytes ? sizeOf(stored) ?? size : size;
      for (; waiting > 0; waiting--) builder.addPage(previous);
      const imagesBefore = builder.imagePages;
      builder.addPage(bytes ? { ...previous, bytes } : previous,
        placeable ? measured?.words : undefined);
      if (measured) recognised += 1;
      if (capture.asImage && builder.imagePages === imagesBefore) unreadable += 1;
    }
    builder.flush();
    report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
  }

  if (!recognised) {
    return { blocked: 'No recognised text in this book yet — run "Add searchable text (OCR)" first.' };
  }
  return { unreadable };
}
