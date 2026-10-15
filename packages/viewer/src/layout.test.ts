import { describe, expect, it } from 'vitest';
import { anchorAt, computeLayout, currentPage, resolveZoom, scrollTopFor, stepZoom, visibleRange } from './layout';

const sizes = Array.from({ length: 10 }, () => ({ width: 100, height: 200 }));

describe('layout', () => {
  const l = computeLayout(sizes, 1, 10, 20);
  it('stacks pages with gap and padding', () => {
    expect(l.tops[0]).toBe(20);
    expect(l.tops[1]).toBe(230);
    expect(l.total).toBe(20 + 10 * 200 + 9 * 10 + 20);
  });
  it('scales with zoom', () => {
    const z = computeLayout(sizes, 2, 10, 20);
    expect(z.heights[0]).toBe(400);
    expect(z.maxWidth).toBe(200);
  });
  it('finds visible range with overscan', () => {
    expect(visibleRange(l, 0, 300)).toEqual({ first: 0, last: 1 });
    expect(visibleRange(l, 0, 300, 400)).toEqual({ first: 0, last: 3 });
    expect(visibleRange(l, 1000, 100).first).toBe(4);
    expect(visibleRange(computeLayout([], 1, 10, 20), 0, 100).last).toBe(-1);
  });
  it('picks the page with most visible area', () => {
    expect(currentPage(l, 0, 300)).toBe(0);
    expect(currentPage(l, 200, 300)).toBe(1);
  });
  it('round-trips scroll anchors across zoom changes', () => {
    const a = anchorAt(l, 500)!;
    const z = computeLayout(sizes, 2, 10, 20);
    const back = anchorAt(z, scrollTopFor(z, a))!;
    expect(back.page).toBe(a.page);
    expect(back.fraction).toBeCloseTo(a.fraction);
  });
});

describe('zoom', () => {
  it('resolves fit modes', () => {
    const vp = { width: 520, height: 700 };
    expect(resolveZoom({ kind: 'fit-width' }, vp, 500, { width: 500, height: 800 }, 10)).toBeCloseTo(1);
    expect(resolveZoom({ kind: 'fit-page' }, vp, 500, { width: 500, height: 1360 }, 10)).toBeCloseTo(0.5);
    expect(resolveZoom({ kind: 'actual' }, vp, 500, { width: 1, height: 1 }, 10)).toBe(1);
    expect(resolveZoom({ kind: 'custom', value: 99 }, vp, 500, { width: 1, height: 1 }, 10)).toBe(8);
  });
  it('steps through the zoom ladder', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(8, 1)).toBe(8);
  });
});
