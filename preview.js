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
  var READER_HOST_SET = new Set(READER_HOSTS);
  function isReaderUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && READER_HOST_SET.has(url.hostname);
    } catch {
      return false;
    }
  }

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
    const readerIds = tabs.flatMap(
      (tab) => tab.id !== void 0 && isReaderUrl(tab.url) ? [tab.id] : []
    );
    const states = await Promise.all(readerIds.map(askTab));
    return states.some((state) => state?.scanning && state.bookId === book2);
  }

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
  var storeOcr = (book2, capture, result) => chrome.storage.local.set({ [ocrKeyFor(book2, capture)]: result });
  async function loadOcrBatch(book2, captures) {
    const stored = await chrome.storage.local.get(captures.map((c) => ocrKeyFor(book2, c)));
    const found = /* @__PURE__ */ new Map();
    for (const capture of captures) {
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
  async function recognisedIndexes(book2, captures, size = READ_BATCH) {
    const wanted = new Set(captures.map((capture) => `${capture.index}:${capture.fingerprint}`));
    const found = /* @__PURE__ */ new Set();
    const local = chrome.storage.local;
    if (typeof local.getKeys === "function") {
      for (const key of await local.getKeys()) {
        const parts = ocrKeyParts(book2, key);
        if (parts && wanted.has(`${parts.index}:${parts.fingerprint}`)) found.add(parts.index);
      }
      return found;
    }
    for (let start = 0; start < captures.length; start += size) {
      for (const index of (await loadOcrBatch(book2, captures.slice(start, start + size))).keys()) {
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
  function fingerprintCounts(captures) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/preview/elements.ts
  function required(id) {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element: #${id}`);
    return node;
  }
  var ui = {
    grid: required("grid"),
    summary: required("summary"),
    title: required("title"),
    lock: required("lock"),
    viewer: required("viewer"),
    viewerImage: required("viewer-image"),
    ocrStart: required("ocrStart"),
    ocrStop: required("ocrStop"),
    ocrStatus: required("ocrStatus")
  };
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  var message = (error) => error instanceof Error ? error.message : String(error);
  function span(text, className) {
    const node = document.createElement("span");
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  // src/preview/grid.ts
  var ARM_MS = 3e3;
  var LOCK_TEXT = "A scan is running — reordering and deleting are paused until it finishes.";
  var PreviewGrid = class {
    book;
    records = [];
    total = null;
    tiles = /* @__PURE__ */ new Map();
    recognised = /* @__PURE__ */ new Set();
    armed = null;
    armTimer = 0;
    dragged = null;
    editLocked = false;
    onChange = () => {
    };
    constructor(book2) {
      this.book = book2;
      ui.lock.textContent = LOCK_TEXT;
      ui.viewer.addEventListener("click", () => ui.viewer.close());
      this.bindDragging();
    }
    get captures() {
      return this.records;
    }
    get locked() {
      return this.editLocked;
    }
    recognisedCount() {
      return this.records.filter((capture) => this.recognised.has(capture.index)).length;
    }
    showMessage(text) {
      this.tiles.clear();
      this.records = [];
      this.recognised.clear();
      ui.summary.textContent = text;
      ui.grid.replaceChildren(Object.assign(document.createElement("p"), {
        className: "empty",
        textContent: text
      }));
      this.onChange();
    }
    showError(error) {
      ui.summary.textContent = message(error);
    }
    setMeta(meta) {
      this.records = meta.captures;
      this.total = meta.total;
      this.refresh();
    }
    clearTiles() {
      this.tiles.clear();
      ui.grid.replaceChildren();
    }
    append(capture, page) {
      ui.grid.append(this.createTile(capture, page));
    }
    async refreshRecognised() {
      this.recognised = await recognisedIndexes(this.book, this.records);
      this.refresh();
    }
    markRecognised(index) {
      this.recognised.add(index);
      const tile = this.tiles.get(index);
      if (tile) tile.mark.textContent = "text";
    }
    setLocked(value) {
      if (this.editLocked === value) return;
      this.editLocked = value;
      ui.lock.hidden = !value;
      ui.grid.classList.toggle("locked", value);
      this.disarm();
      for (const tile of this.tiles.values()) {
        tile.figure.draggable = !value;
        tile.remove.disabled = value;
      }
    }
    /**
     * Redraw everything that depends on the set of captures rather than on one
     * page: the summary line and the repeat markers, both of which change when a
     * page is deleted.
     */
    refresh() {
      const counts = fingerprintCounts(this.records);
      let duplicates = 0;
      for (const count of counts.values()) duplicates += count - 1;
      for (const [index, tile] of this.tiles) {
        const repeated = (counts.get(tile.fingerprint) || 0) > 1;
        tile.figure.classList.toggle("dupe", repeated);
        tile.label.textContent = tile.text + (repeated ? " · repeat" : "");
        tile.mark.textContent = this.recognised.has(index) ? "text" : "";
      }
      ui.summary.replaceChildren(span(plural(this.records.length, "page")));
      if (this.total) ui.summary.append(span(` of about ${this.total}`));
      if (duplicates) {
        ui.summary.append(span(" · "), span(plural(duplicates, "duplicate"), "warn"));
      }
      ui.summary.append(span(" · drag to reorder · the PDF follows this order"));
      this.onChange();
    }
    openViewer(dataUrl, label) {
      ui.viewerImage.src = dataUrl;
      ui.viewerImage.alt = label;
      ui.viewer.showModal();
    }
    disarm() {
      if (!this.armed) return;
      this.armed.classList.remove("armed");
      this.armed.textContent = "×";
      this.armed = null;
      clearTimeout(this.armTimer);
    }
    arm(button) {
      this.disarm();
      this.armed = button;
      button.classList.add("armed");
      button.textContent = "Delete?";
      this.armTimer = window.setTimeout(() => this.disarm(), ARM_MS);
    }
    /**
     * Whether this page may write to the index right now. Asked immediately before
     * every edit rather than trusting the poll: a scan started in the last couple
     * of seconds would otherwise swallow the edit at its next flush, silently.
     */
    async mayEdit() {
      const running = await scanRunning(this.book);
      this.setLocked(running);
      return !running;
    }
    /**
     * Deleting a page cannot be undone short of scanning it again, so the first
     * click only arms the button. Same idea as holding "Clear this book" in the
     * popup, scaled down to one page.
     */
    deleteButton(index, figure) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "del";
      button.textContent = "×";
      button.title = `Delete capture #${index}`;
      button.setAttribute("aria-label", `Delete capture #${index}`);
      button.disabled = this.editLocked;
      button.addEventListener("click", () => void this.delete(index, figure, button));
      return button;
    }
    async delete(index, figure, button) {
      if (this.armed !== button) {
        this.arm(button);
        return;
      }
      this.disarm();
      button.disabled = true;
      try {
        if (!await this.mayEdit()) {
          button.disabled = this.editLocked;
          return;
        }
        const meta = await deleteCapture(this.book, index);
        this.records = meta.captures;
        this.tiles.delete(index);
        figure.remove();
        if (!this.records.length) this.showMessage("Nothing cached for this book yet.");
        else this.refresh();
      } catch (error) {
        button.disabled = this.editLocked;
        this.showError(error);
      }
    }
    createTile(capture, page) {
      const figure = document.createElement("figure");
      figure.draggable = !this.editLocked;
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
        image.addEventListener("click", () => this.openViewer(page.dataUrl, text));
        figure.append(image);
        caption.append(label, span(`${page.width}×${page.height}`));
      } else {
        figure.classList.add("gone");
        label.textContent = `${text} — missing from storage`;
        caption.append(label);
      }
      const mark = span(this.recognised.has(capture.index) ? "text" : "", "text");
      const remove = this.deleteButton(capture.index, figure);
      caption.append(mark, remove);
      figure.append(caption);
      this.tiles.set(capture.index, {
        figure,
        label,
        text,
        mark,
        remove,
        fingerprint: capture.fingerprint
      });
      return figure;
    }
    shownOrder() {
      return [...ui.grid.children].map((node) => Number(node.dataset.index)).filter((index) => Number.isFinite(index) && index > 0);
    }
    /** Put the tiles back in stored order, after an edit that was refused. */
    restoreOrder() {
      for (const capture of this.records) {
        const tile = this.tiles.get(capture.index);
        if (tile) ui.grid.append(tile.figure);
      }
    }
    async persistOrder() {
      const order = this.shownOrder();
      if (order.every((index, at) => this.records[at]?.index === index)) return;
      if (!await this.mayEdit()) {
        this.restoreOrder();
        return;
      }
      const meta = await reorderCaptures(this.book, order);
      this.records = meta.captures;
      this.refresh();
    }
    bindDragging() {
      ui.grid.addEventListener("dragstart", (event) => {
        const figure = event.target?.closest("figure");
        if (!figure || this.editLocked) {
          event.preventDefault();
          return;
        }
        this.disarm();
        this.dragged = figure;
        figure.classList.add("dragging");
        event.dataTransfer?.setData("text/plain", figure.dataset.index ?? "");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      ui.grid.addEventListener("dragover", (event) => {
        if (!this.dragged) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const over = event.target?.closest("figure");
        if (!over || over === this.dragged) return;
        const box = over.getBoundingClientRect();
        const after = event.clientX > box.left + box.width / 2;
        ui.grid.insertBefore(this.dragged, after ? over.nextSibling : over);
      });
      ui.grid.addEventListener("drop", (event) => event.preventDefault());
      ui.grid.addEventListener("dragend", () => {
        this.dragged?.classList.remove("dragging");
        this.dragged = null;
        void this.persistOrder().catch((error) => {
          this.restoreOrder();
          this.showError(error);
        });
      });
    }
  };

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
        const total = result.recognised + result.skipped + pending.length;
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
                total,
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

  // src/preview/ocr.ts
  var OcrController = class {
    book;
    grid;
    running = false;
    stopRequested = false;
    constructor(book2, grid2) {
      this.book = book2;
      this.grid = grid2;
      ui.ocrStart.addEventListener("click", () => void this.start());
      ui.ocrStop.addEventListener("click", () => {
        this.stopRequested = true;
        ui.ocrStop.disabled = true;
      });
      addEventListener("beforeunload", (event) => {
        if (!this.running) return;
        event.preventDefault();
      });
    }
    describe() {
      if (this.running) return;
      const total = this.grid.captures.length;
      if (!total) {
        ui.ocrStatus.textContent = "";
        ui.ocrStart.disabled = true;
        return;
      }
      const done = this.grid.recognisedCount();
      ui.ocrStart.disabled = done === total;
      ui.ocrStatus.textContent = done === total ? `All ${plural(total, "page")} carry searchable text.` : `${done} of ${total} pages have a text layer · the PDF gets one wherever it exists.`;
    }
    async start() {
      if (this.running) return;
      this.running = true;
      this.stopRequested = false;
      ui.ocrStart.hidden = true;
      ui.ocrStop.hidden = false;
      ui.ocrStop.disabled = false;
      ui.ocrStatus.textContent = "Starting…";
      let outcome = "";
      try {
        const result = await runOcr(this.book, {
          onProgress: (progress) => {
            if (progress.index !== void 0) this.grid.markRecognised(progress.index);
            ui.ocrStatus.textContent = progress.status ? `${progress.status}…` : `Reading page ${progress.done} of ${progress.total}${this.stopRequested ? " · stopping after this page" : ""}`;
          },
          shouldStop: () => this.stopRequested
        });
        const skipped = result.skipped ? `, ${plural(result.skipped, "page")} skipped` : "";
        outcome = result.stopped ? `Stopped after ${plural(result.recognised, "page")}${skipped}. Start again to carry on.` : `Finished — ${plural(result.recognised, "page")} recognised${skipped}.`;
      } catch (error) {
        outcome = `OCR failed: ${message(error)}`;
      } finally {
        this.running = false;
        ui.ocrStart.hidden = false;
        ui.ocrStop.hidden = true;
        try {
          await this.grid.refreshRecognised();
        } catch (error) {
          outcome += ` (the page count could not be refreshed: ${message(error)})`;
        }
        if (outcome) ui.ocrStatus.textContent = outcome;
      }
    }
  };

  // src/preview/main.ts
  var WATCH_MS = 2e3;
  var book = new URLSearchParams(location.search).get("book") || "";
  var grid = new PreviewGrid(book);
  var ocr = new OcrController(book, grid);
  grid.onChange = () => ocr.describe();
  var generation = 0;
  async function load() {
    const mine = ++generation;
    ui.title.textContent = `Captured pages · ${book}`;
    if (!book) {
      grid.showMessage("No book specified.");
      return;
    }
    const meta = await loadMeta(book);
    if (mine !== generation) return;
    if (!meta.captures.length) {
      grid.showMessage("Nothing cached for this book yet.");
      return;
    }
    grid.setMeta(meta);
    await grid.refreshRecognised();
    if (mine !== generation) return;
    for await (const batch of pagesInBatches(book, meta.captures)) {
      if (mine !== generation) return;
      for (const { capture, page } of batch) grid.append(capture, page);
      grid.refresh();
    }
  }
  async function reload() {
    grid.clearTiles();
    await load();
  }
  async function watchScan() {
    const wasLocked = grid.locked;
    grid.setLocked(await scanRunning(book));
    if (wasLocked && !grid.locked) await reload();
  }
  var watching = false;
  function tick() {
    if (watching) return;
    watching = true;
    void watchScan().catch((error) => grid.showError(error)).finally(() => {
      watching = false;
    });
  }
  void load().then(tick, (error) => grid.showMessage(`Could not load this book: ${message(error)}`));
  setInterval(tick, WATCH_MS);
})();
