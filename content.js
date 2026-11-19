"use strict";
(() => {
  // src/shared/storage.ts
  var READ_BATCH = 20;
  var META_FLUSH_EVERY = 10;
  var metaKey = (book) => `book:${book}:meta`;
  var pageKey = (book, index) => `book:${book}:page:${String(index).padStart(6, "0")}`;
  var ocrKey = (book, index, fingerprint) => `book:${book}:ocr:${String(index).padStart(6, "0")}:${fingerprint}`;
  var ocrKeyFor = (book, capture) => ocrKey(book, capture.index, capture.fingerprint);
  var emptyMeta = (book) => ({
    version: 2,
    bookId: book,
    captures: [],
    total: null,
    kind: null,
    split: null,
    quality: null,
    turnStrategy: null
  });
  async function loadMeta(book) {
    const key = metaKey(book);
    const stored = await chrome.storage.local.get(key);
    const raw = stored[key];
    if (raw?.version === 2 && Array.isArray(raw.captures)) {
      return {
        ...raw,
        split: typeof raw.split === "boolean" ? raw.split : null,
        quality: typeof raw.quality === "number" ? raw.quality : null
      };
    }
    return emptyMeta(book);
  }
  var saveMeta = (meta) => chrome.storage.local.set({ [metaKey(meta.bookId)]: meta });
  var nextIndex = (meta) => meta.captures.reduce((highest, capture) => Math.max(highest, capture.index), 0) + 1;
  async function storePage(meta, record, image) {
    meta.captures.push(record);
    const page = {
      index: record.index,
      page: record.page,
      width: image.width,
      height: image.height,
      dataUrl: image.dataUrl
    };
    await chrome.storage.local.set({ [pageKey(meta.bookId, record.index)]: page });
  }
  async function loadOcrBatch(book, captures) {
    const stored = await chrome.storage.local.get(captures.map((c) => ocrKeyFor(book, c)));
    const found = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      const record = stored[ocrKeyFor(book, capture)];
      if (Array.isArray(record?.words)) found.set(capture.index, record);
    }
    return found;
  }
  function ocrKeyParts(book, key) {
    const prefix = `book:${book}:ocr:`;
    if (!key.startsWith(prefix)) return null;
    const rest = key.slice(prefix.length);
    const split = rest.indexOf(":");
    if (split < 0) return null;
    const index = Number(rest.slice(0, split));
    if (!Number.isInteger(index) || index <= 0) return null;
    return { index, fingerprint: rest.slice(split + 1) };
  }
  async function recognisedIndexes(book, captures, size = READ_BATCH) {
    const wanted = new Set(captures.map((capture) => `${capture.index}:${capture.fingerprint}`));
    const found = /* @__PURE__ */ new Set();
    const local = chrome.storage.local;
    if (typeof local.getKeys === "function") {
      for (const key of await local.getKeys()) {
        const parts = ocrKeyParts(book, key);
        if (parts && wanted.has(`${parts.index}:${parts.fingerprint}`)) found.add(parts.index);
      }
      return found;
    }
    for (let start = 0; start < captures.length; start += size) {
      for (const index of (await loadOcrBatch(book, captures.slice(start, start + size))).keys()) {
        found.add(index);
      }
    }
    return found;
  }
  function countDuplicates(captures) {
    let duplicates = 0;
    for (const count of fingerprintCounts(captures).values()) duplicates += count - 1;
    return duplicates;
  }
  function fingerprintCounts(captures) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/shared/scan-lock.ts
  async function acquireBookScan(book, token) {
    try {
      const reply = await chrome.runtime.sendMessage({
        action: "acquireScanLock",
        book,
        token
      });
      return reply?.acquired ?? true;
    } catch (error) {
      console.warn("Could not reach the scan lock — scanning without it", error);
      return true;
    }
  }
  async function releaseBookScan(book, token) {
    await chrome.runtime.sendMessage({
      action: "releaseScanLock",
      book,
      token
    });
  }

  // src/content/dom.ts
  var PAGE_SELECTOR = ".kg-full-page-img img";
  var PAGE_FALLBACK_SELECTOR = ".kg-full-page-img img, canvas";
  var COUNTER_SELECTOR = '[item-i-d="reader-footer-title"], .reader-footer, [data-testid="footer"]';
  var COUNTER_PATTERN = /\b(Page|Location)\s+([\d,]+)\s+of\s+([\d,]+)\b/i;
  var RENDERER_SELECTOR = "#kr-renderer, .kr-renderer-container-fullpage";
  var NEXT_BUTTON_SELECTOR = 'button[aria-label="Next page"], button.chevron.right';
  var NEXT_AREA_SELECTOR = '[aria-label="Next page"], .kr-chevron-container-right, .chevron.right';
  var MIN_PAGE_SIDE = 100;
  var DOMINANT_AREA_RATIO = 0.5;
  var MAX_ROOTS = 50;
  var MAX_ROOT_DEPTH = 3;
  var MAX_TEXT_NODES = 2e4;
  var counterHost = null;
  function nextPageControl() {
    return document.querySelector(NEXT_BUTTON_SELECTOR) ?? document.querySelector(NEXT_AREA_SELECTOR);
  }
  function bookId() {
    const url = new URL(location.href);
    const asin = url.searchParams.get("asin") || url.hash.match(/asin[=/]([A-Z0-9]+)/i)?.[1] || url.pathname.match(/\/asin\/([A-Z0-9]+)/i)?.[1];
    return (asin || url.pathname.replace(/\W+/g, "-")).slice(0, 80);
  }
  function collectRoots() {
    const found = [];
    const visit = (root, depth) => {
      if (found.length >= MAX_ROOTS || found.includes(root)) return;
      found.push(root);
      if (depth >= MAX_ROOT_DEPTH) return;
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot, depth + 1);
        if (element.localName !== "iframe") continue;
        let inner = null;
        try {
          inner = element.contentDocument;
        } catch {
          inner = null;
        }
        if (inner) visit(inner, depth + 1);
      }
    };
    visit(document, 0);
    return found;
  }
  function parseCounter(text) {
    const match = COUNTER_PATTERN.exec(text);
    if (!match) return null;
    const digits = (value) => Number(value.replace(/,/g, ""));
    return {
      kind: match[1].toLowerCase() === "location" ? "location" : "page",
      value: digits(match[2]),
      total: digits(match[3])
    };
  }
  function readerPosition() {
    if (counterHost?.isConnected) {
      const cached = parseCounter(counterHost.textContent || "");
      if (cached) return cached;
    }
    counterHost = null;
    for (const node of document.querySelectorAll(COUNTER_SELECTOR)) {
      const counter = parseCounter(node.textContent || "");
      if (!counter) continue;
      counterHost = node;
      return counter;
    }
    return searchCounter(collectRoots());
  }
  function searchCounter(rootList) {
    let examined = 0;
    for (const root of rootList) {
      const doc = root.nodeType === Node.DOCUMENT_NODE ? root : root.ownerDocument || document;
      const walker = doc.createTreeWalker("body" in root ? root.body : root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++examined > MAX_TEXT_NODES) return null;
        const parent = node.parentElement;
        if (!parent || parent.checkVisibility?.() === false) continue;
        const counter = parseCounter(node.textContent || "");
        if (!counter) continue;
        counterHost = parent;
        return counter;
      }
    }
    return null;
  }
  var positionKey = (position) => position ? `${position.kind}:${position.value}` : "";
  function visibleCandidates(elements) {
    const candidates = [];
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      if (rect.width < MIN_PAGE_SIDE || rect.height < MIN_PAGE_SIDE) continue;
      if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
      candidates.push({ element, rect, area: rect.width * rect.height });
    }
    if (!candidates.length) return [];
    const largest = Math.max(...candidates.map((candidate) => candidate.area));
    return candidates.filter((candidate) => candidate.area >= largest * DOMINANT_AREA_RATIO).sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
  }
  function pageCandidates() {
    const direct = visibleCandidates([...document.querySelectorAll(PAGE_SELECTOR)]);
    if (direct.length) return direct;
    const roots = collectRoots();
    for (const selector of [PAGE_SELECTOR, PAGE_FALLBACK_SELECTOR]) {
      const found = visibleCandidates(
        roots.flatMap((root) => [...root.querySelectorAll(selector)])
      );
      if (found.length) return found;
    }
    return [];
  }

  // src/content/notice.ts
  var NOTICE_ID = "personal-reader-export-status";
  var NOTICE_MS = 5e3;
  var noticeTimer = null;
  function clearTimer() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
  }
  function notify(text) {
    clearTimer();
    let node = document.getElementById(NOTICE_ID);
    if (!node) {
      node = document.createElement("div");
      node.id = NOTICE_ID;
      Object.assign(node.style, {
        position: "fixed",
        top: "16px",
        right: "16px",
        zIndex: 2147483647,
        padding: "10px 14px",
        borderRadius: "7px",
        background: "#171717",
        color: "#fff",
        font: "13px/1.4 system-ui, sans-serif",
        boxShadow: "0 3px 14px #0007",
        maxWidth: "340px"
      });
      (document.body || document.documentElement).appendChild(node);
    }
    node.textContent = text;
  }
  function removeNoticeLater() {
    clearTimer();
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      document.getElementById(NOTICE_ID)?.remove();
    }, NOTICE_MS);
  }

  // src/shared/timing.ts
  var DELAY_MIN = 700;
  var DELAY_MAX = 2e3;
  var DELAY_DEFAULT = 1100;
  var JITTER_MIN = 0;
  var JITTER_MAX = 5;
  var JITTER_DEFAULT = 2;
  var JITTER_SHARE = 0.2;
  var clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  var clampDelay = (ms) => clamp(Number(ms) || DELAY_DEFAULT, DELAY_MIN, DELAY_MAX);
  function clampJitter(level) {
    const value = Number(level);
    return Number.isFinite(value) ? clamp(Math.round(value), JITTER_MIN, JITTER_MAX) : JITTER_DEFAULT;
  }
  var jitteredDelay = (base, level, roll = Math.random()) => Math.round(base * (1 + JITTER_SHARE * level * roll));

  // src/content/capture.ts
  var DEFAULT_BACKGROUND = "#ffffff";
  var DECODE_TIMEOUT = 3e3;
  var SPREAD_ASPECT = 1.2;
  var SIGNATURE_SIDE = 128;
  var GUTTER_TOLERANCE = 12;
  var FNV_OFFSET = 2166136261;
  var FNV_PRIME = 16777619;
  var signatureCanvas = null;
  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var asImage = (element) => element.localName === "img" ? element : null;
  async function decoded(element) {
    const image = asImage(element);
    if (!image) return true;
    if (image.complete && image.naturalWidth) return true;
    const settled = await Promise.race([
      image.decode().then(() => true, () => false),
      wait(DECODE_TIMEOUT).then(() => false)
    ]);
    return settled && image.naturalWidth > 0;
  }
  function naturalSize(element) {
    const image = asImage(element);
    return {
      width: image ? image.naturalWidth || image.width : element.width,
      height: image ? image.naturalHeight || image.height : element.height
    };
  }
  var isWide = (width, height) => height > 0 && width / height >= SPREAD_ASPECT;
  function regionsFor(width, height, split) {
    if (!width || !height) return [];
    if (!split || !isWide(width, height)) return [{ sx: 0, sy: 0, sw: width, sh: height }];
    const half = Math.floor(width / 2);
    return [
      { sx: 0, sy: 0, sw: half, sh: height },
      { sx: half, sy: 0, sw: width - half, sh: height }
    ];
  }
  function fingerprintOf(dataUrl, width, height) {
    let hash = FNV_OFFSET;
    const mix = (text) => {
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
    };
    const middle = Math.floor(dataUrl.length / 2);
    mix(`${width}x${height}:${dataUrl.length}`);
    mix(dataUrl.slice(-512));
    mix(dataUrl.slice(middle, middle + 512));
    return `${width}x${height}-${dataUrl.length.toString(36)}-${hash.toString(36)}`;
  }
  function samplePixels(element, region) {
    signatureCanvas ??= document.createElement("canvas");
    signatureCanvas.width = SIGNATURE_SIDE;
    signatureCanvas.height = SIGNATURE_SIDE;
    const context = signatureCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) return null;
    try {
      context.fillStyle = DEFAULT_BACKGROUND;
      context.fillRect(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
      context.drawImage(element, region.sx, region.sy, region.sw, region.sh, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
      return context.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
    } catch {
      return null;
    }
  }
  function hasCenterGutter(pixels) {
    const rowBytes = SIGNATURE_SIDE * 4;
    const center = rowBytes / 2;
    let hasContent = false;
    for (let i = 0; i < pixels.length; i += 4) {
      const column = i % rowBytes;
      const gutter = column < center ? center - 4 : center;
      const contrast = Math.max(
        Math.abs(pixels[i] - pixels[gutter]),
        Math.abs(pixels[i + 1] - pixels[gutter + 1]),
        Math.abs(pixels[i + 2] - pixels[gutter + 2])
      );
      if (contrast <= GUTTER_TOLERANCE) continue;
      if (column === gutter) return false;
      hasContent = true;
    }
    return hasContent;
  }
  function signatureOf(region, pixels) {
    if (!pixels) return null;
    let hash = FNV_OFFSET;
    for (let i = 0; i < pixels.length; i++) {
      if ((i & 3) === 3) continue;
      hash ^= pixels[i];
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return `${region.sw}x${region.sh}-${hash.toString(36)}`;
  }
  async function viewsOf(element, split) {
    if (!await decoded(element)) return [];
    const { width, height } = naturalSize(element);
    if (!width || !height) return [];
    const whole = { sx: 0, sy: 0, sw: width, sh: height };
    const wide = isWide(width, height);
    if (split === "aspect" && wide) return splitViews(element, width, height);
    const pixels = samplePixels(element, whole);
    if (split === "gutter" && wide && pixels && hasCenterGutter(pixels)) {
      return splitViews(element, width, height);
    }
    return [{ region: whole, signature: signatureOf(whole, pixels) }];
  }
  function splitViews(element, width, height) {
    return regionsFor(width, height, true).map((region) => ({
      region,
      signature: signatureOf(region, samplePixels(element, region))
    }));
  }
  function renderRegion(element, region, quality) {
    const { sx, sy, sw, sh } = region;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    const background = element.closest("[data-background-color]")?.dataset.backgroundColor;
    context.fillStyle = /^#[0-9a-f]{3,8}$/i.test(background || "") ? background : DEFAULT_BACKGROUND;
    context.fillRect(0, 0, sw, sh);
    context.drawImage(element, sx, sy, sw, sh, 0, 0, sw, sh);
    return { width: sw, height: sh, dataUrl: canvas.toDataURL("image/jpeg", quality) };
  }

  // src/content/turning.ts
  function sendArrowRight(target) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "ArrowRight",
        code: "ArrowRight",
        keyCode: 39,
        which: 39,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window
      }));
    }
  }
  function dispatchClick(target, clientX, clientY) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0
    };
    target.dispatchEvent(new PointerEvent("pointerdown", base));
    target.dispatchEvent(new MouseEvent("mousedown", base));
    target.dispatchEvent(new PointerEvent("pointerup", base));
    target.dispatchEvent(new MouseEvent("mouseup", base));
    target.dispatchEvent(new MouseEvent("click", base));
  }
  function clickCentre(element) {
    const rect = element.getBoundingClientRect();
    dispatchClick(element, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  function clickRightEdge() {
    const rect = document.querySelector(RENDERER_SELECTOR)?.getBoundingClientRect();
    if (!rect?.width) return;
    const x = rect.right - Math.max(8, rect.width * 0.08);
    const y = rect.top + rect.height / 2;
    const target = document.elementFromPoint(x, y);
    if (target) dispatchClick(target, x, y);
  }
  var TURN_STRATEGIES = [
    {
      name: "next-button",
      run: () => {
        const control = nextPageControl();
        if (control) clickCentre(control);
      }
    },
    { name: "keys-document", run: () => sendArrowRight(document) },
    { name: "keys-window", run: () => sendArrowRight(window) },
    {
      name: "keys-renderer",
      run: () => {
        const renderer = document.querySelector(RENDERER_SELECTOR);
        renderer?.focus?.();
        sendArrowRight(renderer || document);
      }
    },
    { name: "keys-body", run: () => sendArrowRight(document.body) },
    { name: "click-right-edge", run: clickRightEdge }
  ];
  function turnProber(remembered) {
    let chosen = TURN_STRATEGIES.findIndex((strategy) => strategy.name === remembered);
    let probing = chosen < 0;
    let nextProbe = 0;
    let lastAttempt = -1;
    return {
      get probing() {
        return probing;
      },
      /** How many stalled iterations to tolerate before giving up. */
      stallBudget(settled) {
        return probing ? TURN_STRATEGIES.length + 1 : settled;
      },
      /** The strategy that just proved itself, or null if nothing is settled yet. */
      settle() {
        if (!probing || lastAttempt < 0) return null;
        chosen = lastAttempt;
        probing = false;
        return TURN_STRATEGIES[chosen].name;
      },
      /** Turn the page. Returns the strategy tried, or null when all are spent. */
      turn() {
        if (!probing) {
          TURN_STRATEGIES[chosen].run();
          return TURN_STRATEGIES[chosen].name;
        }
        if (nextProbe >= TURN_STRATEGIES.length) return null;
        lastAttempt = nextProbe;
        nextProbe += 1;
        TURN_STRATEGIES[lastAttempt].run();
        return TURN_STRATEGIES[lastAttempt].name;
      }
    };
  }

  // src/content/scan.ts
  var STALL_LIMIT = 3;
  var MAX_ITERATIONS = 1e4;
  var MAX_SPREAD = 4;
  var REVISIT_LIMIT = 10;
  var QUALITY_MIN = 0.6;
  var QUALITY_MAX = 0.98;
  var QUALITY_DEFAULT = 0.88;
  var SETTLE_RATIO = 0.7;
  var wait2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  var running = false;
  var stopRequested = false;
  var live = null;
  var isRunning = () => running;
  function requestStop() {
    stopRequested = true;
  }
  function retune(options) {
    if (!live) return false;
    if (options?.delay !== void 0) live.delay = clampDelay(options.delay);
    if (options?.jitter !== void 0) live.jitter = clampJitter(options.jitter);
    return true;
  }
  function settingsFrom(options) {
    return {
      delay: clampDelay(options?.delay),
      jitter: clampJitter(options?.jitter),
      quality: Math.min(QUALITY_MAX, Math.max(QUALITY_MIN, Number(options?.quality) || QUALITY_DEFAULT)),
      split: options?.split !== false
    };
  }
  function revisitWatch(limit = REVISIT_LIMIT) {
    const seen = /* @__PURE__ */ new Set();
    let consecutive = 0;
    return {
      get revisits() {
        return consecutive;
      },
      /** Records the view just captured. True once the run should give up. */
      saw(primary) {
        if (!primary) return false;
        if (seen.has(primary)) {
          consecutive += 1;
        } else {
          consecutive = 0;
          seen.add(primary);
        }
        return consecutive >= limit;
      }
    };
  }
  function prepareBookMode(meta, settings) {
    if (!meta.captures.length) {
      meta.split = settings.split;
      meta.splitByGutter = settings.split;
      meta.quality = settings.quality;
      return;
    }
    if (meta.split === null) {
      throw new Error("This cache predates layout tracking. Save it or clear it before starting a new scan.");
    }
    if (meta.split !== settings.split) {
      throw new Error("The split setting differs from this cache. Clear the cached pages before changing it.");
    }
    if (meta.quality === null) meta.quality = settings.quality;
    else settings.quality = meta.quality;
  }
  async function captureRendered(meta, candidates, known, settings, position, startIndex) {
    const key = positionKey(position);
    let primary = "";
    let stored = 0;
    let index = startIndex;
    let offset = 0;
    const split = !meta.split ? "off" : meta.splitByGutter ? "gutter" : "aspect";
    for (const candidate of candidates.slice(0, MAX_SPREAD)) {
      let views = [];
      try {
        views = await viewsOf(candidate.element, split);
      } catch (error) {
        console.warn("Could not read a rendered page", error);
      }
      for (const view of views) {
        const isPrimary = offset === 0;
        if (isPrimary) primary = view.signature ?? "";
        if (view.signature && known.has(view.signature)) {
          offset += 1;
          continue;
        }
        let image = null;
        try {
          image = renderRegion(candidate.element, view.region, settings.quality);
        } catch (error) {
          console.warn("Could not copy a rendered page", error);
        }
        if (!image) {
          offset += 1;
          continue;
        }
        const identity = view.signature ?? fingerprintOf(image.dataUrl, image.width, image.height);
        if (isPrimary) primary = identity;
        if (!known.has(identity)) {
          known.add(identity);
          await storePage(meta, {
            index,
            position: isPrimary ? key : "",
            fingerprint: identity,
            page: position?.kind === "page" ? position.value + offset : null
          }, image);
          index += 1;
          stored += 1;
        }
        offset += 1;
      }
    }
    return { primary, stored };
  }
  async function performScan(book, options) {
    const settings = settingsFrom(options);
    live = settings;
    const meta = await loadMeta(book);
    prepareBookMode(meta, settings);
    const known = new Set(meta.captures.map((capture) => capture.fingerprint).filter(Boolean));
    const startCount = meta.captures.length;
    const prober = turnProber(meta.turnStrategy);
    const revisited = revisitWatch();
    let index = nextIndex(meta);
    let iterations = 0;
    let unmoved = 0;
    let sinceFlush = 0;
    let lastView = "";
    let outcome = "";
    const flush = async () => {
      sinceFlush = 0;
      await saveMeta(meta);
    };
    while (!stopRequested && iterations < MAX_ITERATIONS) {
      iterations += 1;
      await wait2(jitteredDelay(settings.delay * SETTLE_RATIO, settings.jitter));
      if (bookId() !== book) {
        outcome = `The reader moved to another book. ${meta.captures.length} pages stay cached.`;
        break;
      }
      const position = readerPosition();
      if (position) {
        meta.total = position.total;
        meta.kind = position.kind;
      }
      const candidates = pageCandidates();
      if (!candidates.length) {
        unmoved += 1;
        if (unmoved >= STALL_LIMIT) {
          outcome = meta.captures.length ? `No page is rendered any more. ${meta.captures.length} pages stay cached.` : "No rendered page found. Open a book and try again.";
          break;
        }
        notify("Waiting for a rendered page…");
        continue;
      }
      const result = await captureRendered(meta, candidates, known, settings, position, index);
      index += result.stored;
      sinceFlush += result.stored;
      if (sinceFlush >= META_FLUSH_EVERY) await flush();
      const moved = result.primary !== "" && result.primary !== lastView;
      if (result.primary) lastView = result.primary;
      if (revisited.saw(result.primary)) {
        outcome = `The reader stopped reaching new pages. ${plural(meta.captures.length, "page")} cached.`;
        break;
      }
      unmoved = moved ? 0 : unmoved + 1;
      if (unmoved >= prober.stallBudget(STALL_LIMIT)) {
        outcome = prober.probing ? `None of the page-turn methods moved the reader. ${plural(meta.captures.length, "page")} cached. Click once inside the book, then scan again.` : `The reader stopped advancing. ${meta.captures.length} pages cached.`;
        break;
      }
      if (moved) {
        const settled = prober.settle();
        if (settled) {
          meta.turnStrategy = settled;
          await flush();
        }
      }
      const skipped = result.stored === 0 ? " · nothing new on this view" : "";
      const outOf = meta.kind === "page" && meta.total ? ` of ~${meta.total}` : "";
      notify(`Cached ${meta.captures.length}${outOf} pages${skipped}`);
      if (position && position.value >= position.total) break;
      const tried = prober.turn();
      if (!tried) {
        outcome = "None of the page-turn methods moved the reader. Click once inside the book, then scan again.";
        break;
      }
      if (prober.probing) notify(`Trying page turn: ${tried}…`);
      await wait2(jitteredDelay(settings.delay, settings.jitter));
    }
    if (!outcome && iterations >= MAX_ITERATIONS) {
      outcome = `Stopped after ${MAX_ITERATIONS} iterations · ${meta.captures.length} pages cached.`;
    }
    if (!outcome) {
      const added = meta.captures.length - startCount;
      outcome = added ? `Scan stopped with ${meta.captures.length} pages cached (${added} new). Use “Save cached pages as PDF” when ready.` : `No new pages captured · ${meta.captures.length} already cached.`;
    }
    await flush();
    notify(outcome);
    removeNoticeLater();
  }
  async function scan(book, options) {
    running = true;
    stopRequested = false;
    try {
      await performScan(book, options);
    } finally {
      running = false;
      live = null;
    }
  }

  // src/content/main.ts
  async function bookState(book) {
    const meta = await loadMeta(book);
    const position = readerPosition();
    const candidates = pageCandidates();
    const kind = meta.kind ?? position?.kind ?? null;
    const recognised = await recognisedIndexes(book, meta.captures);
    return {
      bookId: meta.bookId,
      bookOpen: candidates.length > 0,
      scanning: isRunning(),
      count: meta.captures.length,
      total: kind === "page" ? meta.total ?? position?.total ?? null : null,
      kind,
      position,
      duplicates: countDuplicates(meta.captures),
      recognised: recognised.size,
      split: meta.split,
      quality: meta.quality
    };
  }
  var starting = false;
  async function startScan(book, options) {
    if (starting || isRunning()) return { message: "A scan is already running." };
    starting = true;
    try {
      const token = crypto.randomUUID();
      if (!await acquireBookScan(book, token)) {
        return { message: "This book is already being scanned in another reader tab." };
      }
      void scan(book, options).catch((error) => {
        notify(`Scan failed: ${error.message}`);
        removeNoticeLater();
      }).finally(() => releaseBookScan(book, token).catch((error) => {
        console.warn("Could not release the scan lock", error);
      }));
      return { message: "Scan started. Watch the status in the reader tab." };
    } finally {
      starting = false;
    }
  }
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const book = bookId();
    switch (request.action) {
      case "startScan":
        startScan(book, request.options).then(
          sendResponse,
          (error) => sendResponse({ error: `Scan could not start: ${error.message}` })
        );
        return true;
      case "retune":
        sendResponse({
          message: retune(request.options) ? "Pacing updated." : "No scan is running."
        });
        return false;
      case "stopScan":
        requestStop();
        sendResponse({
          message: isRunning() ? "Stopping after the current page…" : "No scan is running."
        });
        return false;
      case "getState":
        bookState(book).then(sendResponse, (error) => sendResponse({ error: error.message }));
        return true;
      default:
        sendResponse({ error: `Unknown action: ${request.action}` });
        return false;
    }
  });
})();
