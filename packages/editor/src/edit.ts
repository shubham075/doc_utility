import fontkit from '@pdf-lib/fontkit';
import type { PDFDocument } from 'pdf-lib';
import { loadDoc, rectToUser, type PageGeometry, type Rect } from '@pdfsuite/annotations';
import { invert, mmul, type Matrix, type Op } from '@pdfsuite/security/content';
import { scanPage, type ObjectInternal, type ScanResult, type TextInternal } from './scan';
import { addResource, name, op, ownResources, writePageContent } from './util';

export interface EditOptions {
  /** Font file used for characters the original font cannot show (Latin/Greek/Cyrillic coverage is enough for most text). */
  fallbackFont?: (style: { bold: boolean; italic: boolean }) => Promise<Uint8Array>;
}

export async function openForEdit(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await loadDoc(bytes);
  doc.registerFontkit(fontkit);
  return doc;
}

export async function commit(doc: PDFDocument, scan: ScanResult, ops: Op[]): Promise<Uint8Array> {
  writePageContent(scan.ctx, scan.page, ops);
  return doc.save({ useObjectStreams: false });
}

function pick(scan: ScanResult, id: string): ObjectInternal {
  const i = scan.internal.get(id);
  if (!i) throw new Error('That object is no longer on the page.');
  return i;
}

/** Matrix (page space) that maps the old display box onto the new one. */
function boxTransform(g: PageGeometry, from: Rect, to: Rect): Matrix {
  const [ox1, oy1, ox2, oy2] = rectToUser(g, from);
  const [nx1, ny1, nx2, ny2] = rectToUser(g, to);
  const sx = ox2 - ox1 > 1e-6 ? (nx2 - nx1) / (ox2 - ox1) : 1;
  const sy = oy2 - oy1 > 1e-6 ? (ny2 - ny1) / (oy2 - oy1) : 1;
  return [sx, 0, 0, sy, nx1 - sx * ox1, ny1 - sy * oy1];
}

/** The same transform expressed in the coordinate system that is current at the object (after its `cm` operators). */
function localTransform(page: Matrix, ctm: Matrix): Matrix | null {
  const inv = invert(ctm);
  return inv ? mmul(mmul(ctm, page), inv) : null;
}

const advanceShift = (int: TextInternal, extra = 0) => {
  const k = int.ts.size * int.ts.th;
  return k ? [(-(int.advance + extra) * 1000) / k] : [];
};

// ------------------------------------------------------------------ move / resize / delete

export interface BoxChange {
  id: string;
  /** New bounding box in display space. Text can only be moved: its size is kept. */
  bbox: Rect;
}

export async function moveResizeObjects(bytes: Uint8Array, pageIndex: number, changes: readonly BoxChange[]): Promise<Uint8Array> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const byId = new Map(scan.objects.map((o) => [o.id, o]));
  const work = changes
    .map((c) => ({ c, o: byId.get(c.id), int: scan.internal.get(c.id) }))
    .filter((w): w is { c: BoxChange; o: NonNullable<typeof w.o>; int: ObjectInternal } => !!w.o && !!w.int)
    .sort((a, b) => b.int.start - a.int.start); // from the end, so earlier indices stay valid
  if (!work.length) throw new Error('Nothing to move.');
  const ops = scan.ops.slice();

  for (const { c, o, int } of work) {
    const target: Rect = o.kind === 'text' ? { x: c.bbox.x, y: c.bbox.y, width: o.bbox.width, height: o.bbox.height } : c.bbox;
    if (target.width < 0.5 || target.height < 0.5) continue;
    const local = localTransform(boxTransform(scan.geometry, o.bbox, target), int.ctm);
    if (!local) continue;
    if (o.kind === 'text' && int.text) {
      const t = int.text;
      const inv = invert(t.tlm);
      const offset = inv ? mmul(t.tmBefore, inv)[4] : 0;
      const keep = t.pre.filter((p) => p.op !== 'T*');
      ops.splice(int.start, 1, ...keep, op('ET'), op('q'), op('cm', ...local), op('BT'), op('Tm', ...t.tmBefore), t.show, op('ET'), op('Q'), op('BT'), op('Tm', ...t.tlm), op('TJ', [...advanceShift(t, offset)]));
    } else {
      ops.splice(int.start, int.end - int.start, op('q'), op('cm', ...local), ...ops.slice(int.start, int.end), op('Q'));
    }
  }
  return commit(doc, scan, ops);
}

export async function deleteObjects(bytes: Uint8Array, pageIndex: number, ids: readonly string[]): Promise<Uint8Array> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const work = ids.map((id) => ({ id, int: pick(scan, id) })).sort((a, b) => b.int.start - a.int.start);
  const ops = scan.ops.slice();
  for (const { int } of work) {
    if (int.text) {
      const t = int.text;
      // keep the position of whatever follows on the same line
      ops.splice(int.start, 1, ...t.pre, op('TJ', [...advanceShift(t)]));
    } else ops.splice(int.start, int.end - int.start);
  }
  return commit(doc, scan, ops);
}

// ------------------------------------------------------------------ text editing

export interface TextEditResult {
  bytes: Uint8Array;
  warnings: string[];
  /** Part of the new text is set in the bundled fallback font. */
  usedFallback: boolean;
  /** Width of the run before/after, in points. */
  width: { before: number; after: number };
}

export async function editText(bytes: Uint8Array, pageIndex: number, id: string, newText: string, opts: EditOptions = {}): Promise<TextEditResult> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const int = pick(scan, id);
  const t = int.text;
  const obj = scan.objects.find((o) => o.id === id);
  if (!t || !obj) throw new Error('That is not a text object.');
  if (!t.ts.fontDict) throw new Error('The font of this text cannot be found, so it cannot be edited.');
  if (!obj.editable) throw new Error('This text uses an encoding that cannot be edited safely.');
  const codec = await scan.codec(t.ts.fontDict);
  const warnings: string[] = [];

  type Seg = { fb: boolean; codes: number[]; text: string };
  const segs: Seg[] = [];
  const push = (fb: boolean, code: number | undefined, ch: string) => {
    const last = segs[segs.length - 1];
    if (last && last.fb === fb) {
      if (code !== undefined) last.codes.push(code);
      last.text += ch;
    } else segs.push({ fb, codes: code !== undefined ? [code] : [], text: ch });
  };
  const text = newText.replace(/[\r\n\t]+/g, ' ');
  if (text !== newText) warnings.push('Line breaks were replaced by spaces: only single lines can be edited.');
  const missing = new Set<string>();
  for (const ch of Array.from(text)) {
    const code = codec.encode(ch) ?? (ch === ' ' ? codec.encode(' ') : undefined);
    if (code !== undefined) push(false, code, ch);
    else {
      push(true, undefined, ch);
      missing.add(ch);
    }
  }

  let fb: { ref: import('pdf-lib').PDFRef; encode(s: string): Uint8Array; width(s: string): number; has(cp: number): boolean } | null = null;
  let fbName = '';
  if (segs.some((s) => s.fb)) {
    if (!opts.fallbackFont) throw new Error(`The font cannot show ${[...missing].map((c) => `"${c}"`).join(' ')} and no fallback font is available.`);
    const font = await doc.embedFont(await opts.fallbackFont({ bold: codec.bold, italic: codec.italic }), { subset: true });
    const set = new Set(font.getCharacterSet());
    fb = { ref: font.ref, encode: (s) => font.encodeText(s).asBytes(), width: (s) => font.widthOfTextAtSize(s, 1000), has: (cp) => set.has(cp) };
    fbName = addResource(scan.ctx, ownResources(scan.ctx, scan.page), 'Font', 'FbEdit', fb.ref);
    for (const s of segs) {
      if (!s.fb) continue;
      let out = '';
      for (const ch of Array.from(s.text)) {
        if (fb.has(ch.codePointAt(0)!)) out += ch;
        else {
          out += '?';
          warnings.push(`No font available for "${ch}": replaced by "?".`);
        }
      }
      s.text = out;
    }
    warnings.push(`Characters ${[...missing].map((c) => `"${c}"`).join(' ')} are not in the original font; a substitute font is used for them.`);
  } else if (segs.length === 0) {
    segs.push({ fb: false, codes: [], text: '' });
  }

  // new operators
  const ops = scan.ops.slice();
  const emit: Op[] = [...t.pre];
  let width = 0;
  const toBytes = (codes: number[]) => Uint8Array.from(codes.flatMap((c) => (codec.bytesPerCode === 2 ? [c >> 8, c & 255] : [c])));
  const scale = (t.ts.size * t.ts.th) / 1000;
  for (const s of segs) {
    if (s.fb && fb) {
      emit.push(op('Tf', name(fbName), t.ts.size), op('Tj', { str: fb.encode(s.text) }));
      width += fb.width(s.text) * scale + [...s.text].length * t.ts.tc * t.ts.th;
      emit.push(op('Tf', name(t.ts.fontName), t.ts.size));
    } else if (s.codes.length) {
      emit.push(op('Tj', { str: toBytes(s.codes) }));
      for (const c of s.codes) width += (codec.info.width(c) * scale) + (t.ts.tc + (codec.bytesPerCode === 1 && c === 32 ? t.ts.tw : 0)) * t.ts.th;
    }
  }
  if (emit.length === t.pre.length) emit.push(op('TJ', [])); // empty string: keep the instruction slot
  ops.splice(int.start, 1, ...emit);
  const out = await commit(doc, scan, ops);
  return { bytes: out, warnings: [...new Set(warnings)], usedFallback: !!fb, width: { before: t.advance, after: width } };
}
