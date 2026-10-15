import { assemble } from './assemble';
import { itemsFromSource } from './plan';
import type { OutlineItem } from './outline';
import { parseRanges } from './ranges';

export type SplitSpec =
  | { mode: 'every'; n: number }
  /** One output file per comma-separated group, e.g. "1-3, 4-6, 7-". Pages not listed are dropped. */
  | { mode: 'ranges'; ranges: string }
  /** Start a new file at every top-level bookmark. */
  | { mode: 'bookmarks' };

/** Groups of zero-based page indices, one per output file. */
export function planSplit(pageCount: number, spec: SplitSpec, outline: readonly OutlineItem[] = []): number[][] {
  switch (spec.mode) {
    case 'every': {
      const n = Math.max(1, Math.floor(spec.n));
      const groups: number[][] = [];
      for (let i = 0; i < pageCount; i += n) groups.push(Array.from({ length: Math.min(n, pageCount - i) }, (_, k) => i + k));
      return groups;
    }
    case 'ranges':
      return spec.ranges
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((part) => parseRanges(part, pageCount));
    case 'bookmarks': {
      const starts = [...new Set(outline.map((o) => o.page).filter((p): p is number => p !== null))].sort((a, b) => a - b);
      if (!starts.length) return [Array.from({ length: pageCount }, (_, i) => i)];
      if (starts[0] !== 0) starts.unshift(0); // front matter before the first bookmark stays together
      return starts.map((s, i) => {
        const end = (starts[i + 1] ?? pageCount) - 1;
        return Array.from({ length: end - s + 1 }, (_, k) => s + k);
      });
    }
  }
}

export interface SplitResult {
  name: string;
  data: Uint8Array;
  pages: number[];
}

/** Produce one PDF per group. Names are `<base>_<first>-<last>.pdf` (1-based pages). */
export async function splitPdf(bytes: Uint8Array, groups: readonly number[][], baseName: string): Promise<SplitResult[]> {
  const out: SplitResult[] = [];
  for (const pages of groups) {
    if (!pages.length) continue;
    const data = await assemble([bytes], itemsFromSource(0, pages));
    const first = pages[0]! + 1;
    const last = pages[pages.length - 1]! + 1;
    out.push({ name: `${baseName}_${first === last ? first : `${first}-${last}`}.pdf`, data, pages });
  }
  return out;
}
