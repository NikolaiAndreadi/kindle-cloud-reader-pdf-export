// The reader paints each page as <img src="blob:…"> inside .kg-full-page-img
// under #kr-renderer. Canvas is only in the fallback: no build observed uses
// it, and matching every canvas is what let stray elements be stored as pages.
const PAGE_SELECTOR = '.kg-full-page-img img';
const PAGE_FALLBACK_SELECTOR = '.kg-full-page-img img, canvas';
const COUNTER_SELECTOR = '[item-i-d="reader-footer-title"], .reader-footer, [data-testid="footer"]';
const COUNTER_PATTERN = /\b(Page|Location)\s+([\d,]+)\s+of\s+([\d,]+)\b/i;

export const RENDERER_SELECTOR = '#kr-renderer, .kr-renderer-container-fullpage';
export const NEXT_SELECTOR = '[aria-label="Next page"], .kr-chevron-container-right, .chevron.right';

const MIN_PAGE_SIDE = 100;
const DOMINANT_AREA_RATIO = .5;
const MAX_ROOTS = 50;
const MAX_ROOT_DEPTH = 3;
const MAX_TEXT_NODES = 20000;

type SearchRoot = Document | ShadowRoot;

let counterHost: Element | null = null;

export function bookId(): string {
  const url = new URL(location.href);
  const asin = url.searchParams.get('asin') ||
    url.hash.match(/asin[=/]([A-Z0-9]+)/i)?.[1] ||
    url.pathname.match(/\/asin\/([A-Z0-9]+)/i)?.[1];
  return (asin || url.pathname.replace(/\W+/g, '-')).slice(0, 80);
}

// Kindle renders into shadow roots and same-origin iframes depending on the
// build, so every lookup walks those too instead of assuming a flat document.
function collectRoots(): SearchRoot[] {
  const found: SearchRoot[] = [];
  const visit = (root: SearchRoot, depth: number): void => {
    if (found.length >= MAX_ROOTS || found.includes(root)) return;
    found.push(root);
    if (depth >= MAX_ROOT_DEPTH) return;
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) visit(element.shadowRoot, depth + 1);
      if (element.localName !== 'iframe') continue;
      let inner: Document | null = null;
      try {
        inner = (element as HTMLIFrameElement).contentDocument;
      } catch {
        inner = null;
      }
      if (inner) visit(inner, depth + 1);
    }
  };
  visit(document, 0);
  return found;
}

/** Parse "Page 12 of 340" or "Location 4,879 of 4,879". Exported for tests. */
export function parseCounter(text: string): ReaderPosition | null {
  const match = COUNTER_PATTERN.exec(text);
  if (!match) return null;
  const digits = (value: string): number => Number(value.replace(/,/g, ''));
  return {
    kind: match[1]!.toLowerCase() === 'location' ? 'location' : 'page',
    value: digits(match[2]!),
    total: digits(match[3]!)
  };
}

// textContent instead of innerText: innerText forces a full layout pass, and
// this runs on every loop iteration. The footer element is cached, so the
// usual case is one property read. Returns null whenever the reader chrome is
// hidden, which happens routinely during an unattended scan.
export function readerPosition(): ReaderPosition | null {
  if (counterHost?.isConnected) {
    const cached = parseCounter(counterHost.textContent || '');
    if (cached) return cached;
  }
  counterHost = null;
  for (const node of document.querySelectorAll(COUNTER_SELECTOR)) {
    const counter = parseCounter(node.textContent || '');
    if (!counter) continue;
    counterHost = node;
    return counter;
  }
  return searchCounter(collectRoots());
}

// Only reached when the footer markup has changed shape.
function searchCounter(rootList: SearchRoot[]): ReaderPosition | null {
  let examined = 0;
  for (const root of rootList) {
    const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root.ownerDocument || document);
    const walker = doc.createTreeWalker('body' in root ? root.body : root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++examined > MAX_TEXT_NODES) return null;
      const parent = node.parentElement;
      if (!parent || parent.checkVisibility?.() === false) continue;
      const counter = parseCounter(node.textContent || '');
      if (!counter) continue;
      counterHost = parent;
      return counter;
    }
  }
  return null;
}

export const positionKey = (position: ReaderPosition | null): string =>
  position ? `${position.kind}:${position.value}` : '';

// Only elements close in area to the largest candidate count, and they are
// ordered by screen position rather than height: spread pages sit in a flex
// row, so left-to-right is the reading order.
export function pageCandidates(): PageCandidate[] {
  let elements = [...document.querySelectorAll<PageElement>(PAGE_SELECTOR)];
  if (!elements.length) {
    elements = collectRoots().flatMap((root) => [...root.querySelectorAll<PageElement>(PAGE_FALLBACK_SELECTOR)]);
  }
  const candidates: PageCandidate[] = [];
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_PAGE_SIDE || rect.height < MIN_PAGE_SIDE) continue;
    if (rect.bottom <= 0 || rect.top >= innerHeight) continue;
    candidates.push({ element, rect, area: rect.width * rect.height });
  }
  if (!candidates.length) return [];
  const largest = Math.max(...candidates.map((candidate) => candidate.area));
  return candidates
    .filter((candidate) => candidate.area >= largest * DOMINANT_AREA_RATIO)
    .sort((a, b) => (a.rect.left - b.rect.left) || (a.rect.top - b.rect.top));
}
