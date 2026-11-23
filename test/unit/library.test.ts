import assert from 'node:assert/strict';
import { it } from 'node:test';
import { lookupBookNames } from '../../src/content/library.ts';

it('uses the matching ASIN across library pages and includes all authors', async (t) => {
  const pages = [
    { itemsList: [{ asin: 'B000000001', title: 'Other' }], paginationToken: '50' },
    { itemsList: [{ asin: 'B000000002', title: 'Selected', authors: ['First:Second:', 'Third'] }] }
  ];
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json(pages.shift()));
  assert.deepEqual(await lookupBookNames('B000000002'), { title: 'Selected', author: 'First, Second, Third' });
  assert.equal(request.mock.callCount(), 2);
  assert.match(String(request.mock.calls[1]?.arguments[0]), /paginationToken=50/);
});

it('returns empty fields for an absent book and stops on a repeated token', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ itemsList: [], paginationToken: '50' }));
  assert.deepEqual(await lookupBookNames('B000000002'), { title: '', author: '' });
  assert.equal(request.mock.callCount(), 2);
});
