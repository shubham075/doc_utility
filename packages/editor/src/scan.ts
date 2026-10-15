import { PDFArray, PDFDict, PDFName, PDFStream, type PDFContext, type PDFDocument, type PDFPage } from 'pdf-lib';
import { fromUser, pageGeometry, type PageGeometry, type Rect } from '@pdfsuite/annotations';
import { IDENTITY, apply, boxOfPoints, isStr, mmul, num, parseContent, type Matrix, type Op } from '@pdfsuite/security/content';
import { FontLoader, type FontInfo } from '@pdfsuite/security/fonts';
import type { PObj } from '@pdfsuite/security/syntax';
import { loadCodec, type FontCodec } from './fontcodec';
import { N, matrixOf, pageContent } from './util';

export type ObjectKind = 'text' | 'image' | 'inline-image' | 'form' | 'path';

export interface PageObject {
  /** Stable while the page content is unchanged: `<kind>:<index of the first instruction>`. */
  id: string;
  kind: ObjectKind;
  page: number;
  /** Bounding box in display space (points, top-left origin, after page rotation). */
  bbox: Rect;
  /** text: the decoded string; image/form: the resource name. */
  text?: string;
  fontName?: string;
  fontSize?: number;
  /** text: every character could be decoded, so the string can be edited. */
  editable?: boolean;
  /** image: pixel size. */
  pixels?: { width: number; height: number };
}

interface TextState {
  fontName: string;
  fontDict: PDFDict | null;
  info: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

/** What the editing functions need to know about a text object. */
export interface TextInternal {
  index: number;
  /** Instructions that must precede the show instruction (the implicit part of ' and "). */
  pre: Op[];
  show: Op;
  ts: TextState;
  tmBefore: Matrix;
  tlm: Matrix;
  /** Horizontal advance of the whole string in text space (includes Tc, Tw and Tz). */
  advance: number;
  codes: number[];
  btStart: number;
}

export interface ObjectInternal {
  start: number;
  end: number;
  ctm: Matrix;
  text?: TextInternal;
  xobject?: string;
}

export interface ScanResult {
  ops: Op[];
  objects: PageObject[];
  internal: Map<string, ObjectInternal>;
  geometry: PageGeometry;
  page: PDFPage;
  ctx: PDFContext;
  codec(fontDict: PDFDict): Promise<FontCodec>;
}

const nameArg = (o: PObj | undefined) => (o && typeof o === 'object' && !Array.isArray(o) && 'name' in o ? o.name : '');

function toDisplay(g: PageGeometry, pts: [number, number][]): Rect {
  const d = pts.map(([x, y]) => fromUser(g, { x, y }));
  const b = boxOfPoints(d.map((p) => [p.x, p.y] as [number, number]));
  return { x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1 };
}

const unitSquare = (m: Matrix): [number, number][] => [apply(m, 0, 0), apply(m, 1, 0), apply(m, 1, 1), apply(m, 0, 1)];

/**
 * Parse a page's content into editable objects (text runs, images, vector paths, form XObjects) with their
 * positions. Only the page's own content stream is scanned: the insides of form XObjects are reported as one object.
 */
export async function scanPage(doc: PDFDocument, pageIndex: number, loader = new FontLoader(doc.context)): Promise<ScanResult> {
  const ctx = doc.context;
  const page = doc.getPages()[pageIndex];
  if (!page) throw new Error(`No page ${pageIndex + 1}`);
  const g = pageGeometry(page);
  const resources = page.node.Resources();
  const ops = parseContent(pageContent(ctx, page.node.get(N('Contents'))));

  const objects: PageObject[] = [];
  const internal = new Map<string, ObjectInternal>();
  const used = new Map<PDFDict, Set<number>>();
  const textObjs: { obj: PageObject; int: TextInternal }[] = [];

  const fontDict = (name: string): PDFDict | null => {
    const fonts = resources && ctx.lookup(resources.get(N('Font')));
    const fd = fonts instanceof PDFDict ? ctx.lookup(fonts.get(N(name))) : undefined;
    return fd instanceof PDFDict ? fd : null;
  };

  let ctm = IDENTITY;
  const stack: { ctm: Matrix; ts: TextState }[] = [];
  let ts: TextState = { fontName: '', fontDict: null, info: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let btStart = -1;
  let lineWidth = 1;
  let pathStart = -1;
  let pathPts: [number, number][] = [];
  let pathClip = false;
  const point = (x: number, y: number) => pathPts.push(apply(ctm, x, y));
  const resetPath = () => {
    pathStart = -1;
    pathPts = [];
    pathClip = false;
  };
  const beginPath = (i: number) => {
    if (pathStart < 0) pathStart = i;
  };
  const moveText = (tx: number, ty: number) => {
    tlm = mmul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const add = (o: PageObject, start: number, end: number, extra: Partial<ObjectInternal> = {}) => {
    objects.push(o);
    internal.set(o.id, { start, end, ctm, ...extra });
  };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!;
    const a = o.operands;
    switch (o.op) {
      case 'q':
        stack.push({ ctm, ts: { ...ts } });
        break;
      case 'Q': {
        const top = stack.pop();
        if (top) {
          ctm = top.ctm;
          ts = top.ts;
        }
        break;
      }
      case 'cm':
        ctm = mmul(a.map((x) => num(x)) as Matrix, ctm);
        break;
      case 'w':
        lineWidth = num(a[0], 1);
        break;
      case 'BT':
        tm = tlm = IDENTITY;
        btStart = i;
        break;
      case 'Tf': {
        const n = nameArg(a[0]);
        const fd = fontDict(n);
        ts.fontName = n;
        ts.fontDict = fd;
        ts.info = fd ? await loader.load(fd) : null;
        ts.size = num(a[1]);
        break;
      }
      case 'Tc': ts.tc = num(a[0]); break;
      case 'Tw': ts.tw = num(a[0]); break;
      case 'Tz': ts.th = num(a[0], 100) / 100; break;
      case 'TL': ts.tl = num(a[0]); break;
      case 'Ts': ts.rise = num(a[0]); break;
      case 'Td': moveText(num(a[0]), num(a[1])); break;
      case 'TD': ts.tl = -num(a[1]); moveText(num(a[0]), num(a[1])); break;
      case 'Tm': tm = tlm = a.map((x) => num(x)) as Matrix; break;
      case 'T*': moveText(0, -ts.tl); break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        const pre: Op[] = [];
        let elements: PObj[];
        if (o.op === "'" || o.op === '"') {
          if (o.op === '"') {
            ts.tw = num(a[0]);
            ts.tc = num(a[1]);
            pre.push({ op: 'Tw', operands: [a[0]!] }, { op: 'Tc', operands: [a[1]!] });
          }
          moveText(0, -ts.tl);
          pre.push({ op: 'T*', operands: [] });
          elements = [a[a.length - 1]!];
        } else if (o.op === 'Tj') elements = [a[0]!];
        else elements = Array.isArray(a[0]) ? (a[0] as PObj[]) : [];

        const info = ts.info;
        const step = info?.bytesPerCode ?? 1;
        const tmBefore = tm;
        const tlmNow = tlm;
        let adv = 0;
        const codes: number[] = [];
        for (const el of elements) {
          if (typeof el === 'number') {
            adv += (-el / 1000) * ts.size * ts.th;
            continue;
          }
          if (!isStr(el)) continue;
          for (let k = 0; k + step <= el.str.length; k += step) {
            const code = step === 2 ? (el.str[k]! << 8) | el.str[k + 1]! : el.str[k]!;
            codes.push(code);
            const w = info ? info.width(code) : 500;
            adv += ((w / 1000) * ts.size + ts.tc + (step === 1 && code === 32 ? ts.tw : 0)) * ts.th;
          }
        }
        tm = mmul([1, 0, 0, 1, adv, 0], tm);
        if (ts.fontDict) {
          let set = used.get(ts.fontDict);
          if (!set) used.set(ts.fontDict, (set = new Set()));
          for (const c of codes) set.add(c);
        }
        if (!codes.length) break; // advance-only (left behind by deleted text)
        const asc = info?.ascent ?? 0.88;
        const desc = info?.descent ?? -0.12;
        const trm = mmul([1, 0, 0, 1, 0, ts.rise], mmul(tmBefore, ctm));
        const bbox = toDisplay(g, [apply(trm, 0, desc * ts.size), apply(trm, adv, desc * ts.size), apply(trm, adv, asc * ts.size), apply(trm, 0, asc * ts.size)]);
        const show: Op = o.op === "'" || o.op === '"' ? { op: 'TJ', operands: [elements] } : o;
        const obj: PageObject = {
          id: `text:${i}`,
          kind: 'text',
          page: pageIndex,
          bbox,
          fontName: ts.fontName,
          fontSize: Math.abs(ts.size * Math.hypot(trm[0], trm[1])),
          text: '',
          editable: false,
        };
        const int: TextInternal = { index: i, pre, show, ts: { ...ts }, tmBefore, tlm: tlmNow, advance: adv, codes, btStart };
        add(obj, i, i + 1, { text: int });
        textObjs.push({ obj, int });
        break;
      }
      // ---- paths
      case 'm': case 'l': beginPath(i); point(num(a[0]), num(a[1])); break;
      case 'c': beginPath(i); point(num(a[0]), num(a[1])); point(num(a[2]), num(a[3])); point(num(a[4]), num(a[5])); break;
      case 'v': case 'y': beginPath(i); point(num(a[0]), num(a[1])); point(num(a[2]), num(a[3])); break;
      case 're': {
        beginPath(i);
        const [x, y, w, h] = a.map((v) => num(v)) as [number, number, number, number];
        point(x, y); point(x + w, y); point(x + w, y + h); point(x, y + h);
        break;
      }
      case 'h': break;
      case 'W': case 'W*': pathClip = true; break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
        if (pathStart >= 0 && !pathClip && pathPts.length) {
          const stroked = /^[SsBb]/.test(o.op);
          const pad = stroked ? (lineWidth * Math.hypot(ctm[0], ctm[1])) / 2 : 0;
          const b = toDisplay(g, pathPts);
          add({ id: `path:${pathStart}`, kind: 'path', page: pageIndex, bbox: { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad } }, pathStart, i + 1);
        }
        resetPath();
        break;
      }
      case 'n': resetPath(); break;
      // ---- XObjects
      case 'Do': {
        const name = nameArg(a[0]);
        const xo = resources && ctx.lookup(resources.get(N('XObject')));
        const obj = xo instanceof PDFDict ? ctx.lookup(xo.get(N(name))) : undefined;
        if (!(obj instanceof PDFStream)) break;
        const st = ctx.lookup(obj.dict.get(N('Subtype')));
        const sub = st instanceof PDFName ? st.decodeText() : '';
        if (sub === 'Image') {
          const w = ctx.lookup(obj.dict.get(N('Width')));
          const h = ctx.lookup(obj.dict.get(N('Height')));
          add(
            {
              id: `image:${i}`,
              kind: 'image',
              page: pageIndex,
              bbox: toDisplay(g, unitSquare(ctm)),
              text: name,
              pixels: { width: w && 'asNumber' in w ? (w as { asNumber(): number }).asNumber() : 0, height: h && 'asNumber' in h ? (h as { asNumber(): number }).asNumber() : 0 },
            },
            i,
            i + 1,
            { xobject: name },
          );
        } else if (sub === 'Form') {
          const bb = ctx.lookup(obj.dict.get(N('BBox')));
          const m = mmul(matrixOf(ctx, obj.dict.get(N('Matrix'))), ctm);
          let pts: [number, number][];
          if (bb instanceof PDFArray && bb.size() >= 4) {
            const v = [0, 1, 2, 3].map((k) => (ctx.lookup(bb.get(k)) as unknown as { asNumber(): number }).asNumber());
            pts = [apply(m, v[0]!, v[1]!), apply(m, v[2]!, v[1]!), apply(m, v[2]!, v[3]!), apply(m, v[0]!, v[3]!)];
          } else pts = unitSquare(m);
          add({ id: `form:${i}`, kind: 'form', page: pageIndex, bbox: toDisplay(g, pts), text: name }, i, i + 1, { xobject: name });
        }
        break;
      }
      case 'BI':
        add({ id: `inline-image:${i}`, kind: 'inline-image', page: pageIndex, bbox: toDisplay(g, unitSquare(ctm)) }, i, i + 1);
        break;
      default:
        if (pathStart >= 0 && !/^(w|J|j|M|d|ri|i|gs|g|G|rg|RG|k|K|cs|CS|sc|SC|scn|SCN)$/.test(o.op)) resetPath();
    }
  }

  const codecs = new Map<PDFDict, FontCodec>();
  const codec = async (fd: PDFDict) => {
    let c = codecs.get(fd);
    if (!c) {
      c = await loadCodec(ctx, fd, loader, used.get(fd) ?? new Set());
      codecs.set(fd, c);
    }
    return c;
  };
  for (const { obj, int } of textObjs) {
    const fd = int.ts.fontDict;
    if (!fd) {
      obj.text = '';
      continue;
    }
    const c = await codec(fd);
    let s = '';
    let ok = int.codes.length > 0;
    for (const code of int.codes) {
      const u = c.decode(code);
      if (u === undefined) ok = false;
      s += u ?? '�';
    }
    obj.text = s;
    obj.editable = ok;
  }

  return { ops, objects, internal, geometry: g, page, ctx, codec };
}
