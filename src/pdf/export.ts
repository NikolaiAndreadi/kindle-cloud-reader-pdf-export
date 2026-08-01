import { loadMeta, pagesInBatches } from '../shared/storage.ts';
import { notify, removeNoticeLater } from '../content/notice.ts';
import { bytesFromDataUrl, pdfBuilder } from './builder.ts';

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

export async function saveCachedPdf(book: string): Promise<ReaderMessage> {
  const meta = await loadMeta(book);
  if (!meta.captures.length) return { message: 'No saved pages for this book.' };

  notify(`Loading ${plural(meta.captures.length, 'cached page')}…`);
  const builder = pdfBuilder();
  let unreadable = 0;

  for await (const batch of pagesInBatches(book, meta.captures)) {
    for (const { page } of batch) {
      const bytes = page?.dataUrl ? bytesFromDataUrl(page.dataUrl) : null;
      if (!bytes || !page?.width || !page.height) {
        unreadable += 1;
        continue;
      }
      builder.addImage({ width: page.width, height: page.height, bytes });
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

  const note = unreadable ? ` ${plural(unreadable, 'page')} could not be read.` : '';
  const message = `Saved ${builder.pages} pages as PDF.${note}`;
  notify(message);
  removeNoticeLater();
  return { message };
}
