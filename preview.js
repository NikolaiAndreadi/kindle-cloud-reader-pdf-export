"use strict";
(() => {
  // src/shared/storage.ts
  var READ_BATCH = 20;
  var metaKey = (book2) => `book:${book2}:meta`;
  var pageKey = (book2, index) => `book:${book2}:page:${String(index).padStart(6, "0")}`;
  var ocrKey = (book2, index, fingerprint) => `book:${book2}:ocr:${String(index).padStart(6, "0")}:${fingerprint}`;
  var ocrKeyFor = (book2, capture) => ocrKey(book2, capture.index, capture.fingerprint);
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
  var storeOcr = (book2, capture, result) => chrome.storage.local.set({ [ocrKeyFor(book2, capture)]: result });
  async function loadOcrBatch(book2, captures2) {
    const stored = await chrome.storage.local.get(captures2.map((c) => ocrKeyFor(book2, c)));
    const found = /* @__PURE__ */ new Map();
    for (const capture of captures2) {
      const record = stored[ocrKeyFor(book2, capture)];
      if (Array.isArray(record?.words)) found.set(capture.index, record);
    }
    return found;
  }
  function ocrKeyParts(book2, key) {
    const prefix = `book:${book2}:ocr:`;
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(":");
    if (split < 0) return null;
    const index = Number(rest.slice(0, split));
    if (!Number.isInteger(index) || index <= 0) return null;
    return { index, fingerprint: rest.slice(split + 1) };
  }
  async function recognisedIndexes(book2, captures2, size = READ_BATCH) {
    const wanted = new Set(captures2.map((capture) => `${capture.index}:${capture.fingerprint}`));
    const found = /* @__PURE__ */ new Set();
    const local = chrome.storage.local;
    if (typeof local.getKeys === "function") {
      for (const key of await local.getKeys()) {
        const parts = ocrKeyParts(book2, key);
        if (parts && wanted.has(`${parts.index}:${parts.fingerprint}`)) found.add(parts.index);
      }
      return found;
    }
    for (let start = 0; start < captures2.length; start += size) {
      for (const index of (await loadOcrBatch(book2, captures2.slice(start, start + size))).keys()) {
        found.add(index);
      }
    }
    return found;
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
    const local = chrome.storage.local;
    const meta = await loadMeta(book2);
    meta.captures = meta.captures.filter((capture) => capture.index !== index);
    await saveMeta(meta);
    const stale = typeof local.getKeys === "function" ? (await local.getKeys()).filter((key) => ocrKeyParts(book2, key)?.index === index) : [];
    await local.remove([pageKey(book2, index), ...stale]);
    return meta;
  }
  function fingerprintCounts(captures2) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures2) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/ocr/engine.ts
  var OEM_LSTM_ONLY = 1;
  var PSM_AUTO = "3";
  var TARGET_WIDTH = 1800;
  var MAX_UPSCALE = 3;
  var MIN_CONFIDENCE = 30;
  var LINE_BOX_EMS = 0.93;
  var DESCENDER_EMS = 0.21;
  var round = (value) => Math.round(value * 10) / 10;
  function baselineFor(line, factor, em) {
    const { baseline, bbox } = line;
    const inside = baseline && baseline.x1 > baseline.x0 && Math.min(baseline.y0, baseline.y1) >= bbox.y0 && Math.max(baseline.y0, baseline.y1) <= bbox.y1;
    if (!baseline || !inside) {
      const flat = bbox.y1 / factor - em * DESCENDER_EMS;
      return () => flat;
    }
    const slope = (baseline.y1 - baseline.y0) / (baseline.x1 - baseline.x0);
    return (x) => (baseline.y0 + slope * (x - baseline.x0)) / factor;
  }
  var asset = (name) => chrome.runtime.getURL(`vendor/tesseract/${name}`);
  async function draw(canvas, dataUrl, width, height) {
    const factor = Math.min(MAX_UPSCALE, Math.max(1, TARGET_WIDTH / width));
    const blob = await fetch(dataUrl).then((response) => response.blob());
    const bitmap = await createImageBitmap(blob);
    try {
      canvas.width = Math.round(width * factor);
      canvas.height = Math.round(height * factor);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Could not get a 2D context for OCR.");
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
    return factor;
  }
  async function createRecogniser(onLoad) {
    if (typeof Tesseract === "undefined") {
      throw new Error('OCR engine is missing — run "npm run vendor" and reload the extension.');
    }
    const worker = await Tesseract.createWorker("eng", OEM_LSTM_ONLY, {
      // Paths, not directories: naming the file directly is what stops the worker
      // probing for wasm features and reaching for a build we did not vendor.
      workerPath: asset("worker.min.js"),
      corePath: asset("tesseract-core-simd-lstm.wasm.js"),
      langPath: asset("").replace(/\/$/, ""),
      // The default fetches the worker and re-serves it as a blob: URL, which the
      // extension CSP refuses. Loading it from its own chrome-extension:// URL is
      // same-origin here, so the indirection buys nothing.
      workerBlobURL: false,
      // Nothing to cache to: IndexedDB caching exists to save re-downloading the
      // language data, and ours is a local file.
      cacheMethod: "none",
      ...onLoad ? { logger: (message2) => onLoad(message2.status) } : {}
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM_AUTO,
      // Written into the PDF text layer, where a run of words is all there is.
      preserve_interword_spaces: "1",
      // Where the recogniser's own running commentary goes. Left at its default it
      // writes to stderr, which for a wasm build means console.error in the worker,
      // and it has two things to say about every single page: a page painted by a
      // browser carries no resolution metadata, so it warns that the resolution is
      // 0 dpi and then says what it estimated instead. Nothing to act on, and a
      // book's worth of it — twice over, with two lanes — buries anything that is.
      // /dev/null exists in the emulated filesystem; a path it cannot open would
      // only send the output back to stderr.
      debug_file: "/dev/null"
    });
    const scratch = document.createElement("canvas");
    return {
      async page(dataUrl, width, height) {
        const factor = await draw(scratch, dataUrl, width, height);
        const { data } = await worker.recognize(scratch, {}, { blocks: true, text: false });
        const words = [];
        let confidence = 0;
        for (const block of data.blocks ?? []) {
          for (const paragraph of block.paragraphs) {
            for (const line of paragraph.lines) {
              const lineHeight = (line.bbox.y1 - line.bbox.y0) / factor;
              const em = (line.rowAttributes?.rowHeight || 0) / factor || lineHeight / LINE_BOX_EMS;
              const baselineAt = baselineFor(line, factor, em);
              for (const word of line.words) {
                if (word.confidence < MIN_CONFIDENCE || !word.text.trim()) continue;
                const box = {
                  t: word.text,
                  x0: round(word.bbox.x0 / factor),
                  y0: round(word.bbox.y0 / factor),
                  x1: round(word.bbox.x1 / factor),
                  y1: round(word.bbox.y1 / factor)
                };
                if (em > 0 && lineHeight >= box.y1 - box.y0) {
                  box.b = round(baselineAt(word.bbox.x0));
                  box.s = round(em);
                }
                words.push(box);
                confidence += word.confidence;
              }
            }
          }
        }
        return {
          words,
          confidence: words.length ? Math.round(confidence / words.length) : 0
        };
      },
      close() {
        return worker.terminate().then(() => void 0);
      }
    };
  }

  // src/ocr/run.ts
  var LANES = 2;
  async function pendingCaptures(book2, attempted) {
    const meta = await loadMeta(book2);
    const already = await recognisedIndexes(book2, meta.captures);
    return meta.captures.filter(
      (capture) => !already.has(capture.index) && !attempted.has(capture.index)
    );
  }
  async function openLanes(count, open, onLoad) {
    const started = await Promise.allSettled(
      Array.from({ length: count }, (_, lane) => open(lane === 0 ? onLoad : () => {
      }))
    );
    const ready = started.flatMap((lane) => lane.status === "fulfilled" ? [lane.value] : []);
    const failed = started.find((lane) => lane.status === "rejected");
    if (failed) {
      await Promise.all(ready.map((recogniser) => recogniser.close().catch(() => {
      })));
      throw failed.reason;
    }
    return ready;
  }
  async function runOcr(book2, options) {
    const result = { recognised: 0, skipped: 0, stopped: false };
    const attempted = /* @__PURE__ */ new Set();
    let pending = await pendingCaptures(book2, attempted);
    if (!pending.length) return result;
    options.onProgress({ done: 0, total: pending.length, status: "loading the OCR engine" });
    let loading = true;
    const recognisers = await openLanes(LANES, options.open ?? createRecogniser, (status) => {
      if (loading) options.onProgress({ done: 0, total: pending.length, status });
    });
    loading = false;
    let failure;
    try {
      while (pending.length && !result.stopped && !failure) {
        const total2 = result.recognised + result.skipped + pending.length;
        for await (const batch of pagesInBatches(book2, pending)) {
          if (result.stopped || failure) break;
          let cursor = 0;
          await Promise.all(recognisers.map(async (recogniser) => {
            while (cursor < batch.length && !result.stopped && !failure) {
              if (options.shouldStop()) {
                result.stopped = true;
                return;
              }
              const item = batch[cursor++];
              if (!item) break;
              const { capture, page } = item;
              attempted.add(capture.index);
              if (!page?.dataUrl || !page.width || !page.height) {
                result.skipped += 1;
                continue;
              }
              try {
                const { words, confidence } = await recogniser.page(page.dataUrl, page.width, page.height);
                await storeOcr(book2, capture, {
                  index: capture.index,
                  width: page.width,
                  height: page.height,
                  words,
                  confidence
                });
              } catch (error) {
                failure ??= error;
                return;
              }
              result.recognised += 1;
              options.onProgress({
                done: result.recognised + result.skipped,
                total: total2,
                index: capture.index
              });
            }
          }));
        }
        if (result.stopped || failure) break;
        pending = await pendingCaptures(book2, attempted);
      }
    } finally {
      await Promise.all(recognisers.map((recogniser) => recogniser.close()));
    }
    if (failure) throw failure;
    return result;
  }

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

  // src/preview/main.ts
  var el = (id) => document.getElementById(id);
  var grid = el("grid");
  var summary = el("summary");
  var title = el("title");
  var lock = el("lock");
  var viewer = el("viewer");
  var viewerImage = el("viewer-image");
  var ocrStart = el("ocrStart");
  var ocrStop = el("ocrStop");
  var ocrStatus = el("ocrStatus");
  var book = new URLSearchParams(location.search).get("book") || "";
  var ARM_MS = 3e3;
  var WATCH_MS = 2e3;
  var LOCK_TEXT = "A scan is running — reordering and deleting are paused until it finishes.";
  var captures = [];
  var total = null;
  var locked = false;
  var tiles = /* @__PURE__ */ new Map();
  var recognised = /* @__PURE__ */ new Set();
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
    captures = [];
    recognised = /* @__PURE__ */ new Set();
    describeOcr();
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
    for (const [index, tile2] of tiles) {
      const repeated = (counts.get(tile2.fingerprint) || 0) > 1;
      tile2.figure.classList.toggle("dupe", repeated);
      tile2.label.textContent = tile2.text + (repeated ? " · repeat" : "");
      tile2.mark.textContent = recognised.has(index) ? "text" : "";
    }
    describeCache(duplicates);
    describeOcr();
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
    const mark = span(recognised.has(capture.index) ? "text" : "", "text");
    const remove = deleteButton(capture.index, figure);
    caption.append(mark, remove);
    figure.append(caption);
    tiles.set(capture.index, { figure, label, text, mark, remove, fingerprint: capture.fingerprint });
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
  var ocrRunning = false;
  var ocrStopRequested = false;
  function describeOcr() {
    if (ocrRunning) return;
    const total2 = captures.length;
    if (!total2) {
      ocrStatus.textContent = "";
      ocrStart.disabled = true;
      return;
    }
    const done = captures.filter((capture) => recognised.has(capture.index)).length;
    ocrStart.disabled = done === total2;
    ocrStatus.textContent = done === total2 ? `All ${plural(total2, "page")} carry searchable text.` : `${done} of ${total2} pages have a text layer · the PDF gets one wherever it exists.`;
  }
  async function refreshRecognised() {
    recognised = await recognisedIndexes(book, captures);
    refresh();
  }
  function markRecognised(index) {
    recognised.add(index);
    const tile2 = tiles.get(index);
    if (tile2) tile2.mark.textContent = "text";
  }
  async function startOcr() {
    if (ocrRunning) return;
    ocrRunning = true;
    ocrStopRequested = false;
    ocrStart.hidden = true;
    ocrStop.hidden = false;
    ocrStop.disabled = false;
    ocrStatus.textContent = "Starting…";
    let outcome = "";
    try {
      const result = await runOcr(book, {
        onProgress: (progress) => {
          if (progress.index !== void 0) markRecognised(progress.index);
          ocrStatus.textContent = progress.status ? `${progress.status}…` : `Reading page ${progress.done} of ${progress.total}${ocrStopRequested ? " · stopping after this page" : ""}`;
        },
        shouldStop: () => ocrStopRequested
      });
      const skipped = result.skipped ? `, ${plural(result.skipped, "page")} skipped` : "";
      outcome = result.stopped ? `Stopped after ${plural(result.recognised, "page")}${skipped}. Start again to carry on.` : `Finished — ${plural(result.recognised, "page")} recognised${skipped}.`;
    } catch (error) {
      outcome = `OCR failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      ocrRunning = false;
      ocrStart.hidden = false;
      ocrStop.hidden = true;
      await refreshRecognised();
      if (outcome) ocrStatus.textContent = outcome;
    }
  }
  ocrStart.addEventListener("click", () => void startOcr());
  ocrStop.addEventListener("click", () => {
    ocrStopRequested = true;
    ocrStop.disabled = true;
  });
  addEventListener("beforeunload", (event) => {
    if (!ocrRunning) return;
    event.preventDefault();
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
    await refreshRecognised();
    if (mine !== generation) return;
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
