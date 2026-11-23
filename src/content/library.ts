// The signed-in reader's library lists titles and authors together with their ASIN.
export async function lookupBookNames(asin: string): Promise<BookNames> {
  const empty = { title: '', author: '' };
  if (!/^[a-z0-9]{10}$/i.test(asin)) return empty;
  const params = new URLSearchParams({ query: '', libraryType: 'BOOKS', sortType: 'recency', querySize: '50' });
  const signal = AbortSignal.timeout(6000);
  const seen = new Set<string>();
  do {
    const response = await fetch(`/kindle-library/search?${params}`, { signal, credentials: 'same-origin' });
    if (!response.ok) return empty;
    const data = await response.json();
    if (!Array.isArray(data?.itemsList)) return empty;
    const item = data.itemsList.find((entry: { asin?: unknown } | null) => entry?.asin === asin);
    if (item) {
      const authors: unknown[] = Array.isArray(item.authors) ? item.authors : [item.authors];
      return {
        title: typeof item.title === 'string' ? item.title.trim() : '',
        author: authors.filter((v): v is string => typeof v === 'string')
          .flatMap((name) => name.split(':')).map((name) => name.trim()).filter(Boolean).join(', ')
      };
    }
    const next = data.paginationToken;
    if (typeof next !== 'string' || !next || seen.has(next)) return empty;
    seen.add(next);
    params.set('paginationToken', next);
  } while (!signal.aborted);
  return empty;
}
