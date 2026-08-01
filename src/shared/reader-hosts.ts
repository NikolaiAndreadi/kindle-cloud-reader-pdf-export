// The single source of truth for "which sites is this extension for".
//
// manifest.json needs the same list twice (host_permissions and
// content_scripts.matches) and cannot import anything, so build.mjs reads this
// module and fails the build when the manifest has drifted from it. The popup
// tests tab URLs against isReaderUrl rather than a regex of its own: a pattern
// broader than the manifest would enable the UI on a tab where no content
// script was ever injected, and the only symptom is a raw Chrome
// "Could not establish connection" error.

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

export const READER_HOME = 'https://read.amazon.com/';

export const matchPattern = (host: string): string => `https://${host}/*`;

export const isReaderUrl = (url: string | undefined): boolean =>
  !!url && READER_HOSTS.some((host) => url.startsWith(`https://${host}/`));
