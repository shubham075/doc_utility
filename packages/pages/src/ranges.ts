/**
 * Page range expressions as users type them: "1-3, 5, 8-" (1-based, inclusive, open end allowed),
 * plus "odd" / "even" / "all". Returns sorted unique zero-based indices; throws on malformed input.
 */
export function parseRanges(text: string, pageCount: number): number[] {
  const src = text.trim().toLowerCase();
  if (!src || src === 'all') return Array.from({ length: pageCount }, (_, i) => i);
  if (src === 'odd') return Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 0);
  if (src === 'even') return Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 1);
  const out = new Set<number>();
  for (const part of src.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)?\s*(?:(-|–)\s*(\d+)?)?$/.exec(part);
    if (!m || (m[1] === undefined && m[3] === undefined)) throw new Error(`Invalid page range "${part}"`);
    const from = m[1] !== undefined ? Number(m[1]) : 1;
    const to = m[2] ? (m[3] !== undefined ? Number(m[3]) : pageCount) : from;
    if (from < 1 || to < 1) throw new Error(`Page numbers start at 1 ("${part}")`);
    if (from > pageCount) throw new Error(`Page ${from} is beyond the last page (${pageCount})`);
    if (to < from) throw new Error(`Range "${part}" is backwards`);
    for (let p = from; p <= Math.min(to, pageCount); p++) out.add(p - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Inverse of parseRanges for display: [0,1,2,4] -> "1-3, 5". */
export function formatRanges(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]! + 1}-${sorted[j]! + 1}` : String(sorted[i]! + 1));
    i = j + 1;
  }
  return parts.join(', ');
}
