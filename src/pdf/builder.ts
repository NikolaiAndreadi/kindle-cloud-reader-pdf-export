// A minimal PDF/1.4 container. In 'scan' mode each page is one JPEG, optionally
// with an invisible OCR text layer over it; in 'text' mode the OCR words are the
// page, except where the caller hands over a bitmap as well — a plate, a map, a
// page the recogniser could make nothing of — which is drawn as a scan would be.
// Nothing here knows about Kindle, storage or the DOM: it takes pages and
// returns a Blob.

import { DEFAULT_PAPER, layoutFor } from './paper.ts';
import { FONTS, textLayerOps } from './text.ts';

/** Fixed ids, in the order finish() writes them. Pages are numbered after. */
const CATALOG_ID = 1;
const PAGES_ID = 2;
const FIRST_FONT_ID = 3;
const FIRST_PAGE_ID = FIRST_FONT_ID + FONTS.length;

// One encoder for the whole document. Allocating one per write was thousands of
// throwaway objects per export.
const encoder = new TextEncoder();

const pt = (value: number): string => value.toFixed(2);

export function bytesFromDataUrl(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  // atob rather than fetch(dataUrl): a content script's fetch is subject to the
  // host page's CSP, and read.amazon.com sets a restrictive one.
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Incremental writer: pages are appended as they are read from storage and
 * coalesced into Blobs, so a whole book never sits on the JS heap at once. The
 * Catalog, Pages and font objects are written last (the xref maps ids to
 * offsets, so file order is free) which is what makes streaming possible.
 */
export function pdfBuilder(options: PdfOptions = {}): PdfBuilder {
  const paper = options.paper ?? DEFAULT_PAPER;
  // Scanned pages are what this wrote before the text mode existed, and what a
  // caller that says nothing still means.
  const mode = options.mode ?? 'scan';
  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  const pageIds: number[] = [];
  let pending: BlobPart[] = [];
  let length = 0;
  let withText = 0;
  let withImage = 0;
  /**
   * Handed out as objects are written rather than computed from the page number:
   * a page carries an image object or does not, so the stride is no longer the
   * same for every page of a document.
   */
  let nextId = FIRST_PAGE_ID;
  const claim = (): number => nextId++;

  /** Every page names both fonts; which one it uses is the text layer's business. */
  const fontResources = FONTS
    .map((font, i) => `/${font.resource} ${FIRST_FONT_ID + i} 0 R`)
    .join(' ');

  const push = (value: string | Uint8Array): void => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    pending.push(bytes as BlobPart);
    length += bytes.length;
  };
  const object = (id: number, body: string): void => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  const flush = (): void => {
    if (!pending.length) return;
    parts.push(new Blob(pending));
    pending = [];
  };

  // Raw bytes, not a JS string: TextEncoder would emit these as UTF-8 pairs.
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A]));
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  return {
    get pages(): number {
      return pageIds.length;
    },
    get imagePages(): number {
      return withImage;
    },
    get textPages(): number {
      return withText;
    },
    flush,
    addPage(page: PdfPage, words?: OcrWord[]): void {
      const layout = layoutFor(page.width, page.height, paper);
      if (!layout) return;
      // A bitmap is what a scanned page is, so one arriving without it is a page
      // that could not be read. In text mode the bitmap is the exception rather
      // than the rule — it means this page is a picture and is to be kept as one
      // — and a page with neither bitmap nor words is still a page: a plate, a
      // chapter break, so leaving it out would renumber everything after it.
      const image = page.bytes;
      if (mode !== 'text' && !image) return;
      const style = image ? 'invisible' : 'visible';

      const index = pageIds.length;
      const pageId = claim();
      const imageId = image ? claim() : 0;
      const contentId = claim();
      pageIds.push(pageId);

      const xobject = image ? `/XObject << /Im${index} ${imageId} 0 R >> ` : '';
      object(pageId, `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 ${pt(layout.pageWidth)} ${pt(layout.pageHeight)}] /Resources << ${xobject}/Font << ${fontResources} >> >> /Contents ${contentId} 0 R >>`);

      let command = '';
      if (image) {
        withImage += 1;
        offsets[imageId] = length;
        push(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`);
        push(image);
        push('\nendstream\nendobj\n');

        // The image is drawn first so the text lands on top of it. Invisible text
        // does not paint, but readers pick the topmost object when a click has to
        // choose between selecting text and grabbing the image.
        command = `q\n${pt(layout.width)} 0 0 ${pt(layout.height)} ${pt(layout.x)} ${pt(layout.y)} cm\n/Im${index} Do\nQ\n`;
      }

      const text = words?.length
        ? textLayerOps(words, {
          scale: layout.width / page.width,
          left: layout.x,
          bottom: layout.y,
          imageHeight: page.height
        }, style)
        : '';
      if (text) {
        command += text;
        withText += 1;
      }
      object(contentId, `<< /Length ${command.length} >>\nstream\n${command}endstream`);
    },
    finish(): Blob {
      object(CATALOG_ID, `<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>`);
      object(PAGES_ID, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
      // Written whether or not any page carries text: two 80-byte objects are
      // cheaper than deciding, since every page's Resources already names them.
      FONTS.forEach((font, i) => {
        object(
          FIRST_FONT_ID + i,
          `<< /Type /Font /Subtype /Type1 /BaseFont /${font.baseFont} /Encoding /WinAnsiEncoding >>`
        );
      });
      const xref = length;
      const count = nextId;
      push(`xref\n0 ${count}\n0000000000 65535 f \n`);
      for (let id = 1; id < count; id++) push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
      push(`trailer\n<< /Size ${count} /Root ${CATALOG_ID} 0 R >>\nstartxref\n${xref}\n%%EOF`);
      flush();
      return new Blob(parts, { type: 'application/pdf' });
    }
  };
}
