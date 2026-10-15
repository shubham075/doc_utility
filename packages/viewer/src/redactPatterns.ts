import type { TextItem } from '@pdfsuite/engine';
import { buildPageText, itemRect, type Rect } from './search';

/** Margin (points) added on both sides of a match: estimated glyph positions are never exact. */
const PAD = 0.75;

export type PatternKind = 'ssn' | 'email' | 'phone' | 'card' | 'iban' | 'date';

export const PATTERNS: Record<PatternKind, { label: string; re: RegExp; accept?: (s: string) => boolean }> = {
  ssn: { label: 'Social security numbers', re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  email: { label: 'Email addresses', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu },
  phone: { label: 'Phone numbers', re: /(?<![\d-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3}[ .-]?\d{3,4}(?![\d-])/g, accept: (s) => s.replace(/\D/g, '').length >= 9 },
  card: { label: 'Payment card numbers', re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, accept: luhn },
  iban: { label: 'IBANs', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  date: { label: 'Dates (numeric)', re: /(?<!\d)\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?!\d)/g },
};

/** Luhn checksum over the digits of `s` (13-19 digits). */
export function luhn(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

export interface PatternMatch {
  page: number;
  text: string;
  rects: Rect[];
  kind: string;
}

export interface PatternQuery {
  kinds: PatternKind[];
  /** Plain words/phrases (case-insensitive). */
  words?: string[];
  /** A user-supplied regular expression (case-insensitive). */
  regex?: string;
}

/** Compile the query into labelled expressions; throws a readable error for a bad custom regex. */
export function compileQuery(q: PatternQuery): { kind: string; re: RegExp; accept?: (s: string) => boolean }[] {
  const out: { kind: string; re: RegExp; accept?: (s: string) => boolean }[] = [];
  for (const k of q.kinds) out.push({ kind: PATTERNS[k].label, re: new RegExp(PATTERNS[k].re.source, PATTERNS[k].re.flags), accept: PATTERNS[k].accept });
  for (const w of (q.words ?? []).map((x) => x.trim()).filter(Boolean)) {
    out.push({ kind: 'Word', re: new RegExp(w.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'giu') });
  }
  if (q.regex?.trim()) {
    try {
      out.push({ kind: 'Expression', re: new RegExp(q.regex, 'giu') });
    } catch (e) {
      throw new Error(`Invalid expression: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/** Find every occurrence on one page; rectangles come from the text runs the match overlaps. */
export function findPatterns(page: number, items: TextItem[], compiled: ReturnType<typeof compileQuery>): PatternMatch[] {
  const { text, starts } = buildPageText(items);
  const out: PatternMatch[] = [];
  for (const { kind, re, accept } of compiled) {
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (end === start || (accept && !accept(m[0]))) continue;
      const rects: Rect[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i]!;
        const s = starts[i]!;
        const e = s + it.str.length;
        if (e <= start || s >= end || !it.str) continue;
        const r = itemRect(it, Math.max(start, s) - s, Math.min(end, e) - s);
        rects.push({ x: r.x - PAD, y: r.y, width: r.width + 2 * PAD, height: r.height }); // err on the side of removing too much
      }
      if (rects.length) out.push({ page, text: m[0], rects, kind });
    }
  }
  return out;
}
