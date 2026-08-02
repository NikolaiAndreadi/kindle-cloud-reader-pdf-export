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

  // src/pdf/paper.ts
  var NATIVE_POINTS_WIDE = 612;
  var PAPER_SIZES = {
    a4: { width: 595.28, height: 841.89 },
    letter: { width: 612, height: 792 }
  };
  var PAPER_NAMES = ["a4", "letter", "native"];
  var DEFAULT_PAPER = "a4";
  var isPaperName = (value) => typeof value === "string" && PAPER_NAMES.includes(value);
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

  // src/shared/storage.ts
  var READ_BATCH = 20;
  var metaKey = (book2) => `book:${book2}:meta`;
  var pageKey = (book2, index) => `book:${book2}:page:${String(index).padStart(6, "0")}`;
  var ocrKey = (book2, index, fingerprint) => `book:${book2}:ocr:${String(index).padStart(6, "0")}:${fingerprint}`;
  var ocrKeyFor = (book2, capture) => ocrKey(book2, capture.index, capture.fingerprint);
  var PAPER_KEY = "paper";
  var LEGACY_OPTIONS_KEY = "options";
  async function loadPaper() {
    const stored = await chrome.storage.local.get([PAPER_KEY, LEGACY_OPTIONS_KEY]);
    const paper = stored[PAPER_KEY];
    if (isPaperName(paper)) return paper;
    const legacy = stored[LEGACY_OPTIONS_KEY]?.paper;
    if (!isPaperName(legacy)) return DEFAULT_PAPER;
    await savePaper(legacy);
    return legacy;
  }
  var savePaper = (paper) => chrome.storage.local.set({ [PAPER_KEY]: paper });
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
  async function loadPageBatch(book2, captures) {
    const stored = await chrome.storage.local.get(captures.map((c) => pageKey(book2, c.index)));
    const found = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      const page = stored[pageKey(book2, capture.index)];
      if (page) found.set(capture.index, page);
    }
    return found;
  }
  async function* pagesInBatches(book2, captures, size = READ_BATCH) {
    for (let start = 0; start < captures.length; start += size) {
      const batch = captures.slice(start, start + size);
      const found = await loadPageBatch(book2, batch);
      yield batch.map((capture) => ({ capture, page: found.get(capture.index) }));
    }
  }
  async function setCaptureAsImage(book2, index, fingerprint, asImage) {
    const meta = await loadMeta(book2);
    const capture = meta.captures.find(
      (record) => record.index === index && record.fingerprint === fingerprint
    );
    if (!capture) return meta;
    if (asImage === null) delete capture.asImage;
    else capture.asImage = asImage;
    await saveMeta(meta);
    return meta;
  }
  async function flagPictureCapture(book2, capture) {
    const meta = await loadMeta(book2);
    const stored = meta.captures.find(
      (record) => record.index === capture.index && record.fingerprint === capture.fingerprint
    );
    if (!stored || stored.asImage !== void 0) return;
    stored.asImage = true;
    await saveMeta(meta);
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
  async function* ocrInBatches(book2, captures, size = READ_BATCH) {
    for (let start = 0; start < captures.length; start += size) {
      const batch = captures.slice(start, start + size);
      const found = await loadOcrBatch(book2, batch);
      yield batch.map((capture) => ({ capture, ocr: found.get(capture.index) }));
    }
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
  async function clearBook(book2) {
    const local = chrome.storage.local;
    const allKeys = typeof local.getKeys === "function" ? await local.getKeys() : Object.keys(await local.get(null));
    const pagePrefix = `book:${book2}:page:`;
    const ocrPrefix = `book:${book2}:ocr:`;
    const pages = allKeys.filter((key) => key.startsWith(pagePrefix));
    const ocr2 = allKeys.filter((key) => key.startsWith(ocrPrefix));
    await local.remove([metaKey(book2), ...pages, ...ocr2]);
    return pages.length;
  }
  function fingerprintCounts(captures) {
    const counts = /* @__PURE__ */ new Map();
    for (const capture of captures) {
      if (capture.fingerprint) counts.set(capture.fingerprint, (counts.get(capture.fingerprint) || 0) + 1);
    }
    return counts;
  }

  // src/pdf/text.ts
  var INVISIBLE = 3;
  var FILL = 0;
  var MIN_SIDE = 0.5;
  var MIN_STRETCH = 10;
  var MAX_STRETCH = 1e3;
  var MAX_VISIBLE_STRETCH = 105;
  var HELVETICA_WIDTHS = [
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
  var TIMES_WIDTHS = [
    250,
    333,
    408,
    500,
    500,
    833,
    778,
    180,
    333,
    333,
    500,
    564,
    250,
    333,
    250,
    278,
    500,
    500,
    500,
    500,
    500,
    500,
    500,
    500,
    500,
    500,
    278,
    278,
    564,
    564,
    564,
    444,
    921,
    722,
    667,
    667,
    722,
    611,
    556,
    722,
    722,
    333,
    389,
    722,
    611,
    889,
    722,
    722,
    556,
    722,
    667,
    556,
    611,
    722,
    722,
    944,
    722,
    722,
    611,
    333,
    278,
    333,
    469,
    500,
    333,
    444,
    500,
    444,
    500,
    444,
    333,
    500,
    500,
    278,
    278,
    500,
    278,
    778,
    500,
    500,
    500,
    500,
    333,
    389,
    278,
    500,
    500,
    722,
    500,
    500,
    444,
    480,
    200,
    480,
    541
  ];
  var HELVETICA = {
    resource: "F1",
    baseFont: "Helvetica",
    widths: HELVETICA_WIDTHS,
    fallback: 556
  };
  var TIMES_ROMAN = {
    resource: "F2",
    baseFont: "Times-Roman",
    widths: TIMES_WIDTHS,
    fallback: 500
  };
  var FONTS = [HELVETICA, TIMES_ROMAN];
  var fontFor = (style) => style === "visible" ? TIMES_ROMAN : HELVETICA;
  var X_HEIGHT_EMS = 0.45;
  var ASCENT_EMS = 0.7;
  var DESCENT_EMS = 0.21;
  var ASCENDING = /[A-Z0-9bdfhijklt£$(){}[\]/\\|!?"'*#@&%]/;
  var DESCENDING = /[gjpqyQ,;]/;
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
  function textWidth(winAnsiText, font = HELVETICA) {
    let total = 0;
    for (let i = 0; i < winAnsiText.length; i++) {
      const code = winAnsiText.charCodeAt(i);
      total += code >= 32 && code <= 126 ? font.widths[code - 32] : font.fallback;
    }
    return total / 1e3;
  }
  function metricsFor(word, estimate) {
    if (word.s !== void 0 && word.b !== void 0) return { size: word.s, baseline: word.b };
    const height = word.y1 - word.y0;
    if (!estimate) return { size: word.s ?? height, baseline: word.b ?? word.y1 };
    const above = ASCENDING.test(word.t) ? ASCENT_EMS : X_HEIGHT_EMS;
    const below = DESCENDING.test(word.t) ? DESCENT_EMS : 0;
    const size = word.s ?? height / (above + below);
    return { size, baseline: word.b ?? word.y1 - below * size };
  }
  function textLayerOps(words, place, style = "invisible") {
    const { scale, left, bottom, imageHeight } = place;
    const visible = style === "visible";
    const font = fontFor(style);
    const maxStretch = visible ? MAX_VISIBLE_STRETCH : MAX_STRETCH;
    let out = `BT
${visible ? FILL : INVISIBLE} Tr
`;
    let used = 0;
    for (const word of words) {
      const text = winAnsi(word.t);
      if (!text.trim()) continue;
      const boxWidth = (word.x1 - word.x0) * scale;
      const metrics = metricsFor(word, visible);
      const size = (metrics.size || 0) * scale;
      if (boxWidth < MIN_SIDE || size < MIN_SIDE) continue;
      const natural = textWidth(text, font) * size;
      if (natural <= 0) continue;
      const stretch = Math.min(maxStretch, Math.max(MIN_STRETCH, 100 * boxWidth / natural));
      const x = left + word.x0 * scale;
      const y = bottom + (imageHeight - metrics.baseline) * scale;
      out += `/${font.resource} ${size.toFixed(2)} Tf ${stretch.toFixed(2)} Tz `;
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
  var FIRST_FONT_ID = 3;
  var FIRST_PAGE_ID = FIRST_FONT_ID + FONTS.length;
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
    const mode = options.mode ?? "scan";
    const parts = [];
    const offsets = [];
    const pageIds = [];
    let pending = [];
    let length = 0;
    let withText = 0;
    let withImage = 0;
    let nextId = FIRST_PAGE_ID;
    const claim = () => nextId++;
    const fontResources = FONTS.map((font, i) => `/${font.resource} ${FIRST_FONT_ID + i} 0 R`).join(" ");
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
      get imagePages() {
        return withImage;
      },
      get textPages() {
        return withText;
      },
      flush,
      addPage(page, words) {
        const layout = layoutFor(page.width, page.height, paper);
        if (!layout) return;
        const image = page.bytes;
        if (mode !== "text" && !image) return;
        const style = image ? "invisible" : "visible";
        const index = pageIds.length;
        const pageId = claim();
        const imageId = image ? claim() : 0;
        const contentId = claim();
        pageIds.push(pageId);
        const xobject = image ? `/XObject << /Im${index} ${imageId} 0 R >> ` : "";
        object(pageId, `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${pt(layout.pageWidth)} ${pt(layout.pageHeight)}] /Resources << ${xobject}/Font << ${fontResources} >> >> /Contents ${contentId} 0 R >>`);
        let command = "";
        if (image) {
          withImage += 1;
          offsets[imageId] = length;
          push(`${imageId} 0 obj
<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>
stream
`);
          push(image);
          push("\nendstream\nendobj\n");
          command = `q
${pt(layout.width)} 0 0 ${pt(layout.height)} ${pt(layout.x)} ${pt(layout.y)} cm
/Im${index} Do
Q
`;
        }
        const text = words?.length ? textLayerOps(words, {
          scale: layout.width / page.width,
          left: layout.x,
          bottom: layout.y,
          imageHeight: page.height
        }, style) : "";
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
        FONTS.forEach((font, i) => {
          object(
            FIRST_FONT_ID + i,
            `<< /Type /Font /Subtype /Type1 /BaseFont /${font.baseFont} /Encoding /WinAnsiEncoding >>`
          );
        });
        const xref = length;
        const count = nextId;
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
  async function saveCachedPdf(book2, options, report) {
    const meta = await loadMeta(book2);
    if (!meta.captures.length) return { message: "No saved pages for this book." };
    const mode = options.mode;
    report(`Loading ${plural(meta.captures.length, "cached page")}…`);
    const builder = pdfBuilder({ paper: options.paper, mode });
    const written = mode === "text" ? await writeTextPages(book2, meta, builder, report) : await writeScannedPages(book2, meta, builder, report);
    if (written.blocked) return { message: written.blocked };
    if (!builder.pages) {
      return { message: "Saved pages could not be read back from storage." };
    }
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    download(builder.finish(), `kindle-${book2}${mode === "text" ? "-text" : ""}-${date}.pdf`);
    const notes = [`${paperLabel(options.paper)} pages`];
    if (mode === "text") {
      notes.push(`${builder.textPages} with recognised text`);
      if (builder.imagePages) notes.push(`${plural(builder.imagePages, "page")} kept as pictures`);
    } else if (builder.textPages) notes.push(`${builder.textPages} with searchable text`);
    if (written.unreadable) notes.push(`${plural(written.unreadable, "page")} could not be read`);
    return { message: `Saved ${builder.pages} pages as PDF · ${notes.join(" · ")}.` };
  }
  async function writeScannedPages(book2, meta, builder, report) {
    let unreadable = 0;
    for await (const batch of pagesInBatches(book2, meta.captures)) {
      const ocr2 = await loadOcrBatch(book2, batch.map(({ capture }) => capture));
      for (const { capture, page } of batch) {
        const bytes = page?.dataUrl ? bytesFromDataUrl(page.dataUrl) : null;
        if (!bytes || !page?.width || !page.height) {
          unreadable += 1;
          continue;
        }
        const words = ocr2.get(capture.index);
        const usable = words && words.width === page.width && words.height === page.height;
        builder.addPage(
          { width: page.width, height: page.height, bytes },
          usable ? words.words : void 0
        );
      }
      builder.flush();
      report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
    }
    return { unreadable };
  }
  var sizeOf = (record) => record?.width && record.height ? { width: record.width, height: record.height } : void 0;
  async function writeTextPages(book2, meta, builder, report) {
    let recognised = 0;
    let unreadable = 0;
    let previous;
    let waiting = 0;
    for await (const batch of ocrInBatches(book2, meta.captures)) {
      const wanted = batch.filter(({ capture, ocr: ocr2 }) => capture.asImage || !sizeOf(ocr2)).map(({ capture }) => capture);
      const pages = wanted.length ? await loadPageBatch(book2, wanted) : void 0;
      for (const { capture, ocr: ocr2 } of batch) {
        const measured = sizeOf(ocr2) ? ocr2 : void 0;
        const stored = pages?.get(capture.index);
        const size = sizeOf(measured) ?? sizeOf(stored);
        if (!size) {
          unreadable += 1;
          if (!previous) {
            waiting += 1;
            continue;
          }
          builder.addPage(previous);
          continue;
        }
        const bytes = capture.asImage && stored?.dataUrl && sizeOf(stored) ? bytesFromDataUrl(stored.dataUrl) ?? void 0 : void 0;
        const placeable = bytes ? measured?.width === stored?.width && measured?.height === stored?.height : true;
        previous = bytes ? sizeOf(stored) ?? size : size;
        for (; waiting > 0; waiting--) builder.addPage(previous);
        builder.addPage(
          bytes ? { ...previous, bytes } : previous,
          placeable ? measured?.words : void 0
        );
        if (measured) recognised += 1;
        if (capture.asImage && !bytes) unreadable += 1;
      }
      builder.flush();
      report(`Preparing PDF · ${builder.pages} of ${meta.captures.length} pages…`);
    }
    if (!recognised) {
      return { blocked: 'No recognised text in this book yet — run "Add searchable text (OCR)" first.' };
    }
    for (; waiting > 0 && previous; waiting--) builder.addPage(previous);
    return { unreadable };
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
    ocrStatus: required("ocrStatus"),
    paper: required("paper"),
    save: required("save"),
    saveText: required("saveText"),
    saveStatus: required("saveStatus"),
    clear: required("clear")
  };
  var EMPTY_TEXT = "Nothing captured for this book yet.";
  var plural2 = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  var message = (error) => error instanceof Error ? error.message : String(error);
  function span(text, className) {
    const node = document.createElement("span");
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  // src/preview/actions.ts
  var HOLD_MS = 2e3;
  var BookActions = class {
    book;
    grid;
    saving = false;
    ocrBusy = false;
    constructor(book2, grid2) {
      this.book = book2;
      this.grid = grid2;
      ui.save.addEventListener("click", () => void this.save("scan"));
      ui.saveText.addEventListener("click", () => void this.save("text"));
      this.bindHold();
      void loadPaper().then((paper) => {
        ui.paper.value = paper;
      });
      ui.paper.addEventListener("change", () => {
        if (isPaperName(ui.paper.value)) void savePaper(ui.paper.value);
      });
      addEventListener("beforeunload", (event) => {
        if (this.saving) event.preventDefault();
      });
      this.describe();
    }
    /** Told by the OCR controller, which owns the other long job on this page. */
    setOcrBusy(busy) {
      this.ocrBusy = busy;
      this.describe();
    }
    /**
     * Called on every grid change as well as at the ends of both long jobs, so the
     * two buttons always agree with what there is to act on. Clearing is held to a
     * stricter rule than saving: reading the cache while a scan appends to it is
     * merely incomplete, while deleting it underneath a scan or an OCR run breaks
     * the job that is running.
     */
    describe() {
      const empty = !this.grid.captures.length;
      ui.save.disabled = empty || this.saving;
      const recognised = this.grid.recognisedCount();
      const pictures = this.grid.imageCount();
      ui.saveText.disabled = empty || this.saving || !recognised;
      ui.saveText.title = recognised ? `Vector text from ${plural2(recognised, "recognised page")}${pictures ? `, keeping ${plural2(pictures, "page")} as images` : " — no page images"}.` : "Add searchable text (OCR) first: a text PDF is made of the recognised words.";
      ui.clear.disabled = empty || this.saving || this.ocrBusy || this.grid.locked;
    }
    async save(mode) {
      if (this.saving) return;
      this.saving = true;
      this.describe();
      try {
        const paper = isPaperName(ui.paper.value) ? ui.paper.value : DEFAULT_PAPER;
        const result = await saveCachedPdf(this.book, { paper, mode }, (text) => {
          ui.saveStatus.textContent = text;
        });
        ui.saveStatus.textContent = result.message;
      } catch (error) {
        ui.saveStatus.textContent = `Save failed: ${message(error)}`;
      } finally {
        this.saving = false;
        this.describe();
      }
    }
    async clear() {
      ui.saveStatus.textContent = "";
      if (await scanRunning(this.book)) {
        this.grid.setLocked(true);
        this.describe();
        return;
      }
      await clearBook(this.book);
      this.grid.showMessage(EMPTY_TEXT);
    }
    /**
     * Clearing is the only irreversible thing here, so it is held rather than
     * clicked: a confirm() dialog is dismissed by reflex, and it asks the question
     * somewhere other than where the action was taken. The button fills as it is
     * held so the wait reads as progress rather than a dead press.
     */
    bindHold() {
      ui.clear.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
      let timer;
      const reset = () => {
        if (timer !== void 0) clearTimeout(timer);
        timer = void 0;
        ui.clear.classList.remove("holding");
      };
      const start = () => {
        if (timer !== void 0 || ui.clear.disabled) return;
        ui.clear.classList.add("holding");
        timer = setTimeout(() => {
          reset();
          if (ui.clear.disabled) return;
          void this.clear().catch((error) => {
            ui.saveStatus.textContent = `Clear failed: ${message(error)}`;
          });
        }, HOLD_MS);
      };
      const cancel = reset;
      ui.clear.addEventListener("pointerdown", start);
      for (const event of ["pointerup", "pointerleave", "pointercancel"]) {
        ui.clear.addEventListener(event, cancel);
      }
      addEventListener("blur", cancel);
      ui.clear.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") start();
      });
      ui.clear.addEventListener("keyup", cancel);
    }
  };

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
    /** How many pages the text PDF would keep as bitmaps. */
    imageCount() {
      return this.records.filter((capture) => capture.asImage).length;
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
        tile.asImage.disabled = value;
      }
    }
    /**
     * The size every page of this book was captured at. A scan pins the reader's
     * layout, so this is one number for the whole book — but a cache can still
     * hold two, from a spread captured before splitting was turned on or a window
     * resized between two runs, and that is worth saying because it decides how
     * the pages sit on the paper. Empty until the first page has loaded.
     */
    capturedSize() {
      const sizes = /* @__PURE__ */ new Set();
      for (const tile of this.tiles.values()) {
        if (tile.size) sizes.add(tile.size);
      }
      if (sizes.size > 1) return `${sizes.size} capture sizes`;
      for (const size of sizes) return size;
      return null;
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
      const byIndex = new Map(this.records.map((capture) => [capture.index, capture]));
      for (const [index, tile] of this.tiles) {
        const repeated = (counts.get(tile.fingerprint) || 0) > 1;
        tile.figure.classList.toggle("dupe", repeated);
        tile.label.textContent = tile.text + (repeated ? " · repeat" : "");
        tile.mark.textContent = this.recognised.has(index) ? "text" : "";
        tile.asImage.checked = byIndex.get(index)?.asImage === true;
      }
      ui.summary.replaceChildren(span(plural2(this.records.length, "page")));
      if (this.total) ui.summary.append(span(` of about ${this.total}`));
      const size = this.capturedSize();
      if (size) ui.summary.append(span(` · ${size}`));
      if (duplicates) {
        ui.summary.append(span(" · "), span(plural2(duplicates, "duplicate"), "warn"));
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
        if (!this.records.length) this.showMessage(EMPTY_TEXT);
        else this.refresh();
      } catch (error) {
        button.disabled = this.editLocked;
        this.showError(error);
      }
    }
    /**
     * The per-page "img" box: keep this one as a bitmap when the text PDF is
     * written. It only means anything to that export — a scan is all bitmaps — so
     * it is a quiet box in the caption rather than a control of its own.
     *
     * An OCR run ticks it for any page whose ink its words do not account for, and
     * a click here overrules that for good: the run only writes the flag where
     * nothing has decided it yet.
     */
    imageBox(capture) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "asimg";
      box.checked = capture.asImage === true;
      box.disabled = this.editLocked;
      const control = document.createElement("label");
      control.className = "asimg";
      control.title = "Keep this page as an image in the text PDF — for plates, maps and anything OCR cannot set as type.";
      control.append(box, span("img"));
      control.draggable = false;
      box.addEventListener("change", () => void this.setAsImage(capture, box));
      return { box, control };
    }
    async setAsImage(capture, box) {
      const wanted = box.checked;
      try {
        if (!await this.mayEdit()) {
          box.checked = !wanted;
          return;
        }
        const meta = await setCaptureAsImage(
          this.book,
          capture.index,
          capture.fingerprint,
          wanted
        );
        this.records = meta.captures;
        this.refresh();
      } catch (error) {
        box.checked = !wanted;
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
        caption.append(label);
      } else {
        figure.classList.add("gone");
        label.textContent = `${text} — missing from storage`;
        caption.append(label);
      }
      const mark = span(this.recognised.has(capture.index) ? "text" : "", "text");
      const { box: asImage, control } = this.imageBox(capture);
      const remove = this.deleteButton(capture.index, figure);
      caption.append(mark, control, remove);
      figure.append(caption);
      this.tiles.set(capture.index, {
        figure,
        label,
        text,
        mark,
        asImage,
        remove,
        fingerprint: capture.fingerprint,
        size: page?.width && page.height ? `${page.width}×${page.height}` : null
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

  // src/ocr/picture.ts
  var SAMPLE_SIDE = 200;
  var PICTURE_THRESHOLD = 0.08;
  var INK_BELOW = 0.8;
  var SATURATED_ABOVE = 0.18;
  var BOX_MARGIN = 0.35;
  function pictureScore(sample2, words, pageWidth, pageHeight) {
    const { data, width, height } = sample2;
    const pixels = width * height;
    if (!pixels || !(pageWidth > 0) || !(pageHeight > 0)) return 0;
    const claimed = new Uint8Array(pixels);
    const scaleX = width / pageWidth;
    const scaleY = height / pageHeight;
    for (const word of words) {
      const margin = (word.y1 - word.y0) * BOX_MARGIN;
      const x0 = Math.max(0, Math.floor((word.x0 - margin) * scaleX));
      const x1 = Math.min(width, Math.ceil((word.x1 + margin) * scaleX));
      const y0 = Math.max(0, Math.floor((word.y0 - margin) * scaleY));
      const y1 = Math.min(height, Math.ceil((word.y1 + margin) * scaleY));
      for (let y = y0; y < y1; y++) claimed.fill(1, y * width + x0, y * width + x1);
    }
    let loose = 0;
    for (let i = 0; i < pixels; i++) {
      if (claimed[i]) continue;
      const red = data[i * 4] / 255;
      const green = data[i * 4 + 1] / 255;
      const blue = data[i * 4 + 2] / 255;
      const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (luminance < INK_BELOW || saturation > SATURATED_ABOVE) loose += 1;
    }
    return loose / pixels;
  }
  var looksLikePicture = (score) => score >= PICTURE_THRESHOLD;

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
  function sample(source, thumbnail) {
    const scale = Math.min(1, SAMPLE_SIDE / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    thumbnail.width = width;
    thumbnail.height = height;
    const context = thumbnail.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }
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
    const thumbnail = document.createElement("canvas");
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
        const thumb = sample(scratch, thumbnail);
        return {
          words,
          confidence: words.length ? Math.round(confidence / words.length) : 0,
          picture: thumb ? Math.round(pictureScore(thumb, words, width, height) * 1e3) / 1e3 : 0
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
                const { words, confidence, picture } = await recogniser.page(page.dataUrl, page.width, page.height);
                await storeOcr(book2, capture, {
                  index: capture.index,
                  width: page.width,
                  height: page.height,
                  words,
                  confidence,
                  picture
                });
                if (looksLikePicture(picture)) await flagPictureCapture(book2, capture);
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
    /** Clearing the book underneath a run would delete the pages it is reading. */
    onBusy = () => {
    };
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
      ui.ocrStatus.textContent = done === total ? `All ${plural2(total, "page")} carry searchable text.` : `${done} of ${total} pages have a text layer · the PDF gets one wherever it exists.`;
    }
    async start() {
      if (this.running) return;
      this.running = true;
      this.onBusy(true);
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
        const skipped = result.skipped ? `, ${plural2(result.skipped, "page")} skipped` : "";
        outcome = result.stopped ? `Stopped after ${plural2(result.recognised, "page")}${skipped}. Start again to carry on.` : `Finished — ${plural2(result.recognised, "page")} recognised${skipped}.`;
      } catch (error) {
        outcome = `OCR failed: ${message(error)}`;
      } finally {
        this.running = false;
        this.onBusy(false);
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
  var actions = new BookActions(book, grid);
  grid.onChange = () => {
    ocr.describe();
    actions.describe();
  };
  ocr.onBusy = (busy) => actions.setOcrBusy(busy);
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
      grid.showMessage(EMPTY_TEXT);
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
    actions.describe();
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
