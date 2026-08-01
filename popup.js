"use strict";
(() => {
  // src/pdf/paper.ts
  var PAPER_NAMES = ["a4", "letter", "native"];
  var DEFAULT_PAPER = "a4";
  var isPaperName = (value) => typeof value === "string" && PAPER_NAMES.includes(value);

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
  var READER_HOME = "https://read.amazon.com/";
  function isReaderUrl(value) {
    if (!value) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && READER_HOST_SET.has(url.hostname);
    } catch {
      return false;
    }
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
  var jitterCeiling = (base, level) => Math.round(base * (1 + JITTER_SHARE * level));

  // src/popup/elements.ts
  function required(selector) {
    const node = document.querySelector(selector);
    if (!node) throw new Error(`Missing element: ${selector}`);
    return node;
  }
  var ui = {
    status: required("#status"),
    controls: required("#controls"),
    cache: required("#cache"),
    delay: required("#delay"),
    delayValue: required("#delayValue"),
    jitter: required("#jitter"),
    jitterValue: required("#jitterValue"),
    quality: required("#quality"),
    paper: required("#paper"),
    split: required("#split"),
    bookOptions: required("#bookOptions"),
    bookNote: required("#bookNote"),
    open: required("#open"),
    start: required("#start"),
    stop: required("#stop"),
    save: required("#save"),
    clear: required("#clear"),
    preview: required("#preview")
  };

  // src/popup/render.ts
  var NOTICE_MS = 4e3;
  var noticeUntil = 0;
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function notice(message) {
    noticeUntil = Date.now() + NOTICE_MS;
    ui.status.textContent = message;
  }
  var seconds = (ms) => `${(ms / 1e3).toFixed(1)} s`;
  function showTiming() {
    const delay = Number(ui.delay.value);
    const jitter = Number(ui.jitter.value);
    ui.delayValue.textContent = seconds(delay);
    ui.jitterValue.textContent = jitter ? `${seconds(delay)}–${seconds(jitterCeiling(delay, jitter))}` : "off";
  }
  function statusFor(state) {
    if (state.scanning) return "Scanning — watch the banner in the reader tab.";
    if (!state.bookOpen) return "No book is open in this tab. Open one, then scan.";
    return "Ready to scan.";
  }
  function cacheFor(state) {
    if (!state.count) return `No saved pages yet · ${state.bookId}`;
    const dupes = state.duplicates ? ` · ${plural(state.duplicates, "duplicate")}` : "";
    const outOf = state.total ? ` of ~${state.total}` : "";
    const text = state.recognised === state.count ? " · all searchable" : state.recognised ? ` · ${state.recognised}/${state.count} searchable` : " · no text layer yet";
    return `${plural(state.count, "saved view")}${outOf}${dupes}${text} · ${state.bookId}`;
  }
  function lockBookOptions(state) {
    const locked = Boolean(state?.count);
    ui.quality.disabled = locked;
    ui.split.disabled = locked;
    ui.bookOptions.classList.toggle("locked", locked);
    if (locked) ui.bookOptions.title = "Available only for a new scan";
    else ui.bookOptions.removeAttribute("title");
    ui.bookNote.hidden = locked;
    if (!locked || !state) return;
    if (state.split !== null) ui.split.checked = state.split;
    const choice = [...ui.quality.options].find((option) => Number(option.value) === state.quality);
    if (choice) ui.quality.value = choice.value;
  }
  function apply(state, onReader, problem) {
    const ready = state?.bookOpen === true;
    const spoken = Date.now() < noticeUntil;
    ui.open.hidden = onReader;
    ui.controls.hidden = !ready;
    lockBookOptions(state);
    ui.preview.hidden = !state?.count;
    ui.start.disabled = !ready;
    ui.stop.disabled = !state?.scanning;
    ui.save.disabled = !state?.count;
    ui.clear.disabled = !state?.count || state.scanning;
    if (!state) {
      if (!spoken) ui.status.textContent = problem || "Open read.amazon.com to begin.";
      ui.cache.textContent = "";
      return;
    }
    if (!spoken) ui.status.textContent = statusFor(state);
    ui.cache.textContent = cacheFor(state);
  }

  // src/popup/main.ts
  var POLL_MS = 1e3;
  var HOLD_MS = 2e3;
  var currentBook = null;
  var paperChoice = () => isPaperName(ui.paper.value) ? ui.paper.value : DEFAULT_PAPER;
  var uiOptions = () => ({
    delay: Number(ui.delay.value),
    jitter: Number(ui.jitter.value),
    quality: Number(ui.quality.value),
    split: ui.split.checked,
    paper: paperChoice()
  });
  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }
  async function send(action, extra = {}) {
    const tab = await activeTab();
    if (!tab?.id || !isReaderUrl(tab.url)) {
      throw new Error("Open a book at read.amazon.com first.");
    }
    const response = await chrome.tabs.sendMessage(
      tab.id,
      { action, ...extra }
    );
    if ("error" in response) throw new Error(response.error);
    return response;
  }
  function describe(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /Could not establish connection|Receiving end does not exist/i.test(message) ? "Reload the reader tab, then try again — the extension was not loaded when the page opened." : message;
  }
  async function refreshState() {
    let onReader = false;
    try {
      onReader = isReaderUrl((await activeTab())?.url);
      const state = await send("getState");
      currentBook = state.bookId;
      apply(state, onReader);
    } catch (error) {
      currentBook = null;
      apply(null, onReader, describe(error));
    }
  }
  async function perform(run) {
    try {
      const message = await run();
      if (message !== null) notice(message);
      await refreshState();
    } catch (error) {
      notice(describe(error));
    }
  }
  function onClick(button, run) {
    button.addEventListener("click", () => void perform(run));
  }
  function holdToClear(button, run) {
    button.style.setProperty("--hold-ms", `${HOLD_MS}ms`);
    let timer;
    const reset = () => {
      if (timer !== void 0) clearTimeout(timer);
      timer = void 0;
      button.classList.remove("holding");
    };
    const start = () => {
      if (timer !== void 0 || button.disabled) return;
      button.classList.add("holding");
      timer = setTimeout(() => {
        reset();
        if (!button.disabled) void perform(run);
      }, HOLD_MS);
    };
    const cancel = () => {
      if (timer === void 0) return;
      reset();
      notice("Hold the button to clear this book.");
    };
    button.addEventListener("pointerdown", start);
    for (const event of ["pointerup", "pointerleave", "pointercancel"]) {
      button.addEventListener(event, cancel);
    }
    addEventListener("blur", cancel);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") start();
    });
    button.addEventListener("keyup", cancel);
  }
  onClick(ui.open, async () => {
    const tabs = await chrome.tabs.query({});
    const reader = tabs.find((tab) => isReaderUrl(tab.url));
    if (reader?.id !== void 0) {
      await chrome.tabs.update(reader.id, { active: true });
      if (reader.windowId !== void 0) await chrome.windows.update(reader.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: READER_HOME });
    }
    window.close();
    return null;
  });
  onClick(ui.preview, async () => {
    if (!currentBook) return null;
    await chrome.tabs.create({
      url: `${chrome.runtime.getURL("preview.html")}?book=${encodeURIComponent(currentBook)}`
    });
    window.close();
    return null;
  });
  onClick(ui.start, async () => {
    const options = uiOptions();
    await chrome.storage.local.set({ options });
    const result = await send("startScan", { options });
    return result.message || "Scan started. You may close this popup.";
  });
  onClick(ui.save, async () => {
    notice("Building PDF in the reader tab…");
    return (await send("saveCached", { paper: paperChoice() })).message;
  });
  onClick(ui.stop, async () => {
    await send("stopScan");
    return "Stopping after the current page…";
  });
  holdToClear(ui.clear, async () => (await send("clearCached")).message);
  async function remember(pacing) {
    const options = uiOptions();
    await chrome.storage.local.set({ options });
    if (!pacing) return;
    try {
      await send("retune", { options });
    } catch {
    }
  }
  for (const control of [ui.quality, ui.split, ui.paper]) {
    control.addEventListener("change", () => void remember(false));
  }
  for (const slider of [ui.delay, ui.jitter]) {
    slider.addEventListener("input", showTiming);
    slider.addEventListener("change", () => void remember(true));
  }
  showTiming();
  chrome.storage.local.get("options").then(({ options }) => {
    if (options) {
      if (options.delay !== void 0) ui.delay.value = String(clampDelay(options.delay));
      if (options.jitter !== void 0) ui.jitter.value = String(clampJitter(options.jitter));
      if (options.quality && !ui.quality.disabled) ui.quality.value = String(options.quality);
      if (options.split !== void 0 && !ui.split.disabled) ui.split.checked = options.split;
      if (isPaperName(options.paper)) ui.paper.value = options.paper;
      showTiming();
    }
  });
  void refreshState();
  var polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void refreshState().finally(() => {
      polling = false;
    });
  }, POLL_MS);
})();
