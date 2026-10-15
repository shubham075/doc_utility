import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, type PDFContext, type PDFObject } from 'pdf-lib';
import { loadDoc, pageGeometry, rectToUser, type Rect } from '@pdfsuite/annotations';
import { pruneUnreferenced } from '@pdfsuite/convert';
import { isName, isStr, type PObj } from '../syntax/pdfsyntax';
import {
  IDENTITY,
  apply,
  area,
  boxOfPoints,
  inside,
  intersects,
  invert,
  mmul,
  num,
  overlapArea,
  parseContent,
  serializeContent,
  type Box,
  type Matrix,
  type Op,
} from './content';
import { FontLoader, type FontInfo } from './fonts';

export interface RedactionMark {
  /** Zero-based page. */
  page: number;
  /** Areas to destroy, in page display space (points, top-left origin). */
  rects: Rect[];
}

export interface JpegDecoder {
  (jpeg: Uint8Array): Promise<{ width: number; height: number; rgb: Uint8Array } | null>;
}

export interface RedactOptions {
  /** Colour of the covering rectangle, #rrggbb (default black). */
  overlayColor?: string;
  /** Needed to blank out pixels of JPEG images; without it such images are removed completely. */
  decodeJpeg?: JpegDecoder;
  /** Remove annotations (comments, form widgets, links...) that overlap a redaction (default true). */
  removeAnnotations?: boolean;
  /** Remove small vector shapes inside a redaction (default true). Shapes larger than the area are kept. */
  removeVectors?: boolean;
}

export interface RedactReport {
  pages: number;
  glyphsRemoved: number;
  imagesRedacted: number;
  imagesRemoved: number;
  inlineImagesRemoved: number;
  pathsRemoved: number;
  annotationsRemoved: number;
  formXObjectsRewritten: number;
}

const N = (s: string) => PDFName.of(s);

interface Env {
  ctx: PDFContext;
  boxes: Box[];
  fonts: FontLoader;
  opts: Required<Pick<RedactOptions, 'removeVectors'>> & RedactOptions;
  report: RedactReport;
  newName: () => string;
  imageCache: Map<string, PDFRef | null>;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1]!, 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

const matrixOf = (ctx: PDFContext, v: PDFObject | undefined): Matrix => {
  const a = ctx.lookup(v);
  if (!(a instanceof PDFArray) || a.size() < 6) return IDENTITY;
  return Array.from({ length: 6 }, (_, i) => {
    const n = ctx.lookup(a.get(i));
    return n instanceof PDFNumber ? n.asNumber() : 0;
  }) as Matrix;
};

function decodeStream(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
}

/** All content streams of a page joined with newlines. */
function pageContent(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const c = ctx.lookup(contents);
  const streams: PDFStream[] = [];
  if (c instanceof PDFStream) streams.push(c);
  else if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) {
    const s = ctx.lookup(c.get(i));
    if (s instanceof PDFStream) streams.push(s);
  }
  const parts = streams.map(decodeStream);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

// ------------------------------------------------------------------ images

interface ImageSpec {
  w: number;
  h: number;
  comps: 1 | 3 | 4;
  samples: Uint8Array;
  /** Device colour space name written to the replacement image. */
  colorSpace: string;
}

async function readImage(env: Env, s: PDFStream): Promise<ImageSpec | null> {
  const ctx = env.ctx;
  const d = s.dict;
  const get = (k: string) => ctx.lookup(d.get(N(k)));
  if (get('SMask') || get('Mask') || get('Decode') || get('ImageMask') === ctx.obj(true)) return null;
  const imageMask = get('ImageMask');
  if (imageMask && String(imageMask) === 'true') return null;
  const w = (get('Width') as PDFNumber | undefined)?.asNumber();
  const h = (get('Height') as PDFNumber | undefined)?.asNumber();
  const bpc = (get('BitsPerComponent') as PDFNumber | undefined)?.asNumber() ?? 8;
  if (!w || !h || bpc !== 8) return null;

  const cs = get('ColorSpace');
  let comps: 1 | 3 | 4 | 0 = 0;
  let colorSpace = 'DeviceRGB';
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    comps = n === 'DeviceGray' ? 1 : n === 'DeviceRGB' ? 3 : n === 'DeviceCMYK' ? 4 : 0;
    colorSpace = n;
  } else if (cs instanceof PDFArray && cs.size() >= 2) {
    const kind = ctx.lookup(cs.get(0));
    if (kind instanceof PDFName && kind.decodeText() === 'ICCBased') {
      const prof = ctx.lookup(cs.get(1));
      const n = prof instanceof PDFStream ? (ctx.lookup(prof.dict.get(N('N'))) as PDFNumber | undefined)?.asNumber() : undefined;
      comps = n === 1 || n === 3 || n === 4 ? n : 0;
      colorSpace = comps === 1 ? 'DeviceGray' : comps === 4 ? 'DeviceCMYK' : 'DeviceRGB';
    }
  }

  const filter = get('Filter');
  const fname = filter instanceof PDFName ? filter.decodeText() : filter instanceof PDFArray && filter.size() === 1 ? (ctx.lookup(filter.get(0)) as PDFName).decodeText() : filter ? '?' : '';
  let samples: Uint8Array | null = null;
  if (fname === '' && s instanceof PDFRawStream) samples = s.getContents();
  else if (fname === 'FlateDecode' && s instanceof PDFRawStream) samples = decodeStream(s);
  else if (fname === 'DCTDecode' && s instanceof PDFRawStream && env.opts.decodeJpeg) {
    const j = await env.opts.decodeJpeg(s.getContents());
    if (j && j.width === w && j.height === h) {
      samples = j.rgb;
      comps = 3;
      colorSpace = 'DeviceRGB';
    }
  }
  if (!samples || !comps || samples.length < w * h * comps) return null;
  return { w, h, comps, samples: samples.slice(0, w * h * comps), colorSpace };
}

/** Blank the pixels under the redaction boxes and return a replacement image stream (or null if unsupported). */
async function redactImage(env: Env, ref: PDFRef | undefined, s: PDFStream, ctm: Matrix, hits: Box[]): Promise<PDFRef | null> {
  const key = `${ref?.toString() ?? 'inline'}|${ctm.map((x) => x.toFixed(3)).join(',')}|${hits.map((b) => [b.x1, b.y1, b.x2, b.y2].join(',')).join(';')}`;
  if (env.imageCache.has(key)) return env.imageCache.get(key)!;
  const inv = invert(ctm);
  const img = inv ? await readImage(env, s) : null;
  if (!inv || !img) {
    env.imageCache.set(key, null);
    return null;
  }
  const [r, g, b] = hexToRgb(env.opts.overlayColor ?? '#000000').map((v) => Math.round(v * 255)) as [number, number, number];
  const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  for (const box of hits) {
    const corners = (
      [
        [box.x1, box.y1],
        [box.x2, box.y1],
        [box.x2, box.y2],
        [box.x1, box.y2],
      ] as [number, number][]
    ).map(([x, y]) => apply(inv, x, y));
    const u = boxOfPoints(corners);
    const x0 = Math.max(0, Math.floor(u.x1 * img.w) - 1);
    const x1 = Math.min(img.w, Math.ceil(u.x2 * img.w) + 1);
    const y0 = Math.max(0, Math.floor((1 - u.y2) * img.h) - 1);
    const y1 = Math.min(img.h, Math.ceil((1 - u.y1) * img.h) + 1);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * img.w + x) * img.comps;
        if (img.comps === 1) img.samples[o] = luma;
        else if (img.comps === 3) {
          img.samples[o] = r;
          img.samples[o + 1] = g;
          img.samples[o + 2] = b;
        } else {
          img.samples[o] = img.samples[o + 1] = img.samples[o + 2] = 0;
          img.samples[o + 3] = 255; // CMYK black
        }
      }
    }
  }
  const out = env.ctx.register(
    env.ctx.flateStream(img.samples, { Type: 'XObject', Subtype: 'Image', Width: img.w, Height: img.h, ColorSpace: PDFName.of(img.colorSpace), BitsPerComponent: 8 }),
  );
  env.imageCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ content interpreter

interface TextState {
  font: FontInfo | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

function xobjectEntry(ctx: PDFContext, resources: PDFDict | undefined, name: string): { ref: PDFRef | undefined; obj: PDFObject | undefined } {
  const xo = resources && ctx.lookup(resources.get(N('XObject')));
  if (!(xo instanceof PDFDict)) return { ref: undefined, obj: undefined };
  const raw = xo.get(N(name));
  return { ref: raw instanceof PDFRef ? raw : undefined, obj: ctx.lookup(raw) };
}

/** Private copy of a resource dictionary (and its XObject map) so edits never leak into pages/forms that share it. */
function cloneResources(ctx: PDFContext, r: PDFDict | undefined): PDFDict | undefined {
  if (!r) return undefined;
  const c = r.clone(ctx);
  const xo = ctx.lookup(r.get(N('XObject')));
  if (xo instanceof PDFDict) c.set(N('XObject'), xo.clone(ctx));
  return c;
}

function addXObject(ctx: PDFContext, resources: PDFDict, name: string, ref: PDFRef) {
  let xo = ctx.lookup(resources.get(N('XObject')));
  if (!(xo instanceof PDFDict)) {
    xo = ctx.obj({});
    resources.set(N('XObject'), xo);
  }
  (xo as PDFDict).set(N(name), ref);
}

async function processOps(env: Env, ops: Op[], resources: PDFDict | undefined, base: Matrix, depth: number): Promise<{ ops: Op[]; changed: boolean }> {
  const ctx = env.ctx;
  const out: Op[] = [];
  let changed = false;
  let ctm = base;
  const stack: { ctm: Matrix; ts: TextState }[] = [];
  let ts: TextState = { font: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let pathBuf: Op[] = [];
  let pathPts: [number, number][] = [];
  /** Resource names whose drawing was replaced by a redacted copy. */
  const replacedNames = new Set<string>();

  const flushPath = () => {
    out.push(...pathBuf);
    pathBuf = [];
    pathPts = [];
  };
  const moveText = (tx: number, ty: number) => {
    tlm = mmul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const point = (x: number, y: number) => pathPts.push(apply(ctm, x, y));

  const fontOf = async (name: string): Promise<FontInfo | null> => {
    const fonts = resources && ctx.lookup(resources.get(N('Font')));
    const fd = fonts instanceof PDFDict ? ctx.lookup(fonts.get(N(name))) : undefined;
    return fd instanceof PDFDict ? env.fonts.load(fd) : null;
  };

  /** Decide per glyph, return the rewritten TJ element list (or null if nothing was removed). */
  const showText = (elements: PObj[]): PObj[] | null => {
    const f = ts.font;
    const rewritten: PObj[] = [];
    let removedAny = false;
    const h = ts.th;
    for (const el of elements) {
      if (typeof el === 'number') {
        tm = mmul([1, 0, 0, 1, (-el / 1000) * ts.size * h, 0], tm);
        rewritten.push(el);
        continue;
      }
      if (!isStr(el)) {
        rewritten.push(el);
        continue;
      }
      const bytes = el.str;
      const step = f?.bytesPerCode ?? 1;
      let keep: number[] = [];
      let pendingShift = 0; // advance of removed glyphs, in text-space units
      const flushKeep = () => {
        if (keep.length) rewritten.push({ str: Uint8Array.from(keep) });
        keep = [];
      };
      const flushShift = () => {
        if (pendingShift) {
          flushKeep();
          rewritten.push((-pendingShift * 1000) / (ts.size * h || 1));
          pendingShift = 0;
        }
      };
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code = step === 2 ? (bytes[i]! << 8) | bytes[i + 1]! : bytes[i]!;
        const w0 = f ? f.width(code) : 500;
        const asc = f?.ascent ?? 0.88;
        const desc = f?.descent ?? -0.12;
        const wText = (w0 / 1000) * ts.size * h;
        const trm = mmul([1, 0, 0, 1, 0, ts.rise], mmul(tm, ctm));
        const quad: [number, number][] = [apply(trm, 0, desc * ts.size), apply(trm, wText, desc * ts.size), apply(trm, wText, asc * ts.size), apply(trm, 0, asc * ts.size)];
        const gb = boxOfPoints(quad);
        const ga = area(gb) || 1e-9;
        const cx = (gb.x1 + gb.x2) / 2;
        const cy = (gb.y1 + gb.y2) / 2;
        const doomed = env.boxes.some((b) => (cx > b.x1 && cx < b.x2 && cy > b.y1 && cy < b.y2) || overlapArea(gb, b) / ga >= 0.2);
        const adv = ((w0 / 1000) * ts.size + ts.tc + (step === 1 && code === 32 ? ts.tw : 0)) * h;
        if (doomed) {
          removedAny = true;
          env.report.glyphsRemoved++;
          pendingShift += adv;
        } else {
          flushShift();
          for (let k = 0; k < step; k++) keep.push(bytes[i + k]!);
        }
        tm = mmul([1, 0, 0, 1, adv, 0], tm);
      }
      flushKeep();
      flushShift();
    }
    return removedAny ? rewritten : null;
  };

  for (const op of ops) {
    const a = op.operands;
    switch (op.op) {
      case 'q':
        stack.push({ ctm, ts: { ...ts } });
        out.push(op);
        break;
      case 'Q': {
        const top = stack.pop();
        if (top) {
          ctm = top.ctm;
          ts = top.ts;
        }
        out.push(op);
        break;
      }
      case 'cm':
        ctm = mmul(a.map((x) => num(x)) as Matrix, ctm);
        out.push(op);
        break;
      case 'BT':
        tm = tlm = IDENTITY;
        out.push(op);
        break;
      case 'Tf': {
        const n = a[0] && typeof a[0] === 'object' && 'name' in a[0] ? a[0].name : '';
        ts.font = await fontOf(n);
        ts.size = num(a[1]);
        out.push(op);
        break;
      }
      case 'Tc': ts.tc = num(a[0]); out.push(op); break;
      case 'Tw': ts.tw = num(a[0]); out.push(op); break;
      case 'Tz': ts.th = num(a[0], 100) / 100; out.push(op); break;
      case 'TL': ts.tl = num(a[0]); out.push(op); break;
      case 'Ts': ts.rise = num(a[0]); out.push(op); break;
      case 'Td': moveText(num(a[0]), num(a[1])); out.push(op); break;
      case 'TD': ts.tl = -num(a[1]); moveText(num(a[0]), num(a[1])); out.push(op); break;
      case 'Tm': tm = tlm = a.map((x) => num(x)) as Matrix; out.push(op); break;
      case 'T*': moveText(0, -ts.tl); out.push(op); break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        let pre: Op[] = [];
        let elements: PObj[];
        if (op.op === "'" || op.op === '"') {
          if (op.op === '"') {
            ts.tw = num(a[0]);
            ts.tc = num(a[1]);
            pre = [{ op: 'Tw', operands: [a[0]!] }, { op: 'Tc', operands: [a[1]!] }];
          }
          moveText(0, -ts.tl);
          pre.push({ op: 'T*', operands: [] });
          elements = [a[a.length - 1]!];
        } else if (op.op === 'Tj') elements = [a[0]!];
        else elements = Array.isArray(a[0]) ? (a[0] as PObj[]) : [];
        const re = showText(elements);
        if (re) {
          changed = true;
          out.push(...pre, { op: 'TJ', operands: [re] });
        } else if (pre.length) out.push(...pre, { op: op.op === "'" || op.op === '"' ? 'TJ' : op.op, operands: [elements] });
        else out.push(op);
        break;
      }
      // ---- paths
      case 'm': case 'l': point(num(a[0]), num(a[1])); pathBuf.push(op); break;
      case 'c': point(num(a[0]), num(a[1])); point(num(a[2]), num(a[3])); point(num(a[4]), num(a[5])); pathBuf.push(op); break;
      case 'v': case 'y': point(num(a[0]), num(a[1])); point(num(a[2]), num(a[3])); pathBuf.push(op); break;
      case 're': {
        const [x, y, w, h] = a.map((v) => num(v));
        point(x!, y!); point(x! + w!, y!); point(x! + w!, y! + h!); point(x!, y! + h!);
        pathBuf.push(op);
        break;
      }
      case 'h': case 'W': case 'W*': pathBuf.push(op); break;
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': {
        const pb = pathPts.length ? boxOfPoints(pathPts) : null;
        const clip = pathBuf.some((p) => p.op === 'W' || p.op === 'W*');
        if (env.opts.removeVectors && pb && !clip && env.boxes.some((b) => intersects(pb, b) && inside(pb, b, 2))) {
          env.report.pathsRemoved++;
          changed = true;
          pathBuf = [];
          pathPts = [];
        } else {
          flushPath();
          out.push(op);
        }
        break;
      }
      case 'n':
        flushPath();
        out.push(op);
        break;
      // ---- XObjects
      case 'Do': {
        flushPath();
        const name = a[0] && typeof a[0] === 'object' && 'name' in a[0] ? a[0].name : '';
        const { ref, obj } = xobjectEntry(ctx, resources, name);
        const subtype = obj instanceof PDFStream ? ctx.lookup(obj.dict.get(N('Subtype'))) : undefined;
        const st = subtype instanceof PDFName ? subtype.decodeText() : '';
        if (obj instanceof PDFStream && st === 'Image') {
          const unit = boxOfPoints([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)]);
          const hits = env.boxes.filter((b) => intersects(unit, b));
          if (!hits.length) {
            out.push(op);
            break;
          }
          changed = true;
          const replacement = await redactImage(env, ref, obj, ctm, hits);
          if (replacement && resources) {
            const nn = env.newName();
            addXObject(ctx, resources, nn, replacement);
            out.push({ op: 'Do', operands: [{ name: nn }] });
            replacedNames.add(name);
            env.report.imagesRedacted++;
          } else {
            replacedNames.add(name);
            env.report.imagesRemoved++; // drop the picture; the covering box hides the gap
          }
        } else if (obj instanceof PDFStream && st === 'Form' && depth < 8) {
          const formCtm = mmul(matrixOf(ctx, obj.dict.get(N('Matrix'))), ctm);
          const res = ctx.lookup(obj.dict.get(N('Resources')));
          const priv = cloneResources(ctx, res instanceof PDFDict ? res : resources);
          const inner = await processOps(env, parseContent(decodeStream(obj)), priv, formCtm, depth + 1);
          if (inner.changed && resources) {
            const dict = obj.dict.clone(ctx);
            for (const k of ['Filter', 'DecodeParms', 'Length']) dict.delete(N(k));
            if (priv) dict.set(N('Resources'), priv);
            const nn = env.newName();
            const fresh = ctx.flateStream(serializeContent(inner.ops), Object.fromEntries([...dict.entries()].map(([k, v]) => [k.decodeText(), v])) as never);
            addXObject(ctx, resources, nn, ctx.register(fresh));
            out.push({ op: 'Do', operands: [{ name: nn }] });
            replacedNames.add(name);
            env.report.formXObjectsRewritten++;
            changed = true;
          } else out.push(op);
        } else out.push(op);
        break;
      }
      case 'BI': {
        flushPath();
        const unit = boxOfPoints([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)]);
        if (env.boxes.some((b) => intersects(unit, b))) {
          env.report.inlineImagesRemoved++;
          changed = true;
        } else out.push(op);
        break;
      }
      default:
        flushPath();
        out.push(op);
    }
  }
  flushPath();
  // Drop the original (unredacted) XObjects from this private resource map unless they are still drawn.
  if (replacedNames.size && resources) {
    const stillUsed = new Set(out.filter((o) => o.op === 'Do').map((o) => (o.operands[0] && typeof o.operands[0] === 'object' && 'name' in o.operands[0] ? o.operands[0].name : '')));
    const xo = ctx.lookup(resources.get(N('XObject')));
    if (xo instanceof PDFDict) for (const n of replacedNames) if (!stillUsed.has(n)) xo.delete(N(n));
  }
  return { ops: out, changed };
}

// ------------------------------------------------------------------ public API

/**
 * Permanently remove content under the given areas: text glyphs (also invisible OCR text), image pixels,
 * small vector shapes, and overlapping annotations/form widgets; then paint a covering box.
 * Page content streams are rewritten and everything left unreferenced is discarded, so the removed
 * content does not survive anywhere in the saved file.
 */
export async function redactPdf(bytes: Uint8Array, marks: readonly RedactionMark[], opts: RedactOptions = {}): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const report: RedactReport = { pages: 0, glyphsRemoved: 0, imagesRedacted: 0, imagesRemoved: 0, inlineImagesRemoved: 0, pathsRemoved: 0, annotationsRemoved: 0, formXObjectsRewritten: 0 };
  const fonts = new FontLoader(ctx);
  let counter = 0;
  const [or, og, ob] = hexToRgb(opts.overlayColor ?? '#000000');

  const byPage = new Map<number, Rect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), ...m.rects]);

  for (const [index, rects] of byPage) {
    const page = pages[index];
    if (!page || !rects.length) continue;
    const g = pageGeometry(page);
    const boxes: Box[] = rects.map((r) => {
      const [x1, y1, x2, y2] = rectToUser(g, r);
      return { x1, y1, x2, y2 };
    });
    const env: Env = { ctx, boxes, fonts, opts: { removeVectors: true, ...opts }, report, newName: () => `Rdt${++counter}`, imageCache: new Map() };

    const resources = cloneResources(ctx, page.node.Resources());
    if (resources) page.node.set(N('Resources'), resources);
    const parsed = parseContent(pageContent(ctx, page.node.get(N('Contents'))));
    const { ops } = await processOps(env, parsed, resources, IDENTITY, 0);

    const cover = boxes.flatMap((b): Op[] => [
      { op: 'q', operands: [] },
      { op: 'rg', operands: [or, og, ob] },
      { op: 're', operands: [b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1] },
      { op: 'f', operands: [] },
      { op: 'Q', operands: [] },
    ]);
    const finalBytes = serializeContent([{ op: 'q', operands: [] }, ...ops, { op: 'Q', operands: [] }, ...cover]);
    page.node.set(N('Contents'), ctx.register(ctx.flateStream(finalBytes)));
    page.node.delete(N('Thumb')); // the old thumbnail shows the unredacted page

    if (opts.removeAnnotations !== false) {
      const annots = page.node.Annots();
      if (annots) for (let i = annots.size() - 1; i >= 0; i--) {
        const d = ctx.lookup(annots.get(i));
        if (!(d instanceof PDFDict)) continue;
        const rect = ctx.lookup(d.get(N('Rect')));
        if (!(rect instanceof PDFArray) || rect.size() < 4) continue;
        const v = [0, 1, 2, 3].map((k) => (ctx.lookup(rect.get(k)) as PDFNumber).asNumber());
        const ab: Box = { x1: Math.min(v[0]!, v[2]!), y1: Math.min(v[1]!, v[3]!), x2: Math.max(v[0]!, v[2]!), y2: Math.max(v[1]!, v[3]!) };
        if (!boxes.some((b) => intersects(ab, b))) continue;
        // A form widget keeps its value in the field dictionary: clear it too.
        let field: PDFDict | undefined = d;
        for (let depth = 0; field && depth < 16; depth++) {
          if (field.get(N('V')) || field.get(N('DV'))) {
            field.delete(N('V'));
            field.delete(N('DV'));
          }
          const parent: PDFObject | undefined = ctx.lookup(field.get(N('Parent')));
          field = parent instanceof PDFDict ? parent : undefined;
        }
        d.delete(N('AP'));
        const raw = annots.get(i);
        if (raw instanceof PDFRef) removeFromAcroForm(doc, raw);
        annots.remove(i);
        report.annotationsRemoved++;
      }
    }
    report.pages++;
  }

  pruneUnreferenced(doc);
  return { bytes: await doc.save({ useObjectStreams: false }), report };
}

export { PDFHexString, PDFString, isName };

/** Detach a (removed) widget/field from the AcroForm field tree so its dictionary can be discarded. */
function removeFromAcroForm(doc: Awaited<ReturnType<typeof loadDoc>>, widget: PDFRef) {
  const ctx = doc.context;
  const acro = ctx.lookup(doc.catalog.get(N('AcroForm')));
  if (!(acro instanceof PDFDict)) return;
  const same = (a: PDFObject | undefined) => a instanceof PDFRef && a.objectNumber === widget.objectNumber && a.generationNumber === widget.generationNumber;
  const walk = (list: PDFArray | undefined, depth: number) => {
    if (!list || depth > 32) return;
    for (let i = list.size() - 1; i >= 0; i--) {
      const item = list.get(i);
      if (same(item)) {
        list.remove(i);
        continue;
      }
      const d = ctx.lookup(item);
      if (d instanceof PDFDict) {
        const kids = ctx.lookup(d.get(N('Kids')));
        if (kids instanceof PDFArray) walk(kids, depth + 1);
      }
    }
  };
  const fields = ctx.lookup(acro.get(N('Fields')));
  if (fields instanceof PDFArray) walk(fields, 0);
}
