"use strict";
(() => {
  // src/shared/storage.ts
  var READ_BATCH = 20;
  var metaKey = (book2) => `book:${book2}:meta`;
  var pageKey = (book2, index) => `book:${book2}:page:${String(index).padStart(6, "0")}`;
  var emptyMeta = (book2) => ({
    version: 2,
    bookId: book2,
    captures: [],
    total: null,
    kind: null,
    split: null,
    turnStrategy: null
  });
  async function loadMeta(book2) {
    const key = metaKey(book2);
    const stored = await chrome.storage.local.get(key);
    const raw = stored[key];
    if (raw?.version === 2 && Array.isArray(raw.captures)) {
      return {
        ...raw,
        split: typeof raw.split === "boolean" ? raw.split : null
      };
    }
    return emptyMeta(book2);
  }
  async function* pagesInBatches(book2, captures, size = READ_BATCH) {
    for (let start = 0; start < captures.length; start += size) {
      const batch = captures.slice(start, start + size);
      const stored = await chrome.storage.local.get(batch.map((c) => pageKey(book2, c.index)));
      yield batch.map((capture) => ({
        capture,
        page: stored[pageKey(book2, capture.index)]
      }));
    }
  }
  function fingerprintCounts(captures) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/preview/main.ts
  var el = (id) => document.getElementById(id);
  var grid = el("grid");
  var summary = el("summary");
  var title = el("title");
  var viewer = el("viewer");
  var viewerImage = el("viewer-image");
  var book = new URLSearchParams(location.search).get("book") || "";
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  var span = (text, className) => {
    const node = document.createElement("span");
    node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function openViewer(dataUrl, label) {
    viewerImage.src = dataUrl;
    viewerImage.alt = label;
    viewer.showModal();
  }
  function message(text) {
    summary.textContent = text;
    grid.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: text
    }));
  }
  function describeCache(captures, total, duplicates) {
    summary.replaceChildren(span(plural(captures.length, "page")));
    if (total) summary.append(span(` of about ${total}`));
    if (duplicates) summary.append(span(" · "), span(plural(duplicates, "duplicate"), "warn"));
    summary.append(span(" · newest last"));
  }
  function tile(capture, page, repeated) {
    const figure = document.createElement("figure");
    if (repeated) figure.className = "dupe";
    if (!page?.dataUrl) {
      const caption2 = document.createElement("figcaption");
      caption2.textContent = `#${capture.index} — missing from storage`;
      figure.append(caption2);
      return figure;
    }
    const label = `#${capture.index}${page.page ? ` · page ${page.page}` : ""}`;
    const image = document.createElement("img");
    image.src = page.dataUrl;
    image.loading = "lazy";
    image.alt = label;
    image.addEventListener("click", () => openViewer(page.dataUrl, label));
    const caption = document.createElement("figcaption");
    caption.append(
      span(label + (repeated ? " · repeat" : "")),
      span(`${page.width}×${page.height}`)
    );
    figure.append(image, caption);
    return figure;
  }
  async function load() {
    title.textContent = `Captured pages · ${book}`;
    if (!book) {
      message("No book specified.");
      return;
    }
    const meta = await loadMeta(book);
    if (!meta.captures.length) {
      message("Nothing cached for this book yet.");
      return;
    }
    const counts = fingerprintCounts(meta.captures);
    const duplicates = [...counts.values()].reduce((total, n) => total + (n - 1), 0);
    describeCache(meta.captures, meta.total, duplicates);
    for await (const batch of pagesInBatches(book, meta.captures)) {
      grid.append(...batch.map(
        ({ capture, page }) => tile(capture, page, (counts.get(capture.fingerprint) || 0) > 1)
      ));
    }
  }
  void load();
})();
