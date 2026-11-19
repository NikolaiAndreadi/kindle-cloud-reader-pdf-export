import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextPageControl, parseCounter, positionKey } from '../../src/content/dom.ts';

describe('nextPageControl', () => {
  for (const hasButton of [true, false]) {
    it(hasButton ? 'prefers the child button to its wrapper' : 'keeps the wrapper fallback', (test) => {
      const originalDocument = globalThis.document;
      const button = { tagName: 'BUTTON' };
      const wrapper = { tagName: 'DIV' };
      globalThis.document = {
        querySelector: (selector: string) =>
          selector.includes('.kr-chevron-container-right') ? wrapper : hasButton ? button : null
      } as unknown as Document;
      test.after(() => { globalThis.document = originalDocument; });

      assert.equal(nextPageControl(), hasButton ? button : wrapper);
    });
  }
});

describe('parseCounter', () => {
  it('reads a page counter', () => {
    assert.deepEqual(parseCounter('Page 12 of 340'), { kind: 'page', value: 12, total: 340 });
  });

  it('reads a location counter', () => {
    assert.deepEqual(parseCounter('Location 4,879 of 4,879'), {
      kind: 'location', value: 4879, total: 4879
    });
  });

  it('strips thousands separators from both numbers', () => {
    assert.deepEqual(parseCounter('Page 1,024 of 12,345'), {
      kind: 'page', value: 1024, total: 12345
    });
  });

  it('is case insensitive, as the footer casing varies by build', () => {
    assert.equal(parseCounter('PAGE 3 OF 9')?.kind, 'page');
    assert.equal(parseCounter('location 3 of 9')?.kind, 'location');
  });

  it('finds the counter inside surrounding footer text', () => {
    assert.deepEqual(parseCounter('Some Book Title · Page 7 of 88 · 42%'), {
      kind: 'page', value: 7, total: 88
    });
  });

  it('returns null when the footer is hidden or says something else', () => {
    assert.equal(parseCounter(''), null);
    assert.equal(parseCounter('Loading…'), null);
    assert.equal(parseCounter('Page of'), null);
    assert.equal(parseCounter('12 of 340'), null);
  });
});

describe('positionKey', () => {
  it('distinguishes the two counter kinds at the same number', () => {
    const page = positionKey({ kind: 'page', value: 5, total: 9 });
    const location = positionKey({ kind: 'location', value: 5, total: 9 });
    assert.notEqual(page, location);
  });

  it('ignores the total, which changes as the reader reflows', () => {
    assert.equal(
      positionKey({ kind: 'page', value: 5, total: 9 }),
      positionKey({ kind: 'page', value: 5, total: 400 })
    );
  });

  it('is empty when the reader gave no position', () => {
    assert.equal(positionKey(null), '');
  });
});
