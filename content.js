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
  async function* pagesInBatches(book, captures, size = READ_BATCH) {
    for (let start = 0; start < captures.length; start += size) {
      const batch = captures.slice(start, start + size);
      const stored = await chrome.storage.local.get(batch.map((c) => pageKey(book, c.index)));
      yield batch.map((capture) => ({
        capture,
        page: stored[pageKey(book, capture.index)]
      }));
    }
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
  async function clearBook(book) {
    const local = chrome.storage.local;
    const allKeys = typeof local.getKeys === "function" ? await local.getKeys() : Object.keys(await local.get(null));
    const pagePrefix = `book:${book}:page:`;
    const ocrPrefix = `book:${book}:ocr:`;
    const pages = allKeys.filter((key) => key.startsWith(pagePrefix));
    const ocr = allKeys.filter((key) => key.startsWith(ocrPrefix));
    await local.remove([metaKey(book), ...pages, ...ocr]);
    return pages.length;
  }
  function countDuplicates(captures) {
    const seen = /* @__PURE__ */ new Set();
    let duplicates = 0;
    for (const capture of captures) {
      if (!capture.fingerprint) continue;
      if (seen.has(capture.fingerprint)) duplicates += 1;
      seen.add(capture.fingerprint);
    }
    return duplicates;
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

  // src/pdf/paper.ts
  var NATIVE_POINTS_WIDE = 612;
  var PAPER_SIZES = {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 }
  };
  var DEFAULT_PAPER = "a4";
  var paperLabel = (paper) => paper === "a4" ? "A4" : paper === "letter" ? "US Letter" : "capture size";
  function layoutFor(imageWidth, imageHeight, paper) {
    if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
    if (paper === "native") {
      const height2 = NATIVE_POINTS_WIDE * imageHeight / imageWidth;
      return {
        pageWidth: NATIVE_POINTS_WIDE,
        pageHeight: height2,
        x: 0,
        y: 0,
        width: NATIVE_POINTS_WIDE,
        height: height2
      };
    }
    const size = PAPER_SIZES[paper];
    const landscape = imageWidth > imageHeight;
    const pageWidth = landscape ? size.height : size.width;
    const pageHeight = landscape ? size.width : size.height;
    const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
    const width = imageWidth * scale;
    const height = imageHeight * scale;
    return {
      pageWidth,
      pageHeight,
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height
    };
  }

  // src/pdf/text.ts
  var INVISIBLE = 3;
  var MIN_SIDE = 0.5;
  var MIN_STRETCH = 10;
  var MAX_STRETCH = 1e3;
  var WIDTHS = [
    278,
    278,
    355,
    556,
    556,
    889,
    667,
    191,
    333,
    333,
    389,
    584,
    278,
    333,
    278,
    278,
    556,
    556,
    556,
    556,
    556,
    556,
    556,
    556,
    556,
    556,
    278,
    278,
    584,
    584,
    584,
    556,
    1015,
    667,
    667,
    722,
    722,
    667,
    611,
    778,
    722,
    278,
    500,
    667,
    556,
    833,
    722,
    778,
    667,
    778,
    722,
    667,
    611,
    722,
    667,
    944,
    667,
    667,
    611,
    278,
    278,
    278,
    469,
    556,
    333,
    556,
    556,
    500,
    556,
    556,
    278,
    556,
    556,
    222,
    222,
    500,
    222,
    833,
    556,
    556,
    556,
    556,
    333,
    500,
    278,
    556,
    500,
    722,
    500,
    500,
    500,
    334,
    260,
    334,
    584
  ];
  var FALLBACK_WIDTH = 556;
  var WIN_ANSI_HIGH = /* @__PURE__ */ new Map([
    [8364, 128],
    [8218, 130],
    [402, 131],
    [8222, 132],
    [8230, 133],
    [8224, 134],
    [8225, 135],
    [710, 136],
    [8240, 137],
    [352, 138],
    [8249, 139],
    [338, 140],
    [381, 142],
    [8216, 145],
    [8217, 146],
    [8220, 147],
    [8221, 148],
    [8226, 149],
    [8211, 150],
    [8212, 151],
    [732, 152],
    [8482, 153],
    [353, 154],
    [8250, 155],
    [339, 156],
    [382, 158],
    [376, 159]
  ]);
  function winAnsi(text) {
    let out = "";
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code >= 32 && code <= 255) out += String.fromCharCode(code);
      else {
        const mapped = WIN_ANSI_HIGH.get(code);
        if (mapped !== void 0) out += String.fromCharCode(mapped);
      }
    }
    return out;
  }
  function pdfString(winAnsiText) {
    let out = "(";
    for (let i = 0; i < winAnsiText.length; i++) {
      const code = winAnsiText.charCodeAt(i);
      if (code === 40 || code === 41 || code === 92) out += `\\${winAnsiText[i]}`;
      else if (code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
      else out += winAnsiText[i];
    }
    return `${out})`;
  }
  function textWidth(winAnsiText) {
    let total = 0;
    for (let i = 0; i < winAnsiText.length; i++) {
      const code = winAnsiText.charCodeAt(i);
      total += code >= 32 && code <= 126 ? WIDTHS[code - 32] : FALLBACK_WIDTH;
    }
    return total / 1e3;
  }
  function textLayerOps(words, place) {
    const { scale, left, bottom, imageHeight } = place;
    let out = `BT
${INVISIBLE} Tr
`;
    let used = 0;
    for (const word of words) {
      const text = winAnsi(word.t);
      if (!text.trim()) continue;
      const boxWidth = (word.x1 - word.x0) * scale;
      const size = ((word.s ?? word.y1 - word.y0) || 0) * scale;
      if (boxWidth < MIN_SIDE || size < MIN_SIDE) continue;
      const natural = textWidth(text) * size;
      if (natural <= 0) continue;
      const stretch = Math.min(MAX_STRETCH, Math.max(MIN_STRETCH, 100 * boxWidth / natural));
      const x = left + word.x0 * scale;
      const y = bottom + (imageHeight - (word.b ?? word.y1)) * scale;
      out += `/F1 ${size.toFixed(2)} Tf ${stretch.toFixed(2)} Tz `;
      out += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(text)} Tj
`;
      used += 1;
    }
    return used ? `${out}ET
` : "";
  }

  // src/pdf/builder.ts
  var CATALOG_ID = 1;
  var PAGES_ID = 2;
  var FONT_ID = 3;
  var FIRST_PAGE_ID = 4;
  var IDS_PER_PAGE = 3;
  var encoder = new TextEncoder();
  var pt = (value) => value.toFixed(2);
  function bytesFromDataUrl(dataUrl) {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function pdfBuilder(options = {}) {
    const paper = options.paper ?? DEFAULT_PAPER;
    const parts = [];
    const offsets = [];
    const pageIds = [];
    let pending = [];
    let length = 0;
    let withText = 0;
    const push = (value) => {
      const bytes = typeof value === "string" ? encoder.encode(value) : value;
      pending.push(bytes);
      length += bytes.length;
    };
    const object = (id, body) => {
      offsets[id] = length;
      push(`${id} 0 obj
`);
      push(body);
      push("\nendobj\n");
    };
    const flush = () => {
      if (!pending.length) return;
      parts.push(new Blob(pending));
      pending = [];
    };
    push(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10]));
    push(new Uint8Array([37, 226, 227, 207, 211, 10]));
    return {
      get pages() {
        return pageIds.length;
      },
      get textPages() {
        return withText;
      },
      flush,
      addImage(image, words) {
        const layout = layoutFor(image.width, image.height, paper);
        if (!layout) return;
        const index = pageIds.length;
        const pageId = FIRST_PAGE_ID + index * IDS_PER_PAGE;
        const imageId = pageId + 1;
        const contentId = pageId + 2;
        pageIds.push(pageId);
        object(pageId, `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${pt(layout.pageWidth)} ${pt(layout.pageHeight)}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> /Font << /F1 ${FONT_ID} 0 R >> >> /Contents ${contentId} 0 R >>`);
        offsets[imageId] = length;
        push(`${imageId} 0 obj
<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>
stream
`);
        push(image.bytes);
        push("\nendstream\nendobj\n");
        let command = `q
${pt(layout.width)} 0 0 ${pt(layout.height)} ${pt(layout.x)} ${pt(layout.y)} cm
/Im${index} Do
Q
`;
        const text = words?.length ? textLayerOps(words, {
          scale: layout.width / image.width,
          left: layout.x,
          bottom: layout.y,
          imageHeight: image.height
        }) : "";
        if (text) {
          command += text;
          withText += 1;
        }
        object(contentId, `<< /Length ${command.length} >>
stream
${command}endstream`);
      },
      finish() {
        object(CATALOG_ID, `<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>`);
        object(PAGES_ID, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);
        object(FONT_ID, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        const xref = length;
        const count = FIRST_PAGE_ID + pageIds.length * IDS_PER_PAGE;
        push(`xref
0 ${count}
0000000000 65535 f 
`);
        for (let id = 1; id < count; id++) push(`${String(offsets[id] ?? 0).padStart(10, "0")} 00000 n 
`);
        push(`trailer
<< /Size ${count} /Root ${CATALOG_ID} 0 R >>
startxref
${xref}
%%EOF`);
        flush();
        return new Blob(parts, { type: "application/pdf" });
      }
    };
  }

  // src/pdf/export.ts
  var REVOKE_AFTER_MS = 6e4;
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  }
  async function saveCachedPdf(book, paper = DEFAULT_PAPER) {
    const meta = await loadMeta(book);
    if (!meta.captures.length) return { message: "No saved pages for this book." };
    notify(`Loading ${plural(meta.captures.length, "cached page")}…`);
    const builder = pdfBuilder({ paper });
    let unreadable = 0;
    for await (const batch of pagesInBatches(book, meta.captures)) {
      const ocr = await loadOcrBatch(book, batch.map(({ capture }) => capture));
      for (const { capture, page } of batch) {
        const bytes = page?.dataUrl ? bytesFromDataUrl(page.dataUrl) : null;
        if (!bytes || !page?.width || !page.height) {
          unreadable += 1;
          continue;
        }
        const words = ocr.get(capture.index);
        const usable = words && words.width === page.width && words.height === page.height;
        builder.addImage(
          { width: page.width, height: page.height, bytes },
          usable ? words.words : void 0
        );
      }
      builder.flush();
      notify(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
    }
    if (!builder.pages) {
      const message2 = "Saved pages could not be read back from storage.";
      notify(message2);
      removeNoticeLater();
      return { message: message2 };
    }
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    download(builder.finish(), `kindle-${book}-${date}.pdf`);
    const notes = [`${paperLabel(paper)} pages`];
    if (builder.textPages) notes.push(`${builder.textPages} with searchable text`);
    if (unreadable) notes.push(`${plural(unreadable, "page")} could not be read`);
    const message = `Saved ${builder.pages} pages as PDF · ${notes.join(" · ")}.`;
    notify(message);
    removeNoticeLater();
    return { message };
  }

  // src/content/dom.ts
  var PAGE_SELECTOR = ".kg-full-page-img img";
  var PAGE_FALLBACK_SELECTOR = ".kg-full-page-img img, canvas";
  var COUNTER_SELECTOR = '[item-i-d="reader-footer-title"], .reader-footer, [data-testid="footer"]';
  var COUNTER_PATTERN = /\b(Page|Location)\s+([\d,]+)\s+of\s+([\d,]+)\b/i;
  var RENDERER_SELECTOR = "#kr-renderer, .kr-renderer-container-fullpage";
  var NEXT_SELECTOR = '[aria-label="Next page"], .kr-chevron-container-right, .chevron.right';
  var MIN_PAGE_SIDE = 100;
  var DOMINANT_AREA_RATIO = 0.5;
  var MAX_ROOTS = 50;
  var MAX_ROOT_DEPTH = 3;
  var MAX_TEXT_NODES = 2e4;
  var counterHost = null;
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
  function pageCandidates() {
    let elements = [...document.querySelectorAll(PAGE_SELECTOR)];
    if (!elements.length) {
      elements = collectRoots().flatMap((root) => [...root.querySelectorAll(PAGE_FALLBACK_SELECTOR)]);
    }
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
  function signatureOf(element, region) {
    signatureCanvas ??= document.createElement("canvas");
    signatureCanvas.width = SIGNATURE_SIDE;
    signatureCanvas.height = SIGNATURE_SIDE;
    const context = signatureCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) return null;
    try {
      context.fillStyle = DEFAULT_BACKGROUND;
      context.fillRect(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
      context.drawImage(element, region.sx, region.sy, region.sw, region.sh, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
      const data = context.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE).data;
      let hash = FNV_OFFSET;
      for (let i = 0; i < data.length; i++) {
        if ((i & 3) === 3) continue;
        hash ^= data[i];
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
      }
      return `${region.sw}x${region.sh}-${hash.toString(36)}`;
    } catch {
      return null;
    }
  }
  async function viewsOf(element, split) {
    if (!await decoded(element)) return [];
    const { width, height } = naturalSize(element);
    return regionsFor(width, height, split).map((region) => ({
      region,
      signature: signatureOf(element, region)
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
        const button = document.querySelector(NEXT_SELECTOR);
        if (button) clickCentre(button);
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
  var plural2 = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
    for (const candidate of candidates.slice(0, MAX_SPREAD)) {
      let views = [];
      try {
        views = await viewsOf(candidate.element, settings.split);
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
        outcome = `The reader stopped reaching new pages. ${plural2(meta.captures.length, "page")} cached.`;
        break;
      }
      unmoved = moved ? 0 : unmoved + 1;
      if (unmoved >= prober.stallBudget(STALL_LIMIT)) {
        outcome = prober.probing ? `None of the page-turn methods moved the reader. ${plural2(meta.captures.length, "page")} cached. Click once inside the book, then scan again.` : `The reader stopped advancing. ${meta.captures.length} pages cached.`;
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
  async function clearCached(book) {
    if (isRunning()) return { message: "Stop the scan before clearing this book." };
    const cleared = await clearBook(book);
    const message = `Cleared ${cleared} saved pages.`;
    notify(message);
    removeNoticeLater();
    return { message };
  }
  function startScan(book, options) {
    if (isRunning()) return { message: "A scan is already running." };
    scan(book, options).catch((error) => {
      notify(`Scan failed: ${error.message}`);
      removeNoticeLater();
    });
    return { message: "Scan started. Watch the status in the reader tab." };
  }
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const book = bookId();
    switch (request.action) {
      case "startScan":
        sendResponse(startScan(book, request.options));
        return false;
      case "retune":
        sendResponse({
          message: retune(request.options) ? "Pacing updated." : "No scan is running."
        });
        return false;
      case "stopScan":
        requestStop();
        sendResponse({ message: isRunning() ? "Stopping…" : "No scan is running." });
        return false;
      case "getState":
        bookState(book).then(sendResponse, (error) => sendResponse({ error: error.message }));
        return true;
      case "saveCached":
        saveCachedPdf(book, request.paper).then(sendResponse, (error) => sendResponse({ error: `Save failed: ${error.message}` }));
        return true;
      case "clearCached":
        clearCached(book).then(sendResponse, (error) => sendResponse({ error: `Clear failed: ${error.message}` }));
        return true;
      default:
        sendResponse({ error: `Unknown action: ${request.action}` });
        return false;
    }
  });
})();
