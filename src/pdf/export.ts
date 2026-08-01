import { loadMeta, loadOcrBatch, pagesInBatches } from '../shared/storage.ts';
import { notify, removeNoticeLater } from '../content/notice.ts';
import { bytesFromDataUrl, pdfBuilder } from './builder.ts';
import { DEFAULT_PAPER, paperLabel } from './paper.ts';

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

export async function saveCachedPdf(book: string, paper = DEFAULT_PAPER): Promise<ReaderMessage> {
  const meta = await loadMeta(book);
  if (!meta.captures.length) return { message: 'No saved pages for this book.' };

  notify(`Loading ${plural(meta.captures.length, 'cached page')}…`);
  const builder = pdfBuilder({ paper });
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
      builder.addImage(
        { width: page.width, height: page.height, bytes },
        usable ? words.words : undefined
      );
    }
    builder.flush();
    notify(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
  }

  if (!builder.pages) {
    const message = 'Saved pages could not be read back from storage.';
    notify(message);
    removeNoticeLater();
    return { message };
  }

  const date = new Date().toISOString().slice(0, 10);
  download(builder.finish(), `kindle-${book}-${date}.pdf`);

  const notes = [`${paperLabel(paper)} pages`];
  if (builder.textPages) notes.push(`${builder.textPages} with searchable text`);
  if (unreadable) notes.push(`${plural(unreadable, 'page')} could not be read`);
  const message = `Saved ${builder.pages} pages as PDF · ${notes.join(' · ')}.`;
  notify(message);
  removeNoticeLater();
  return { message };
}
