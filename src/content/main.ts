import { clearBook, countDuplicates, loadMeta, recognisedIndexes } from '../shared/storage.ts';
import { saveCachedPdf } from '../pdf/export.ts';
import { bookId, pageCandidates, readerPosition } from './dom.ts';
import { notify, removeNoticeLater } from './notice.ts';
import { isRunning, requestStop, retune, scan } from './scan.ts';

async function bookState(book: string): Promise<BookState> {
  const meta = await loadMeta(book);
  const position = readerPosition();
  // One query: each call may walk shadow roots and same-origin iframes.
  const candidates = pageCandidates();
  // A "Location 4879 of 4879" book has no page count, and reporting locations
  // as pages would be nonsense, so a total is only offered for page counters.
  const kind = meta.kind ?? position?.kind ?? null;
  // Keys only, so this stays a cheap thing to ask once a second.
  const recognised = await recognisedIndexes(book, meta.captures);

  return {
    bookId: meta.bookId,
    bookOpen: candidates.length > 0,
    scanning: isRunning(),
    count: meta.captures.length,
    total: kind === 'page' ? (meta.total ?? position?.total ?? null) : null,
    kind,
    position,
    duplicates: countDuplicates(meta.captures),
    recognised: recognised.size,
    split: meta.split,
    quality: meta.quality
  };
}

async function clearCached(book: string): Promise<ReaderMessage> {
  if (isRunning()) return { message: 'Stop the scan before clearing this book.' };
  const cleared = await clearBook(book);
  const message = `Cleared ${cleared} saved pages.`;
  notify(message);
  removeNoticeLater();
  return { message };
}

function startScan(book: string, options: ScanOptions | undefined): ReaderMessage {
  if (isRunning()) return { message: 'A scan is already running.' };
  scan(book, options).catch((error: Error) => {
    notify(`Scan failed: ${error.message}`);
    removeNoticeLater();
  });
  return { message: 'Scan started. Watch the status in the reader tab.' };
}

chrome.runtime.onMessage.addListener((
  request: ReaderRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: ReaderMessage | BookState | ReaderFailure) => void
): boolean => {
  const book = bookId();

  switch (request.action) {
    case 'startScan':
      sendResponse(startScan(book, request.options));
      return false;

    case 'retune':
      sendResponse({
        message: retune(request.options) ? 'Pacing updated.' : 'No scan is running.'
      });
      return false;

    case 'stopScan':
      requestStop();
      sendResponse({ message: isRunning() ? 'Stopping…' : 'No scan is running.' });
      return false;

    case 'getState':
      bookState(book).then(sendResponse, (error: Error) => sendResponse({ error: error.message }));
      return true;

    case 'saveCached':
      saveCachedPdf(book, request.paper).then(sendResponse, (error: Error) => sendResponse({ error: `Save failed: ${error.message}` }));
      return true;

    case 'clearCached':
      clearCached(book).then(sendResponse, (error: Error) => sendResponse({ error: `Clear failed: ${error.message}` }));
      return true;

    default:
      sendResponse({ error: `Unknown action: ${(request as { action: string }).action}` });
      return false;
  }
});
