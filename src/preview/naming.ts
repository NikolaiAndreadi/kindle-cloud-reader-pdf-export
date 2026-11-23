import { pdfFileName } from '../pdf/export.ts';
import { loadFileName, saveFileName } from '../shared/storage.ts';
import { ui } from './elements.ts';

export function bindNaming(book: string, showError: (error: unknown) => void): () => Promise<string> {
  const local = chrome.storage.local;
  const templateKey = 'filenameTemplate';
  const metadataKey = `book:${book}:libraryNames`;
  const fields: [HTMLInputElement, string][] = [
    [ui.template, templateKey], [ui.bookTitle, `book:${book}:title`], [ui.author, `book:${book}:author`]
  ];
  let detected: BookNames = { title: '', author: '' };
  const edited = new Set<HTMLInputElement>();

  function name(): string {
    const tokens = { asin: book, title: ui.bookTitle.value || detected.title, author: ui.author.value || detected.author };
    return ui.fileName.value.trim() || ui.template.value.replace(/\{(asin|title|author)\}/g,
      (_, key: keyof typeof tokens) => tokens[key]);
  }

  function render(): void {
    ui.bookTitle.placeholder = detected.title;
    ui.author.placeholder = detected.author;
    const date = new Date().toISOString().slice(0, 10);
    const scan = pdfFileName(book, 'scan', name(), date);
    ui.fileName.placeholder = scan.slice(0, -4);
    ui.names.textContent = `Scan: ${scan} · Text: ${pdfFileName(book, 'text', name(), date)}`;
  }

  function bind(input: HTMLInputElement, write: (value: string) => Promise<void>): void {
    input.addEventListener('input', () => {
      edited.add(input);
      render();
      void write(input.value).catch(showError);
    });
  }
  bind(ui.fileName, (value) => saveFileName(book, value));
  for (const [input, key] of fields) {
    bind(input, (value) => value ? local.set({ [key]: value }) : local.remove(key));
  }

  const ready = Promise.all([
    loadFileName(book), local.get([metadataKey, ...fields.map(([, key]) => key)])
  ]).then(([override, stored]) => {
    if (!edited.has(ui.fileName)) ui.fileName.value = override;
    for (const [input, key] of fields) {
      if (!edited.has(input) && typeof stored[key] === 'string') input.value = stored[key];
    }
    const cached = stored[metadataKey];
    if (typeof cached?.title === 'string' && typeof cached.author === 'string') detected = cached;
    render();
  }).catch(showError);

  let pending: Promise<void> | undefined;
  async function lookup(): Promise<void> {
    await ready;
    const tab = Number(new URLSearchParams(location.search).get('readerTab'));
    if (!tab || (detected.title && detected.author)) return;
    pending ??= chrome.tabs.sendMessage<ReaderRequest, BookNames | ReaderFailure>(tab, { action: 'bookNames', asin: book })
      .then(async (result) => {
        if (!result || 'error' in result || (!result.title && !result.author)) return;
        detected = { title: result.title || detected.title, author: result.author || detected.author };
        render();
        await local.set({ [metadataKey]: detected });
      }).catch(() => { /* The reader may have closed. Manual fields remain available. */ });
    await pending;
  }

  ui.naming.addEventListener('toggle', () => { if (ui.naming.open) void lookup(); });
  const needsLookup = () => !ui.fileName.value.trim() && /\{(title|author)\}/.test(ui.template.value);
  void ready.then(() => { if (needsLookup()) void lookup(); });
  return async () => {
    await ready;
    if (needsLookup()) await lookup();
    return name();
  };
}
