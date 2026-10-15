import { describe, expect, it } from 'vitest';
import type { TextItem } from '@pdfsuite/engine';
import { buildRegExp, findInPage, itemRect, searchDocument } from './search';

const item = (str: string, x = 0, y = 100, over: Partial<TextItem> = {}): TextItem => ({
  str,
  x,
  y,
  fontSize: 10,
  width: str.length * 5,
  angle: 0,
  ascent: 0.8,
  fontFamily: 'sans-serif',
  hasEOL: false,
  ...over,
});
const opts = { caseSensitive: false, wholeWord: false };

describe('search', () => {
  it('finds case-insensitive matches with rects', () => {
    const m = findInPage(0, [item('Hello World', 10, 50)], 'world', opts);
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toBe('World');
    expect(m[0]!.rects[0]).toEqual({ x: 10 + 6 * 5, y: 50 - 8, width: 25, height: 10 });
  });
  it('respects case sensitivity and whole words', () => {
    const items = [item('cat concat Cat')];
    expect(findInPage(0, items, 'cat', { caseSensitive: true, wholeWord: false })).toHaveLength(2);
    expect(findInPage(0, items, 'cat', { caseSensitive: false, wholeWord: true })).toHaveLength(2);
    expect(findInPage(0, items, 'cat', { caseSensitive: true, wholeWord: true })).toHaveLength(1);
  });
  it('matches across runs and line breaks', () => {
    const items = [item('foo ba', 0, 10), item('r baz', 30, 10, { hasEOL: true }), item('qux', 0, 30)];
    const m = findInPage(0, items, 'bar baz qux', opts);
    expect(m).toHaveLength(1);
    expect(m[0]!.rects).toHaveLength(3);
  });
  it('escapes regex characters and collapses whitespace', () => {
    expect(findInPage(0, [item('a.b (c)')], '(c)', opts)).toHaveLength(1);
    expect(findInPage(0, [item('a  b')], 'a b', opts)).toHaveLength(1);
    expect(buildRegExp('   ', opts)).toBeNull();
  });
  it('rotates rects for angled text', () => {
    const r = itemRect(item('abcd', 0, 0, { angle: Math.PI / 2 }), 0, 4);
    expect(r.width).toBeCloseTo(10);
    expect(r.height).toBeCloseTo(20);
  });
  it('searches a whole document and stops on abort', async () => {
    const source = { pageCount: 3, getItems: async (p: number) => [item(p === 1 ? 'needle' : 'hay')] };
    const found: number[] = [];
    await searchDocument(source, 'needle', opts, {
      signal: new AbortController().signal,
      onPage: (p, m) => {
        if (m.length) found.push(p);
      },
    });
    expect(found).toEqual([1]);
    const ac = new AbortController();
    let calls = 0;
    await searchDocument(source, 'hay', opts, {
      signal: ac.signal,
      onPage: () => {
        calls++;
        ac.abort();
      },
    });
    expect(calls).toBe(1);
  });
});

import { setPrefixMeasurer, itemRect as rectOf } from './search';
describe('proportional placement', () => {
  it('uses measured glyph widths when a measurer is installed', () => {
    const item = { str: 'iiWW', x: 0, y: 10, width: 40, fontSize: 10, ascent: 0.8, angle: 0, fontFamily: 'x', hasEOL: false } as unknown as Parameters<typeof rectOf>[0];
    const even = rectOf(item, 2, 4);
    expect(even.x).toBeCloseTo(20);
    setPrefixMeasurer((it, n) => [...it.str.slice(0, n)].reduce((w, c) => w + (c === 'i' ? 2 : 8), 0));
    const prop = rectOf(item, 2, 4);
    expect(prop.x).toBeCloseTo(40 * (4 / 20)); // 'ii' = 4 of 20 units
    expect(prop.width).toBeCloseTo(40 * (16 / 20));
    setPrefixMeasurer(null);
  });
});
