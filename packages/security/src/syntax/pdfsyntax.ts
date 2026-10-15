/**
 * A small PDF object parser/serializer working on raw bytes. It exists for jobs pdf-lib cannot do:
 * opening encrypted files (strings and streams must be decrypted before anything can be parsed, including
 * compressed object streams) and rewriting page content streams (redaction). It is deliberately forgiving:
 * it scans `N G obj` headers sequentially (like a repair pass), so damaged cross-reference data does not matter.
 */

export type PObj = null | boolean | number | PName | PStr | PRef | PObj[] | PDict | PStream | POp;
export interface PName {
  name: string;
}
export interface PStr {
  str: Uint8Array;
}
export interface PRef {
  ref: [number, number];
}
export interface PDict {
  dict: Record<string, PObj>;
}
export interface PStream {
  dict: Record<string, PObj>;
  data: Uint8Array;
  /** True when `data` has been decrypted/decoded from the original bytes. */
  isStream: true;
}
/** Bare keyword: operators in content streams. */
export interface POp {
  op: string;
}

export const isName = (o: PObj, n?: string): o is PName => !!o && typeof o === 'object' && !Array.isArray(o) && 'name' in o && (n === undefined || o.name === n);
export const isStr = (o: PObj): o is PStr => !!o && typeof o === 'object' && !Array.isArray(o) && 'str' in o;
export const isRef = (o: PObj): o is PRef => !!o && typeof o === 'object' && !Array.isArray(o) && 'ref' in o;
export const isOp = (o: PObj, n?: string): o is POp => !!o && typeof o === 'object' && !Array.isArray(o) && 'op' in o && (n === undefined || o.op === n);
export const isStream = (o: PObj): o is PStream => !!o && typeof o === 'object' && !Array.isArray(o) && 'isStream' in o;
export const isDict = (o: PObj): o is PDict => !!o && typeof o === 'object' && !Array.isArray(o) && 'dict' in o && !('isStream' in o);
export const dictOf = (o: PObj | undefined): Record<string, PObj> | undefined => (o && typeof o === 'object' && !Array.isArray(o) && 'dict' in o ? o.dict : undefined);

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);
const isDigit = (c: number) => c >= 48 && c <= 57;

export class Lexer {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
  ) {}

  eof() {
    return this.pos >= this.buf.length;
  }

  skipWs() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  private word(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos]!)) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(this.buf[i]!);
    return s;
  }

  /** Parse the next object. Returns `undefined` at end of data or on a stray closing delimiter. */
  parse(allowRefs = true): PObj | undefined {
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) return undefined;
    const c = b[this.pos]!;
    if (c === 60 && b[this.pos + 1] === 60) return this.dict(allowRefs);
    if (c === 60) return this.hexString();
    if (c === 40) return this.litString();
    if (c === 91) return this.array(allowRefs);
    if (c === 47) return this.nameObj();
    if (c === 93 || c === 62 || c === 41) return undefined;
    if (c === 123 || c === 125) {
      this.pos++;
      return { op: String.fromCharCode(c) };
    }
    const start = this.pos;
    const w = this.word();
    if (!w) {
      this.pos++;
      return undefined;
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (allowRefs && /^\d+$/.test(w)) {
        // indirect reference "n g R"
        const save = this.pos;
        this.skipWs();
        if (isDigit(b[this.pos] ?? 0)) {
          const g = this.word();
          this.skipWs();
          if (/^\d+$/.test(g) && b[this.pos] === 82 && !isRegular(b[this.pos + 1] ?? 32)) {
            this.pos++;
            return { ref: [n, Number(g)] };
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    void start;
    return { op: w };
  }

  private dict(allowRefs: boolean): PDict {
    this.pos += 2;
    const out: Record<string, PObj> = {};
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 62 && this.buf[this.pos + 1] === 62) {
        this.pos += 2;
        break;
      }
      const k = this.parse(allowRefs);
      if (!isName(k as PObj)) {
        if (k === undefined) this.pos++; // stray delimiter: skip to stay productive
        continue;
      }
      this.skipWs();
      if (this.buf[this.pos] === 62 && this.buf[this.pos + 1] === 62) {
        out[(k as PName).name] = null;
        continue;
      }
      const v = this.parse(allowRefs);
      out[(k as PName).name] = v === undefined ? null : v;
    }
    return { dict: out };
  }

  private array(allowRefs: boolean): PObj[] {
    this.pos++;
    const out: PObj[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.buf.length) break;
      if (this.buf[this.pos] === 93) {
        this.pos++;
        break;
      }
      const v = this.parse(allowRefs);
      if (v === undefined) this.pos++;
      else out.push(v);
    }
    return out;
  }

  private nameObj(): PName {
    this.pos++;
    const bytes: number[] = [];
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos]!)) {
      const c = this.buf[this.pos]!;
      if (c === 35 && this.pos + 2 < this.buf.length) {
        const h = parseInt(String.fromCharCode(this.buf[this.pos + 1]!, this.buf[this.pos + 2]!), 16);
        if (!Number.isNaN(h)) {
          bytes.push(h);
          this.pos += 3;
          continue;
        }
      }
      bytes.push(c);
      this.pos++;
    }
    return { name: String.fromCharCode(...bytes) };
  }

  private hexString(): PStr {
    this.pos++;
    const hex: number[] = [];
    while (this.pos < this.buf.length && this.buf[this.pos] !== 62) {
      const c = this.buf[this.pos++]!;
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0) hex.push(v);
    }
    this.pos++;
    if (hex.length % 2) hex.push(0);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (hex[2 * i]! << 4) | hex[2 * i + 1]!;
    return { str: out };
  }

  private litString(): PStr {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    const b = this.buf;
    while (this.pos < b.length) {
      let c = b[this.pos++]!;
      if (c === 92) {
        c = b[this.pos++]!;
        if (c === 110) out.push(10);
        else if (c === 114) out.push(13);
        else if (c === 116) out.push(9);
        else if (c === 98) out.push(8);
        else if (c === 102) out.push(12);
        else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let k = 0; k < 2 && b[this.pos]! >= 48 && b[this.pos]! <= 55; k++) v = v * 8 + (b[this.pos++]! - 48);
          out.push(v & 255);
        } else if (c === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (c === 10) {
          /* line continuation */
        } else out.push(c);
      } else if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { str: Uint8Array.from(out) };
  }
}

// ------------------------------------------------------------------ serialization

const enc = new TextEncoder();
const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100000) / 100000));

export function serialize(o: PObj, out: number[] | { push(...n: number[]): number } = []): number[] {
  const arr = out as number[];
  const putStr = (s: string) => {
    for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i) & 255);
  };
  const put = (v: PObj) => {
    if (v === null) putStr('null');
    else if (typeof v === 'boolean') putStr(v ? 'true' : 'false');
    else if (typeof v === 'number') putStr(num(v));
    else if (Array.isArray(v)) {
      putStr('[');
      v.forEach((x, i) => {
        if (i) putStr(' ');
        put(x);
      });
      putStr(']');
    } else if (isName(v)) {
      putStr('/');
      for (const byte of Array.from(v.name, (ch) => ch.charCodeAt(0) & 255)) {
        if (byte < 33 || byte > 126 || DELIM.has(byte) || byte === 35) putStr('#' + byte.toString(16).padStart(2, '0'));
        else arr.push(byte);
      }
    } else if (isStr(v)) {
      putStr('<');
      for (const x of v.str) putStr(x.toString(16).padStart(2, '0'));
      putStr('>');
    } else if (isRef(v)) putStr(`${v.ref[0]} ${v.ref[1]} R`);
    else if (isOp(v)) putStr(v.op);
    else {
      const d = (v as PDict | PStream).dict;
      putStr('<<');
      for (const [k, val] of Object.entries(d)) {
        put({ name: k });
        putStr(' ');
        put(val);
        putStr(' ');
      }
      putStr('>>');
    }
  };
  put(o);
  return arr;
}

export const serializeToBytes = (o: PObj) => Uint8Array.from(serialize(o));
export const asciiOf = (bytes: Uint8Array, a = 0, b = bytes.length) => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};
export const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

// ------------------------------------------------------------------ whole-file scan

export interface RawObject {
  num: number;
  gen: number;
  obj: PObj;
  /** Byte offset of the `N G obj` header (used to decide which trailer is the last one). */
  offset: number;
}

export interface Scan {
  objects: RawObject[];
  /** Trailer dictionary entries, merged with later trailers/xref-stream dictionaries taking precedence. */
  trailer: Record<string, PObj>;
  header: string;
}

/** Sequentially parse every indirect object in the file. */
export function scanFile(bytes: Uint8Array): Scan {
  const lx = new Lexer(bytes, 0);
  const objects: RawObject[] = [];
  const trailers: { offset: number; dict: Record<string, PObj> }[] = [];
  const headerEnd = Math.min(bytes.length, 20);
  const header = asciiOf(bytes, 0, headerEnd).match(/%PDF-\d\.\d/)?.[0] ?? '%PDF-1.7';

  while (!lx.eof()) {
    lx.skipWs();
    const start = lx.pos;
    const first = lx.parse(false);
    if (first === undefined) {
      lx.pos++;
      continue;
    }
    if (isOp(first, 'trailer')) {
      const d = lx.parse();
      const dd = dictOf(d ?? null);
      if (dd) trailers.push({ offset: start, dict: dd });
      continue;
    }
    if (typeof first === 'number' && Number.isInteger(first)) {
      const save = lx.pos;
      const gen = lx.parse(false);
      const kw = lx.parse(false);
      if (typeof gen === 'number' && isOp(kw as PObj, 'obj')) {
        const obj = parseBody(lx);
        objects.push({ num: first, gen, obj, offset: start });
        continue;
      }
      lx.pos = save;
    }
  }

  // Last trailer wins; xref-stream dictionaries act as trailers too.
  for (const o of objects) {
    if (isStream(o.obj) && isName(o.obj.dict.Type ?? null, 'XRef')) trailers.push({ offset: o.offset, dict: o.obj.dict });
  }
  trailers.sort((a, b) => a.offset - b.offset);
  const trailer: Record<string, PObj> = {};
  for (const t of trailers) Object.assign(trailer, t.dict);
  return { objects, trailer, header };
}

function parseBody(lx: Lexer): PObj {
  const body = lx.parse() ?? null;
  const d = dictOf(body);
  lx.skipWs();
  if (d && lx.buf[lx.pos] === 115 && asciiOf(lx.buf, lx.pos, lx.pos + 6) === 'stream') {
    lx.pos += 6;
    if (lx.buf[lx.pos] === 13 && lx.buf[lx.pos + 1] === 10) lx.pos += 2;
    else if (lx.buf[lx.pos] === 10 || lx.buf[lx.pos] === 13) lx.pos++;
    const start = lx.pos;
    let end = -1;
    const len = d.Length;
    if (typeof len === 'number' && start + len <= lx.buf.length) {
      // trust /Length only if `endstream` follows
      const tail = asciiOf(lx.buf, start + len, Math.min(lx.buf.length, start + len + 12));
      if (/^\s*endstream/.test(tail)) end = start + len;
    }
    if (end < 0) {
      const marker = bytesOf('endstream');
      end = indexOf(lx.buf, marker, start);
      if (end < 0) end = lx.buf.length;
      else {
        if (lx.buf[end - 1] === 10) end--;
        if (lx.buf[end - 1] === 13) end--;
      }
    }
    const data = lx.buf.slice(start, end);
    lx.pos = end;
    skipKeyword(lx, 'endstream');
    skipKeyword(lx, 'endobj');
    return { dict: d, data, isStream: true };
  }
  skipKeyword(lx, 'endobj');
  return body;
}

function skipKeyword(lx: Lexer, kw: string) {
  lx.skipWs();
  if (asciiOf(lx.buf, lx.pos, lx.pos + kw.length) === kw) lx.pos += kw.length;
}

export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ------------------------------------------------------------------ writing a fresh PDF from objects

export function writePdf(header: string, objects: Map<number, { gen: number; obj: PObj }>, trailer: Record<string, PObj>): Uint8Array {
  const out: number[] = [];
  const putStr = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  };
  putStr(header + '\n%\xE2\xE3\xCF\xD3\n');
  const offsets = new Map<number, number>();
  const nums = [...objects.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    const { gen, obj } = objects.get(n)!;
    offsets.set(n, out.length);
    putStr(`${n} ${gen} obj\n`);
    if (isStream(obj)) {
      const dict = { ...obj.dict, Length: obj.data.length };
      serialize({ dict }, out);
      putStr('\nstream\n');
      for (let i = 0; i < obj.data.length; i += 8192) out.push(...obj.data.subarray(i, i + 8192));
      putStr('\nendstream');
    } else serialize(obj, out);
    putStr('\nendobj\n');
  }
  const max = nums.length ? nums[nums.length - 1]! : 0;
  const xrefAt = out.length;
  putStr(`xref\n0 ${max + 1}\n`);
  putStr('0000000000 65535 f \n');
  for (let n = 1; n <= max; n++) {
    const off = offsets.get(n);
    putStr(off === undefined ? '0000000000 65535 f \n' : `${String(off).padStart(10, '0')} ${String(objects.get(n)!.gen).padStart(5, '0')} n \n`);
  }
  putStr('trailer\n');
  serialize({ dict: { ...trailer, Size: max + 1 } }, out);
  putStr(`\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Uint8Array.from(out);
}
