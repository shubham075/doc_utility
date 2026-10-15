export interface Size {
  width: number;
  height: number;
}

export type ZoomMode =
  | { kind: 'custom'; value: number }
  | { kind: 'fit-width' }
  | { kind: 'fit-page' }
  | { kind: 'actual' };

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Resolve a zoom mode to a numeric scale (1 = 100%). */
export function resolveZoom(
  mode: ZoomMode,
  viewport: Size,
  maxPageWidth: number,
  currentPage: Size,
  padding: number,
): number {
  switch (mode.kind) {
    case 'custom':
      return clampZoom(mode.value);
    case 'actual':
      return 1;
    case 'fit-width':
      return clampZoom((viewport.width - 2 * padding) / maxPageWidth);
    case 'fit-page':
      return clampZoom(
        Math.min(
          (viewport.width - 2 * padding) / currentPage.width,
          (viewport.height - 2 * padding) / currentPage.height,
        ),
      );
  }
}

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]!;
}

export interface PageLayout {
  tops: number[];
  widths: number[];
  heights: number[];
  total: number;
  maxWidth: number;
}

/** Vertical stack of pages at the given zoom. `padding` surrounds the stack, `gap` separates pages. */
export function computeLayout(sizes: Size[], zoom: number, gap: number, padding: number): PageLayout {
  const tops: number[] = [];
  const widths: number[] = [];
  const heights: number[] = [];
  let y = padding;
  let maxWidth = 0;
  for (const s of sizes) {
    tops.push(y);
    const w = s.width * zoom;
    const h = s.height * zoom;
    widths.push(w);
    heights.push(h);
    y += h + gap;
    if (w > maxWidth) maxWidth = w;
  }
  return { tops, widths, heights, total: sizes.length ? y - gap + padding : 2 * padding, maxWidth };
}

/** First index whose bottom edge is below `y` (binary search). */
function firstEndingAfter(layout: PageLayout, y: number): number {
  let lo = 0;
  let hi = layout.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (layout.tops[mid]! + layout.heights[mid]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Inclusive range of pages intersecting [scrollTop - overscan, scrollTop + viewportH + overscan]. Empty => last < first. */
export function visibleRange(layout: PageLayout, scrollTop: number, viewportH: number, overscan = 0) {
  const n = layout.tops.length;
  if (!n) return { first: 0, last: -1 };
  const from = scrollTop - overscan;
  const to = scrollTop + viewportH + overscan;
  const first = firstEndingAfter(layout, from);
  if (first >= n) return { first: n - 1, last: -1 };
  let last = first;
  while (last + 1 < n && layout.tops[last + 1]! < to) last++;
  return { first, last };
}

/** Page occupying the largest part of the viewport (ties resolved towards the earlier page). */
export function currentPage(layout: PageLayout, scrollTop: number, viewportH: number): number {
  const { first, last } = visibleRange(layout, scrollTop, viewportH);
  let best = first;
  let bestArea = -1;
  for (let i = first; i <= last; i++) {
    const top = Math.max(layout.tops[i]!, scrollTop);
    const bottom = Math.min(layout.tops[i]! + layout.heights[i]!, scrollTop + viewportH);
    const area = bottom - top;
    if (area > bestArea + 0.5) {
      best = i;
      bestArea = area;
    }
  }
  return best;
}

/** A scroll position expressed relative to a page, so it survives layout changes. */
export interface ScrollAnchor {
  page: number;
  /** Offset into the page as a fraction of its height (negative inside the gap above). */
  fraction: number;
}

export function anchorAt(layout: PageLayout, scrollTop: number): ScrollAnchor | null {
  if (!layout.tops.length) return null;
  const page = Math.min(firstEndingAfter(layout, scrollTop), layout.tops.length - 1);
  return { page, fraction: (scrollTop - layout.tops[page]!) / (layout.heights[page] || 1) };
}

export function scrollTopFor(layout: PageLayout, a: ScrollAnchor): number {
  const top = layout.tops[a.page];
  if (top === undefined) return 0;
  return top + a.fraction * layout.heights[a.page]!;
}
