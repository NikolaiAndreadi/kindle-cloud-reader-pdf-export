import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { cleanFileName, pdfFileName, saveCachedPdf } from '../../src/pdf/export.ts';
import { metaKey, ocrKey, pageKey } from '../../src/shared/storage.ts';

/**
 * The exporter is the one module that reads storage and writes a file, so both
 * ends are faked here: chrome.storage.local as elsewhere, and just enough of the
 * download path to get the Blob back instead of handing it to a browser.
 */
function harness() {
  const data = new Map<string, unknown>();
  const local = {
    get: async (keys: string | string[] | null) => {
      if (keys === null) return Object.fromEntries(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(
        list.filter((key) => data.has(key)).map((key) => [key, data.get(key)])
      );
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    getKeys: async () => [...data.keys()],
    remove: async (keys: string[]) => {
      for (const key of keys) data.delete(key);
    }
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };

  const saved: { blob?: Blob; filename?: string } = {};
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      href: '',
      set download(name: string) {
        saved.filename = name;
      },
      click: () => {}
    })
  };
  URL.createObjectURL = (blob: Blob): string => {
    saved.blob = blob;
    return 'blob:test';
  };
  URL.revokeObjectURL = (): void => {};

  // Every export leaves a minute-long timer behind to revoke the object URL. In
  // a browser that outlives nothing; here it would hold the process open until
  // it fired, so the handles are unreferenced as they are made.
  const scheduled = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof scheduled>) => {
    const timer = scheduled(...args);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }) as typeof scheduled;

  return { data, saved };
}

const BOOK = 'B00TEST';

const capture = (index: number): CaptureRecord =>
  ({ index, position: '', fingerprint: `fp-${index}`, page: index });

const meta = (count: number): BookMeta => ({
  version: 2,
  bookId: BOOK,
  captures: Array.from({ length: count }, (_, i) => capture(i + 1)),
  total: count,
  kind: 'page',
  split: false,
  quality: .8,
  turnStrategy: null
});

const page = (index: number, width: number, height: number): StoredPage =>
  ({ index, page: index, width, height, dataUrl: 'data:image/jpeg;base64,/9j/4A==' });

const recognised = (index: number, width: number, height: number): StoredOcr => ({
  index,
  width,
  height,
  words: [{ t: 'word', x0: 10, y0: 10, x1: 90, y1: 30, b: 28, s: 20 }],
  confidence: 90
});

const body = async (blob: Blob | undefined): Promise<string> =>
  new TextDecoder('latin1').decode(new Uint8Array(await blob!.arrayBuffer()));

const mediaBoxes = (pdf: string): string[] =>
  [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${m[1]}x${m[2]}`);

describe('saveCachedPdf in text mode', () => {
  let store: ReturnType<typeof harness>;
  beforeEach(() => {
    store = harness();
  });

  const put = (key: string, value: unknown): void => {
    store.data.set(key, value);
  };

  it('sizes a page with no words from its own bitmap, not from its neighbours', async () => {
    // Split mode off, so a spread stays landscape: one book, two orientations.
    put(metaKey(BOOK), meta(3));
    put(pageKey(BOOK, 1), page(1, 800, 1200));
    put(pageKey(BOOK, 2), page(2, 1600, 900));
    put(pageKey(BOOK, 3), page(3, 800, 1200));
    // The first page is a cover: stored, but OCR found nothing to store for it.
    put(ocrKey(BOOK, 2, 'fp-2'), recognised(2, 1600, 900));
    put(ocrKey(BOOK, 3, 'fp-3'), recognised(3, 800, 1200));

    await saveCachedPdf(BOOK, { paper: 'native', mode: 'text' }, () => {});
    // 612 * 1200/800 and 612 * 900/1600: the blank cover keeps its own portrait
    // shape rather than turning sideways with the spread that follows it.
    assert.deepEqual(mediaBoxes(await body(store.saved.blob)), [
      '612.00x918.00', '612.00x344.25', '612.00x918.00'
    ]);
  });

  it('keeps an unrecognised page as a blank sheet, so the numbering holds', async () => {
    put(metaKey(BOOK), meta(3));
    for (let i = 1; i <= 3; i++) put(pageKey(BOOK, i), page(i, 800, 1200));
    put(ocrKey(BOOK, 2, 'fp-2'), recognised(2, 800, 1200));

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    const pdf = await body(store.saved.blob);
    assert.equal(mediaBoxes(pdf).length, 3);
    assert.equal(pdf.match(/\(word\) Tj/g)?.length, 1);
    assert.match(result.message, /Saved 3 pages/);
    assert.match(result.message, /1 with recognised text/);
  });

  it('falls back to a neighbour only when the page itself is gone from storage', async () => {
    put(metaKey(BOOK), meta(2));
    put(pageKey(BOOK, 2), page(2, 1600, 900));
    put(ocrKey(BOOK, 2, 'fp-2'), recognised(2, 1600, 900));

    const result = await saveCachedPdf(BOOK, { paper: 'native', mode: 'text' }, () => {});
    assert.deepEqual(mediaBoxes(await body(store.saved.blob)), [
      '612.00x344.25', '612.00x344.25'
    ]);
    assert.match(result.message, /1 page could not be read/);
  });

  it('reads no page bitmap at all when every page has been recognised', async () => {
    put(metaKey(BOOK), meta(2));
    for (let i = 1; i <= 2; i++) put(ocrKey(BOOK, i, `fp-${i}`), recognised(i, 800, 1200));
    // No page records stored: a text export that needed them would find nothing.
    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    assert.match(result.message, /Saved 2 pages/);
    assert.ok(!(await body(store.saved.blob)).includes('/DCTDecode'));
  });

  it('says what to do rather than writing a book of blank sheets', async () => {
    put(metaKey(BOOK), meta(2));
    for (let i = 1; i <= 2; i++) put(pageKey(BOOK, i), page(i, 800, 1200));

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    assert.match(result.message, /run "Add searchable text \(OCR\)" first/);
    assert.equal(store.saved.blob, undefined);
  });

  it('keeps a flagged page as its bitmap, with the words hidden over it', async () => {
    const flagged = meta(2);
    flagged.captures[1]!.asImage = true;
    put(metaKey(BOOK), flagged);
    for (let i = 1; i <= 2; i++) put(pageKey(BOOK, i), page(i, 800, 1200));
    for (let i = 1; i <= 2; i++) put(ocrKey(BOOK, i, `fp-${i}`), recognised(i, 800, 1200));

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    const pdf = await body(store.saved.blob);
    // One bitmap, for the flagged page alone; the other page is still vector.
    assert.equal(pdf.match(/\/DCTDecode/g)?.length, 1);
    assert.ok(pdf.includes('0 Tr'), 'the unflagged page is painted');
    assert.ok(pdf.includes('3 Tr'), 'the picture page keeps an invisible layer');
    assert.match(result.message, /1 page kept as pictures/);
  });

  it('reads no bitmap for a page that is not flagged, however large the book', async () => {
    put(metaKey(BOOK), meta(2));
    for (let i = 1; i <= 2; i++) put(pageKey(BOOK, i), page(i, 800, 1200));
    for (let i = 1; i <= 2; i++) put(ocrKey(BOOK, i, `fp-${i}`), recognised(i, 800, 1200));

    await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    assert.ok(!(await body(store.saved.blob)).includes('/DCTDecode'));
  });

  it('falls back to type when a flagged page has lost its bitmap', async () => {
    const flagged = meta(1);
    flagged.captures[0]!.asImage = true;
    put(metaKey(BOOK), flagged);
    put(ocrKey(BOOK, 1, 'fp-1'), recognised(1, 800, 1200));

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    const pdf = await body(store.saved.blob);
    assert.ok(!pdf.includes('/DCTDecode'));
    assert.ok(pdf.includes('(word) Tj'), 'the words are still worth having');
    assert.match(result.message, /1 page could not be read/);
  });

  it('reports a rejected picture while preserving its blank sheet', async () => {
    const flagged = meta(2);
    flagged.captures[1]!.asImage = true;
    put(metaKey(BOOK), flagged);
    put(ocrKey(BOOK, 1, 'fp-1'), recognised(1, 800, 1200));
    put(pageKey(BOOK, 2), { ...page(2, 800, 1200), dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    assert.equal(mediaBoxes(await body(store.saved.blob)).length, 2);
    assert.match(result.message, /1 page could not be read/);
  });

  it('names the file apart from the scanned export', async () => {
    put(metaKey(BOOK), meta(1));
    put(ocrKey(BOOK, 1, 'fp-1'), recognised(1, 800, 1200));
    await saveCachedPdf(BOOK, { paper: 'a4', mode: 'text' }, () => {});
    assert.match(store.saved.filename ?? '', /^kindle-B00TEST-text-\d{4}-\d\d-\d\d\.pdf$/);
  });
});

describe('saveCachedPdf in scan mode', () => {
  let store: ReturnType<typeof harness>;
  beforeEach(() => {
    store = harness();
  });

  it('still writes every bitmap, with the text layer only where there is one', async () => {
    store.data.set(metaKey(BOOK), meta(2));
    for (let i = 1; i <= 2; i++) store.data.set(pageKey(BOOK, i), page(i, 800, 1200));
    store.data.set(ocrKey(BOOK, 1, 'fp-1'), recognised(1, 800, 1200));

    const result = await saveCachedPdf(BOOK, { paper: 'a4', mode: 'scan' }, () => {});
    const pdf = await body(store.saved.blob);
    assert.equal(pdf.match(/\/DCTDecode/g)?.length, 2);
    assert.equal(pdf.match(/\(word\) Tj/g)?.length, 1);
    assert.ok(pdf.includes('3 Tr'));
    assert.match(result.message, /1 with searchable text/);
    assert.match(store.saved.filename ?? '', /^kindle-B00TEST-\d{4}-\d\d-\d\d\.pdf$/);
  });

  it('drops the words when they were measured on a differently sized bitmap', async () => {
    store.data.set(metaKey(BOOK), meta(1));
    store.data.set(pageKey(BOOK, 1), page(1, 800, 1200));
    store.data.set(ocrKey(BOOK, 1, 'fp-1'), recognised(1, 1600, 2400));

    await saveCachedPdf(BOOK, { paper: 'a4', mode: 'scan' }, () => {});
    assert.ok(!(await body(store.saved.blob)).includes('(word) Tj'));
  });
});

describe('pdf file names', () => {
  it('keeps the default when nothing usable was typed', () => {
    assert.equal(pdfFileName(BOOK, 'scan', undefined, '2026-11-22'), 'kindle-B00TEST-2026-11-22.pdf');
    assert.equal(pdfFileName(BOOK, 'text', '  ', '2026-11-22'), 'kindle-B00TEST-text-2026-11-22.pdf');
    assert.equal(pdfFileName(BOOK, 'scan', '???', '2026-11-22'), 'kindle-B00TEST-2026-11-22.pdf');
  });

  it('uses a typed name, with the text suffix where it applies', () => {
    assert.equal(pdfFileName(BOOK, 'scan', 'Moby Dick', '2026-11-22'), 'Moby Dick.pdf');
    assert.equal(pdfFileName(BOOK, 'text', 'Moby Dick.pdf', '2026-11-22'), 'Moby Dick-text.pdf');
  });

  it('makes a name safe to save under', () => {
    assert.equal(cleanFileName('  Author: Title / Vol. 2?  '), 'Author Title Vol. 2');
    assert.equal(cleanFileName('..hidden.'), 'hidden');
    assert.equal(cleanFileName('a\u0000b\tc'), 'a b c');
    assert.equal(cleanFileName('Ünïcödé — 書名'), 'Ünïcödé — 書名');
    assert.equal(cleanFileName('x'.repeat(400)).length, 150);
    assert.equal(cleanFileName(`${'x'.repeat(149)}📚`), 'x'.repeat(149));
    assert.equal(cleanFileName('書'.repeat(100)), '書'.repeat(50));
  });

  it('saves under the name it is given', async () => {
    const store = harness();
    store.data.set(metaKey(BOOK), meta(1));
    store.data.set(pageKey(BOOK, 1), page(1, 800, 1200));
    await saveCachedPdf(BOOK, { paper: 'a4', mode: 'scan', fileName: 'My Book' }, () => {});
    assert.equal(store.saved.filename, 'My Book.pdf');
  });
});
