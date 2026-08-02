# Personal Cloud Reader Export

A small Chrome extension that captures pages already rendered by Kindle Cloud
Reader and saves them as a PDF on a real paper size, optionally with an invisible
OCR text layer so the pages are searchable and selectable. It does not download
Kindle book files, decrypt content, or communicate with any third-party service —
the OCR engine is bundled and runs locally. Use it only for books and material
you are authorized to copy.

## Build

```sh
npm install
npm run build
```

- `npm run build` — typechecks, then bundles `src/` to `content.js`, `popup.js`, `preview.js`
- `npm run watch` — rebuild on every change (no typecheck, inline source maps)
- `npm run typecheck` — types only, emits nothing
- `npm run lint` — Biome; `npm run lint:fix` applies what it can
- `npm test` — unit tests for the pure logic
- `npm run check` — typecheck, lint and test together
- `npm run vendor` — re-copies the OCR engine from `node_modules` into `vendor/tesseract`
- `npm run fixture` — serves this directory on port 8973 for the offline test pages:
  `test/fixture.html` for scanning, `test/ocr-fixture.html` for the OCR engine

`vendor/tesseract` is checked in so **Load unpacked** works on a fresh clone with no
build. Only `npm run vendor` should write to it; the build fails if a file is missing.
Licenses and exact upstream versions are listed in
`vendor/tesseract/THIRD_PARTY_NOTICES.md` and ship with the runtime assets.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open a book at <https://read.amazon.com/> (regional domains such as
   `read.amazon.co.uk` and `read.amazon.com.br` work too).
5. Click the extension and choose **Scan / resume**. The same button says **Stop**
   while a scan is running.
6. Stop whenever you like; the captured pages remain cached per book.
7. Choose **See captured pages and save PDF**. Everything that acts on the whole
   book lives on that page: reordering, deleting single pages, **Add searchable
   text (OCR)**, the **Page size** and **Save PDF** in the top right, and
   **Clear this book**.

Keep the reader tab visible while it scans. If pages are skipped, choose the slower
page delay.

## How it works

Kindle Cloud Reader only keeps the current rendered page or spread in the DOM. The
extension copies the visible page images (`.kg-full-page-img img`, drawn at their
full natural resolution rather than the cropped on-screen box) to JPEG, reads
Kindle's `Page X of Y` counter from the reader footer, sends an Arrow Right event,
and waits for the next render. Each page is saved in extension-local storage under
the book ASIN, so later scans can skip saved pages. On request, the extension
streams the cached JPEGs into a minimal PDF container a batch at a time, so a long
book never has to fit in memory at once.

One captured image is not necessarily one book page. In two-column mode the reader
paints the whole spread as a single landscape bitmap. **Split two-page spreads**
(on by default) cuts any landscape capture down the middle into two portrait
pages, so the reader's layout never has to be changed by hand. A portrait capture
is never touched, so switching the reader to single column simply turns splitting
off by itself.

Whether the reader turned, and whether a view is new, are both decided by hashing
the rendered pixels. Never by the counter. The counter skips numbers and repeats
them as Amazon reflows the book for the window width, so a repeat cannot be told
apart from a stall, and trusting it would silently drop pages.

The hash comes from a 128x128 downscale of the source bitmap, which is cheap
enough to compute before deciding whether to encode. So a view already captured
costs almost nothing, resuming does not re-encode the whole book, and changing the
JPEG quality between scans does not break duplicate detection. An identical view
is never stored twice, so a reader that refuses to turn produces one page and a
clear message rather than a run of identical pages.

Page turning is probed rather than assumed. Dispatched key events carry
`isTrusted: false` and an extension cannot forge that, so a reader that checks it
ignores them however they are aimed. The scan tries the "Next page" chevron, key
events on several targets, and a click near the right edge, keeps whichever one
actually moves the reader, and records it so later scans skip the probing.

The scan stops on its own when the reader stops advancing, when the page count is
reached, when no page-turn method works, when pages cannot be copied at all, or
when you press **Stop**.

## Page size

Captures are whatever pixel size the reader happened to paint, which used to become
the PDF page size — a stack of pages no printer or e-reader had a name for. Every
page is now written on one sheet: **A4**, **US Letter**, or **Match capture** for
the old behaviour. The bitmap is fitted inside the sheet and centred, so a shape
that does not match leaves even bands rather than being cropped or stretched, and
the sheet takes the orientation of the capture — a spread saved without splitting
gets a landscape page instead of half a portrait one.

## Searchable text

The reader paints pages as images, so there is no text in the DOM to copy: the only
route to a text layer is to read the pixels back. **Add searchable text (OCR)** in
the preview page runs Tesseract over each cached page and stores the words with
their positions. Exporting then draws them over the image in PDF rendering mode 3 —
shaped but never painted — which is exactly what a scanner means by a searchable
PDF. The page still looks like the capture; selecting, copying and Ctrl-F reach the
words underneath.

OCR runs in the preview tab because it needs a WebAssembly engine, which an
extension page can load and a content script cannot, and because it needs somewhere
that stays open — roughly a second and a half a page, so five to ten minutes for a
long book. That tab does not have to be the visible one. Two pages are read at
once, in two independent engines: recognising is almost entirely wasm, so a second
lane is worth close to a second core. It is resumable and interruptible: results
are stored per page as they finish, a page that already has words is never read
twice, and closing the tab costs at most the pages in flight. Pages with no text
layer are still exported as images, so a part-finished run is worth having.

Nothing has to be scanned again to add text to a cache captured before OCR existed.
The run works off the stored pages, and an OCR record is keyed by the capture's
pixel fingerprint as well as its index, so words can never be attached to a page
they were not read from.

Accuracy comes from the pixels, so it is only as good as the capture. Kindle paints
roughly 150–200 dpi, below where the recogniser does its best work, so a page under
1800 px wide is upscaled before it is read; on clean printed prose the **Balanced**
JPEG quality is enough, and **High** is the thing to change first if a book comes
out badly. The engine is `eng` only; it is bundled rather than fetched, which is
both an MV3 requirement and what keeps the extension offline.

`test/ocr-fixture.html` (`npm run fixture`) runs the vendored engine over a page of
known text and reports what came back, which is the quickest way to tell a bad
vendor copy from a bad capture.
