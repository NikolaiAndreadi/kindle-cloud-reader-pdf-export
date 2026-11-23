import { countDuplicates, loadMeta, recognisedIndexes } from '../shared/storage.ts';
import { acquireBookScan, releaseBookScan } from '../shared/scan-lock.ts';
import { bookId, pageCandidates, readerPosition } from './dom.ts';
import { lookupBookNames } from './library.ts';
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

/**
 * Held from the moment a start is accepted until scan() has set its own flag.
 * isRunning() alone cannot close the gap: acquiring the lock is a round trip to
 * the service worker, and a double-click sends two requests that both pass the
 * check while the first is still waiting for its answer.
 */
let starting = false;

async function startScan(book: string, options: ScanOptions | undefined): Promise<ReaderMessage> {
  if (starting || isRunning()) return { message: 'A scan is already running.' };
  starting = true;
  try {
    const token = crypto.randomUUID();
    if (!await acquireBookScan(book, token)) {
      return { message: 'This book is already being scanned in another reader tab.' };
    }
    // scan() sets isRunning() synchronously, before `starting` is dropped below.
    void scan(book, options)
      .catch((error: Error) => {
        notify(`Scan failed: ${error.message}`);
        removeNoticeLater();
      })
      .finally(() => releaseBookScan(book, token).catch((error) => {
        console.warn('Could not release the scan lock', error);
      }));
    return { message: 'Scan started. Watch the status in the reader tab.' };
  } finally {
    starting = false;
  }
}

chrome.runtime.onMessage.addListener((
  request: ReaderRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: ReaderMessage | BookState | BookNames | ReaderFailure) => void
): boolean => {
  const book = bookId();

  switch (request.action) {
    case 'bookNames':
      if (request.asin !== book) {
        sendResponse({ error: 'The open book changed.' });
        return false;
      }
      lookupBookNames(book).then(sendResponse, () => sendResponse({ title: '', author: '' }));
      return true;

    case 'startScan':
      startScan(book, request.options).then(
        sendResponse,
        (error: Error) => sendResponse({ error: `Scan could not start: ${error.message}` })
      );
      return true;

    case 'retune':
      sendResponse({
        message: retune(request.options) ? 'Pacing updated.' : 'No scan is running.'
      });
      return false;

    case 'stopScan':
      requestStop();
      sendResponse({
        message: isRunning() ? 'Stopping after the current page…' : 'No scan is running.'
      });
      return false;

    case 'getState':
      bookState(book).then(sendResponse, (error: Error) => sendResponse({ error: error.message }));
      return true;

    default:
      sendResponse({ error: `Unknown action: ${(request as { action: string }).action}` });
      return false;
  }
});
