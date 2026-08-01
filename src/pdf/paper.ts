// Page geometry. Nothing here writes PDF syntax — it only answers "how big is
// the page and where on it does the bitmap go", which is the part worth testing.

/** Width every native-sized page is scaled to. US Letter width, historically. */
export const NATIVE_POINTS_WIDE = 612;

/** Sizes in PDF points (1/72"), portrait. */
export const PAPER_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 }
} as const;

export const PAPER_NAMES = ['a4', 'letter', 'native'] as const;

export const DEFAULT_PAPER: PaperName = 'a4';

export const isPaperName = (value: unknown): value is PaperName =>
  typeof value === 'string' && (PAPER_NAMES as readonly string[]).includes(value);

export const paperLabel = (paper: PaperName): string =>
  paper === 'a4' ? 'A4' : paper === 'letter' ? 'US Letter' : 'capture size';

/**
 * Where one captured bitmap sits on one PDF page.
 *
 * A fixed paper size is the point of the exercise: page height used to follow
 * whatever the reader viewport happened to be, so a book exported as a stack of
 * pages no printer or e-reader had a name for. The bitmap is fitted inside the
 * sheet and centred, which leaves bands wherever the aspect ratios disagree —
 * Kindle pages are a little squarer than A4.
 *
 * The sheet takes the orientation of the bitmap. A two-column spread captured
 * without splitting is landscape, and forcing it onto portrait A4 would waste
 * half the sheet and leave the text too small to read.
 */
export function layoutFor(
  imageWidth: number, imageHeight: number, paper: PaperName
): PageLayout | null {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return null;

  if (paper === 'native') {
    const height = NATIVE_POINTS_WIDE * imageHeight / imageWidth;
    return {
      pageWidth: NATIVE_POINTS_WIDE, pageHeight: height,
      x: 0, y: 0, width: NATIVE_POINTS_WIDE, height
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
    pageWidth, pageHeight,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width, height
  };
}
