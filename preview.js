"use strict";
(() => {
  // src/shared/reader-hosts.ts
  var READER_HOSTS = [
    "read.amazon.com",
    "read.amazon.ca",
    "read.amazon.co.jp",
    "read.amazon.co.uk",
    "read.amazon.com.au",
    "read.amazon.com.be",
    "read.amazon.com.br",
    "read.amazon.com.mx",
    "read.amazon.com.tr",
    "read.amazon.de",
    "read.amazon.eg",
    "read.amazon.es",
    "read.amazon.fr",
    "read.amazon.in",
    "read.amazon.it",
    "read.amazon.nl",
    "read.amazon.pl",
    "read.amazon.sa",
    "read.amazon.se",
    "read.amazon.sg"
  ];
  var isReaderUrl = (url) => !!url && READER_HOSTS.some((host) => url.startsWith(`https://${host}/`));

  // src/shared/scanning.ts
  async function askTab(id) {
    try {
      const reply = await chrome.tabs.sendMessage(
        id,
        { action: "getState" }
      );
      return !reply || "error" in reply ? null : reply;
    } catch {
      return null;
    }
  }
  async function scanRunning(book2) {
    const tabs = await chrome.tabs.query({});
    const readers = tabs.filter((tab) => tab.id !== void 0 && isReaderUrl(tab.url));
    const states = await Promise.all(readers.map((tab) => askTab(tab.id)));
    return states.some((state) => state?.scanning && state.bookId === book2);
  }

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
    quality: null,
    turnStrategy: null
  });
  async function loadMeta(book2) {
    const key = metaKey(book2);
    const stored = await chrome.storage.local.get(key);
    const raw = stored[key];
    if (raw?.version === 2 && Array.isArray(raw.captures)) {
      return {
        ...raw,
        split: typeof raw.split === "boolean" ? raw.split : null,
        quality: typeof raw.quality === "number" ? raw.quality : null
      };
    }
    return emptyMeta(book2);
  }
  var saveMeta = (meta) => chrome.storage.local.set({ [metaKey(meta.bookId)]: meta });
  async function* pagesInBatches(book2, captures2, size = READ_BATCH) {
    for (let start = 0; start < captures2.length; start += size) {
      const batch = captures2.slice(start, start + size);
      const stored = await chrome.storage.local.get(batch.map((c) => pageKey(book2, c.index)));
      yield batch.map((capture) => ({
        capture,
        page: stored[pageKey(book2, capture.index)]
      }));
    }
  }
  async function reorderCaptures(book2, order) {
    const meta = await loadMeta(book2);
    const remaining = new Map(meta.captures.map((capture) => [capture.index, capture]));
    const ordered = [];
    for (const index of order) {
      const capture = remaining.get(index);
      if (!capture) continue;
      ordered.push(capture);
      remaining.delete(index);
    }
    meta.captures = [...ordered, ...remaining.values()];
    await saveMeta(meta);
    return meta;
  }
  async function deleteCapture(book2, index) {
    const meta = await loadMeta(book2);
    meta.captures = meta.captures.filter((capture) => capture.index !== index);
    await saveMeta(meta);
    await chrome.storage.local.remove([pageKey(book2, index)]);
    return meta;
  }
  function fingerprintCounts(captures2) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures2) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/preview/main.ts
  var el = (id) => document.getElementById(id);
  var grid = el("grid");
  var summary = el("summary");
  var title = el("title");
  var lock = el("lock");
  var viewer = el("viewer");
  var viewerImage = el("viewer-image");
  var book = new URLSearchParams(location.search).get("book") || "";
  var ARM_MS = 3e3;
  var WATCH_MS = 2e3;
  var LOCK_TEXT = "A scan is running — reordering and deleting are paused until it finishes.";
  var captures = [];
  var total = null;
  var locked = false;
  var tiles = /* @__PURE__ */ new Map();
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
  viewer.addEventListener("click", () => viewer.close());
  function message(text) {
    tiles.clear();
    summary.textContent = text;
    grid.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty",
      textContent: text
    }));
  }
  function describeCache(duplicates) {
    summary.replaceChildren(span(plural(captures.length, "page")));
    if (total) summary.append(span(` of about ${total}`));
    if (duplicates) summary.append(span(" · "), span(plural(duplicates, "duplicate"), "warn"));
    summary.append(span(" · drag to reorder · the PDF follows this order"));
  }
  function refresh() {
    const counts = fingerprintCounts(captures);
    let duplicates = 0;
    for (const count of counts.values()) duplicates += count - 1;
    for (const tile2 of tiles.values()) {
      const repeated = (counts.get(tile2.fingerprint) || 0) > 1;
      tile2.figure.classList.toggle("dupe", repeated);
      tile2.label.textContent = tile2.text + (repeated ? " · repeat" : "");
    }
    describeCache(duplicates);
  }
  var armed = null;
  var armTimer = 0;
  function disarm() {
    if (!armed) return;
    armed.classList.remove("armed");
    armed.textContent = "×";
    armed = null;
    clearTimeout(armTimer);
  }
  function arm(button) {
    disarm();
    armed = button;
    button.classList.add("armed");
    button.textContent = "Delete?";
    armTimer = window.setTimeout(disarm, ARM_MS);
  }
  function restoreOrder() {
    for (const capture of captures) {
      const tile2 = tiles.get(capture.index);
      if (tile2) grid.append(tile2.figure);
    }
  }
  function setLocked(value) {
    if (locked === value) return;
    locked = value;
    lock.hidden = !value;
    grid.classList.toggle("locked", value);
    disarm();
    for (const tile2 of tiles.values()) {
      tile2.figure.draggable = !value;
      tile2.remove.disabled = value;
    }
  }
  async function mayEdit() {
    const running = await scanRunning(book);
    setLocked(running);
    return !running;
  }
  function deleteButton(index, figure) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "del";
    button.textContent = "×";
    button.title = `Delete capture #${index}`;
    button.setAttribute("aria-label", `Delete capture #${index}`);
    button.disabled = locked;
    button.addEventListener("click", async () => {
      if (armed !== button) {
        arm(button);
        return;
      }
      disarm();
      button.disabled = true;
      if (!await mayEdit()) {
        button.disabled = locked;
        return;
      }
      const meta = await deleteCapture(book, index);
      captures = meta.captures;
      tiles.delete(index);
      figure.remove();
      if (!tiles.size) {
        message("Nothing cached for this book yet.");
        return;
      }
      refresh();
    });
    return button;
  }
  function tile(capture, page) {
    const figure = document.createElement("figure");
    figure.draggable = !locked;
    figure.dataset.index = String(capture.index);
    const text = `#${capture.index}${page?.page ? ` · page ${page.page}` : ""}`;
    const label = span(text);
    const caption = document.createElement("figcaption");
    if (page?.dataUrl) {
      const image = document.createElement("img");
      image.src = page.dataUrl;
      image.loading = "lazy";
      image.alt = text;
      image.draggable = false;
      image.addEventListener("click", () => openViewer(page.dataUrl, text));
      figure.append(image);
      caption.append(label, span(`${page.width}×${page.height}`));
    } else {
      figure.classList.add("gone");
      label.textContent = `${text} — missing from storage`;
      caption.append(label);
    }
    const remove = deleteButton(capture.index, figure);
    caption.append(remove);
    figure.append(caption);
    tiles.set(capture.index, { figure, label, text, remove, fingerprint: capture.fingerprint });
    return figure;
  }
  var shownOrder = () => [...grid.children].map((node) => Number(node.dataset.index)).filter((index) => Number.isFinite(index) && index > 0);
  async function persistOrder() {
    const order = shownOrder();
    if (order.every((index, at) => captures[at]?.index === index)) return;
    if (!await mayEdit()) {
      restoreOrder();
      return;
    }
    const meta = await reorderCaptures(book, order);
    captures = meta.captures;
    refresh();
  }
  var dragged = null;
  grid.addEventListener("dragstart", (event) => {
    const figure = event.target?.closest("figure");
    if (!figure || locked) {
      event.preventDefault();
      return;
    }
    disarm();
    dragged = figure;
    figure.classList.add("dragging");
    event.dataTransfer?.setData("text/plain", figure.dataset.index ?? "");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  grid.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    const over = event.target?.closest("figure");
    if (!over || over === dragged) return;
    const box = over.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    grid.insertBefore(dragged, after ? over.nextSibling : over);
  });
  grid.addEventListener("drop", (event) => event.preventDefault());
  grid.addEventListener("dragend", () => {
    dragged?.classList.remove("dragging");
    dragged = null;
    void persistOrder();
  });
  var generation = 0;
  async function load() {
    const mine = ++generation;
    title.textContent = `Captured pages · ${book}`;
    if (!book) {
      message("No book specified.");
      return;
    }
    const meta = await loadMeta(book);
    if (mine !== generation) return;
    if (!meta.captures.length) {
      message("Nothing cached for this book yet.");
      return;
    }
    captures = meta.captures;
    total = meta.total;
    refresh();
    for await (const batch of pagesInBatches(book, meta.captures)) {
      if (mine !== generation) return;
      grid.append(...batch.map(({ capture, page }) => tile(capture, page)));
      refresh();
    }
  }
  async function reload() {
    tiles.clear();
    grid.replaceChildren();
    await load();
  }
  async function watchScan() {
    const wasLocked = locked;
    setLocked(await scanRunning(book));
    if (wasLocked && !locked) await reload();
  }
  var watching = false;
  function tick() {
    if (watching) return;
    watching = true;
    void watchScan().finally(() => {
      watching = false;
    });
  }
  lock.textContent = LOCK_TEXT;
  void load().then(tick);
  setInterval(tick, WATCH_MS);
})();
