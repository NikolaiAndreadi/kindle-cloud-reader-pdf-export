# Contributing

**Bug fixes only.** New features are out of scope for this repo, however good they
are — including ones the README hints at and ones I would use myself. If you want
this to do something it does not do, fork it and adapt it; the code is laid out to
make that easy, and [the README says why](README.md#when-it-stops-working). I would
rather point you at a fork than sit on a pull request I am not going to merge.

By opening a pull request you agree your contribution is licensed under the
[MIT License](LICENSE), the same as the rest of the project.

## What counts as a bug fix

Welcome:

- the scan breaking against a change Amazon shipped — the most likely reason
  anything here needs fixing
- pages skipped, duplicated, mis-split, or captured at the wrong size
- broken or malformed PDF output; a text layer that does not line up
- crashes, stalls, storage that fills up or fails to clear
- a regional reader domain that does not work
- correcting something the README states wrongly

Not a bug:

- more export formats, more OCR languages, other readers or sites
- new options, new buttons, a different preview layout
- anything touching DRM, encryption, keys, or book files rather than rendered
  pixels — see [Scope and limits](README.md#scope-and-limits); this is the line the
  project does not cross
- sending captures, identifiers or telemetry anywhere, or widening the extension's
  permissions
- publishing this to the Chrome Web Store under this or any name

If you are not sure which side something falls on, open an issue before writing
code.

## Reporting a bug

Say which reader domain and which book layout (single column or two-page spread),
what the page counter read, and what the extension reported. If a scan stopped
early or skipped pages, include the page delay you used.

## Working on a fix

```sh
npm install
npm run build
npm run check     # typecheck + lint + tests; must be clean
```

Then load the directory as an unpacked extension, as in the README.

`npm run fixture` serves `test/fixture.html` and `test/ocr-fixture.html`, which
reproduce most scan and OCR problems with no Amazon account and no book. Use them
before touching a live reader.

Two things about this repo that are easy to get wrong:

**`content.js`, `popup.js` and `preview.js` are build output and are checked in on
purpose**, so **Load unpacked** works on a fresh clone. Never edit them by hand —
change `src/`, run `npm run build`, and commit the regenerated bundles with the
source. A pull request whose bundles do not match its `src/` will not apply cleanly
for anyone.

**`vendor/tesseract` is checked in too**, and only `npm run vendor` should write to
it. It is a verbatim copy of upstream Apache-2.0 artifacts; hand-editing it makes
the third-party notices wrong. If you bump the OCR engine, run `npm run vendor` and
update `vendor/tesseract/THIRD_PARTY_NOTICES.md`.

Unit tests cover the pure logic — capture decisions, duplicate detection, paper
fitting, the PDF writer, the text layer. If a bug can be caught there, please add
the case alongside the fix.
