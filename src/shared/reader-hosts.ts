// The single source of truth for "which sites is this extension for".
//
// manifest.json needs the same list twice and cannot import anything, so
// build.mjs fails when the two have drifted. Everything else tests URLs against
// isReaderUrl rather than a regex of its own: a pattern broader than the
// manifest enables the UI on a tab where no content script was ever injected,
// and the only symptom is a raw Chrome "Could not establish connection".

export const READER_HOSTS = [
  'read.amazon.com',
  'read.amazon.ca',
  'read.amazon.co.jp',
  'read.amazon.co.uk',
  'read.amazon.com.au',
  'read.amazon.com.be',
  'read.amazon.com.br',
  'read.amazon.com.mx',
  'read.amazon.com.tr',
  'read.amazon.de',
  'read.amazon.eg',
  'read.amazon.es',
  'read.amazon.fr',
  'read.amazon.in',
  'read.amazon.it',
  'read.amazon.nl',
  'read.amazon.pl',
  'read.amazon.sa',
  'read.amazon.se',
  'read.amazon.sg'
] as const;

const READER_HOST_SET = new Set<string>(READER_HOSTS);

export const READER_HOME = 'https://read.amazon.com/';

export const matchPattern = (host: string): string => `https://${host}/*`;

export function isReaderUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && READER_HOST_SET.has(url.hostname);
  } catch {
    return false;
  }
}
