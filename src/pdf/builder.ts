// A minimal PDF/1.4 container holding one JPEG per page. Nothing here knows
// about Kindle, storage or the DOM — it takes images and returns a Blob.

const POINTS_WIDE = 612; // US Letter width; every page is scaled to it.

// One encoder for the whole document. Allocating one per write was thousands of
// throwaway objects per export.
const encoder = new TextEncoder();

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
 * Catalog and Pages objects are written last (the xref maps ids to offsets, so
 * file order is free) which is what makes streaming possible.
 */
export function pdfBuilder(): PdfBuilder {
  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  const pageIds: number[] = [];
  let pending: BlobPart[] = [];
  let length = 0;

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
    flush,
    addImage(image: PdfImage): void {
      if (!image.width || !image.height) return;
      const index = pageIds.length;
      const pageId = 3 + index * 3;
      const imageId = pageId + 1;
      const contentId = pageId + 2;
      pageIds.push(pageId);
      const pointsHigh = (POINTS_WIDE * image.height / image.width).toFixed(2);
      object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${POINTS_WIDE} ${pointsHigh}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
      offsets[imageId] = length;
      push(`${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);
      push(image.bytes);
      push('\nendstream\nendobj\n');
      const command = `q\n${POINTS_WIDE} 0 0 ${pointsHigh} 0 0 cm\n/Im${index} Do\nQ\n`;
      object(contentId, `<< /Length ${command.length} >>\nstream\n${command}endstream`);
    },
    finish(): Blob {
      object(1, '<< /Type /Catalog /Pages 2 0 R >>');
      object(2, `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
      const xref = length;
      const count = 3 + pageIds.length * 3;
      push(`xref\n0 ${count}\n0000000000 65535 f \n`);
      for (let id = 1; id < count; id++) push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
      push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
      flush();
      return new Blob(parts, { type: 'application/pdf' });
    }
  };
}
