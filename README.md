# Personal Cloud Reader Export

A small Chrome extension that captures pages already rendered by Kindle Cloud
Reader and saves them as an image-based PDF. It does not download Kindle book
files, decrypt content, or communicate with any third-party service. Use it
only for books and material you are authorized to copy.

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
- `npm run fixture` — serves this directory on port 8973 for the offline test page

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Open a book at <https://read.amazon.com/> (regional domains such as
   `read.amazon.co.uk` and `read.amazon.com.br` work too).
5. Click the extension and choose **Scan / resume**.
6. Stop whenever you like; the captured pages remain cached per book.
7. Choose **Save cached pages as PDF** when ready.

Keep the reader tab visible until the download begins. If pages are skipped, choose
the slower page delay.

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
