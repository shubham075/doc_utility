import { Lexer, asciiOf, bytesOf, indexOf, isOp, isStr, serialize, type PDict, type PObj } from '../syntax/pdfsyntax';

/** One content-stream instruction: operands followed by an operator. */
export interface Op {
  op: string;
  operands: PObj[];
  /** Inline image (BI ... ID ... EI): dictionary entries and raw data. */
  inline?: { dict: Record<string, PObj>; data: Uint8Array };
}

const WS = new Set([0, 9, 10, 12, 13, 32]);

/** Tokenise a decoded content stream into instructions. Unknown garbage is skipped, never thrown on. */
export function parseContent(data: Uint8Array): Op[] {
  const lx = new Lexer(data, 0);
  const ops: Op[] = [];
  let operands: PObj[] = [];
  while (!lx.eof()) {
    const o = lx.parse(false);
    if (o === undefined) {
      lx.pos++;
      continue;
    }
    if (isOp(o)) {
      if (o.op === 'BI') {
        const dict: Record<string, PObj> = {};
        for (;;) {
          lx.skipWs();
          const k = lx.parse(false);
          if (k === undefined || isOp(k, 'ID')) break;
          const v = lx.parse(false);
          if (k && typeof k === 'object' && 'name' in k && v !== undefined) dict[k.name] = v;
        }
        // ID is followed by a single whitespace byte, then raw data up to "EI"
        if (WS.has(data[lx.pos] ?? 0)) lx.pos++;
        const start = lx.pos;
        let end = start;
        for (let i = start; i < data.length - 1; i++) {
          if (data[i] === 0x45 && data[i + 1] === 0x49 && WS.has(data[i - 1] ?? 32) && (i + 2 >= data.length || WS.has(data[i + 2]!))) {
            end = i - 1 >= start ? i - 1 : i;
            lx.pos = i + 2;
            break;
          }
          end = data.length;
          lx.pos = data.length;
        }
        ops.push({ op: 'BI', operands: [], inline: { dict, data: data.slice(start, Math.max(start, end)) } });
        operands = [];
        continue;
      }
      ops.push({ op: o.op, operands });
      operands = [];
    } else operands.push(o);
  }
  return ops;
}

export function serializeContent(ops: readonly Op[]): Uint8Array {
  const out: number[] = [];
  const put = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  };
  for (const o of ops) {
    if (o.inline) {
      put('BI\n');
      for (const [k, v] of Object.entries(o.inline.dict)) {
        serialize({ name: k }, out);
        put(' ');
        serialize(v, out);
        put('\n');
      }
      put('ID\n');
      for (const b of o.inline.data) out.push(b);
      put('\nEI\n');
      continue;
    }
    for (const a of o.operands) {
      serialize(a, out);
      put(' ');
    }
    put(o.op + '\n');
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------------ matrices (PDF row-vector convention)

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 × m2: apply m1 first, then m2. */
export const mmul = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export const boxOfPoints = (pts: [number, number][]): Box => ({
  x1: Math.min(...pts.map((p) => p[0])),
  y1: Math.min(...pts.map((p) => p[1])),
  x2: Math.max(...pts.map((p) => p[0])),
  y2: Math.max(...pts.map((p) => p[1])),
});

export const overlapArea = (a: Box, b: Box): number => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
export const intersects = (a: Box, b: Box) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
export const area = (a: Box) => Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1);
export const inside = (inner: Box, outer: Box, tol = 0) => inner.x1 >= outer.x1 - tol && inner.y1 >= outer.y1 - tol && inner.x2 <= outer.x2 + tol && inner.y2 <= outer.y2 + tol;

export const num = (o: PObj | undefined, d = 0) => (typeof o === 'number' ? o : d);
export { isStr, asciiOf, bytesOf, indexOf };
export type { PDict };
