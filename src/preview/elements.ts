// preview.html is checked in alongside this file, so a missing id is a broken
// build rather than a runtime state worth handling everywhere it is read.
function required<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element: #${id}`);
  return node as T;
}

export const ui = {
  grid: required('grid'),
  summary: required('summary'),
  title: required('title'),
  lock: required('lock'),
  viewer: required<HTMLDialogElement>('viewer'),
  viewerImage: required<HTMLImageElement>('viewer-image'),
  ocrStart: required<HTMLButtonElement>('ocrStart'),
  ocrStop: required<HTMLButtonElement>('ocrStop'),
  ocrStatus: required('ocrStatus'),
  paper: required<HTMLSelectElement>('paper'),
  naming: required<HTMLDetailsElement>('naming'),
  template: required<HTMLInputElement>('template'),
  bookTitle: required<HTMLInputElement>('bookTitle'),
  author: required<HTMLInputElement>('author'),
  names: required('names'),
  fileName: required<HTMLInputElement>('fileName'),
  save: required<HTMLButtonElement>('save'),
  saveText: required<HTMLButtonElement>('saveText'),
  saveStatus: required('saveStatus'),
  clear: required<HTMLButtonElement>('clear')
};

/** Said wherever a book turns out to have no pages: on load, and after a clear. */
export const EMPTY_TEXT = 'Nothing captured for this book yet.';

export const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function span(text: string, className?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
