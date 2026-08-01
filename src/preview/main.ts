import { fingerprintCounts, loadMeta, pagesInBatches } from '../shared/storage.ts';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const grid = el('grid');
const summary = el('summary');
const title = el('title');
const viewer = el<HTMLDialogElement>('viewer');
const viewerImage = el<HTMLImageElement>('viewer-image');

const book = new URLSearchParams(location.search).get('book') || '';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const span = (text: string, className?: string): HTMLSpanElement => {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
};

function openViewer(dataUrl: string, label: string): void {
  viewerImage.src = dataUrl;
  viewerImage.alt = label;
  viewer.showModal();
}

function message(text: string): void {
  summary.textContent = text;
  grid.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'empty', textContent: text
  }));
}

function describeCache(captures: CaptureRecord[], total: number | null, duplicates: number): void {
  // Built from nodes rather than innerHTML: this is an extension page, so
  // anything injected here would run with extension privileges.
  summary.replaceChildren(span(plural(captures.length, 'page')));
  if (total) summary.append(span(` of about ${total}`));
  if (duplicates) summary.append(span(' · '), span(plural(duplicates, 'duplicate'), 'warn'));
  summary.append(span(' · newest last'));
}

function tile(capture: CaptureRecord, page: StoredPage | undefined, repeated: boolean): HTMLElement {
  const figure = document.createElement('figure');
  if (repeated) figure.className = 'dupe';

  if (!page?.dataUrl) {
    const caption = document.createElement('figcaption');
    caption.textContent = `#${capture.index} — missing from storage`;
    figure.append(caption);
    return figure;
  }

  const label = `#${capture.index}${page.page ? ` · page ${page.page}` : ''}`;
  const image = document.createElement('img');
  image.src = page.dataUrl;
  image.loading = 'lazy';
  image.alt = label;
  image.addEventListener('click', () => openViewer(page.dataUrl, label));

  const caption = document.createElement('figcaption');
  caption.append(
    span(label + (repeated ? ' · repeat' : '')),
    span(`${page.width}×${page.height}`)
  );

  figure.append(image, caption);
  return figure;
}

async function load(): Promise<void> {
  title.textContent = `Captured pages · ${book}`;
  if (!book) {
    message('No book specified.');
    return;
  }

  const meta = await loadMeta(book);
  if (!meta.captures.length) {
    message('Nothing cached for this book yet.');
    return;
  }

  const counts = fingerprintCounts(meta.captures);
  const duplicates = [...counts.values()].reduce((total, n) => total + (n - 1), 0);
  describeCache(meta.captures, meta.total, duplicates);

  for await (const batch of pagesInBatches(book, meta.captures)) {
    grid.append(...batch.map(({ capture, page }) =>
      tile(capture, page, (counts.get(capture.fingerprint) || 0) > 1)
    ));
  }
}

void load();
