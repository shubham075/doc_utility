import type { TextItem } from '@pdfsuite/engine';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  page: number;
  start: number;
  end: number;
  rects: Rect[];
  before: string;
  text: string;
  after: string;
}

/** Concatenate runs into searchable page text; line breaks become spaces so matches can span lines. */
export function buildPageText(items: TextItem[]): { text: string; starts: number[] } {
  let text = '';
  const starts: number[] = [];
  for (const it of items) {
    starts.push(text.length);
    text += it.str + (it.hasEOL ? ' ' : '');
  }
  return { text, starts };
}

/** Bounding box (page space) of characters [from, to) inside one text run, assuming even glyph advance. */
export function itemRect(item: TextItem, from: number, to: number): Rect {
  const len = item.str.length || 1;
  const x0 = (item.width * from) / len;
  const x1 = (item.width * to) / len;
  const top = -item.ascent * item.fontSize;
  const bottom = top + item.fontSize;
  const cos = Math.cos(item.angle);
  const sin = Math.sin(item.angle);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [lx, ly] of [
    [x0, top],
    [x1, top],
    [x1, bottom],
    [x0, bottom],
  ] as const) {
    xs.push(item.x + lx * cos - ly * sin);
    ys.push(item.y + lx * sin + ly * cos);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function buildRegExp(query: string, opts: SearchOptions): RegExp | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const body = trimmed
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const word = '[\\p{L}\\p{N}_]';
  const src = opts.wholeWord ? `(?<!${word})${body}(?!${word})` : body;
  return new RegExp(src, opts.caseSensitive ? 'gu' : 'giu');
}

const CONTEXT = 30;

export function findInPage(page: number, items: TextItem[], query: string, opts: SearchOptions): SearchMatch[] {
  const re = buildRegExp(query, opts);
  if (!re) return [];
  const { text, starts } = buildPageText(items);
  const out: SearchMatch[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (end === start) continue;
    const rects: Rect[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const s = starts[i]!;
      const e = s + it.str.length;
      if (e <= start || s >= end || !it.str) continue;
      rects.push(itemRect(it, Math.max(start, s) - s, Math.min(end, e) - s));
    }
    out.push({
      page,
      start,
      end,
      rects,
      before: text.slice(Math.max(0, start - CONTEXT), start),
      text: text.slice(start, end),
      after: text.slice(end, end + CONTEXT),
    });
  }
  return out;
}

export interface TextSource {
  pageCount: number;
  getItems(page: number): Promise<TextItem[]>;
}

/** Search every page in order, reporting each page's matches as they are found. */
export async function searchDocument(
  source: TextSource,
  query: string,
  opts: SearchOptions,
  hooks: { signal: AbortSignal; onPage: (page: number, matches: SearchMatch[], pagesDone: number) => void },
): Promise<void> {
  if (!buildRegExp(query, opts)) return;
  for (let p = 0; p < source.pageCount; p++) {
    if (hooks.signal.aborted) return;
    let items: TextItem[] = [];
    try {
      items = await source.getItems(p);
    } catch {
      /* unreadable page: skip */
    }
    if (hooks.signal.aborted) return;
    hooks.onPage(p, findInPage(p, items, query, opts), p + 1);
    if (p % 8 === 7) await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
  }
}
