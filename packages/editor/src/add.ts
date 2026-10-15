import { StandardFonts, type PDFFont } from 'pdf-lib';
import { toUser, type PageGeometry, type Point, type Rect } from '@pdfsuite/annotations';
import type { Op } from '@pdfsuite/security/content';
import { openForEdit, type EditOptions } from './edit';
import type { RasterImage } from './images';
import { addResource, appendPageContent, hexToRgb, name, op, ownResources } from './util';
import { pageGeometry } from '@pdfsuite/annotations';

/** Frame of the displayed page in user space at display point p: the images of the display axes. */
function frame(g: PageGeometry, p: Point) {
  const o = toUser(g, p);
  const ex = toUser(g, { x: p.x + 1, y: p.y });
  const ey = toUser(g, { x: p.x, y: p.y + 1 });
  return { o, ex: { x: ex.x - o.x, y: ex.y - o.y }, ey: { x: ey.x - o.x, y: ey.y - o.y } };
}

export interface TextSpec {
  /** Top-left corner of the text in display space. */
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  family: 'Helvetica' | 'Times' | 'Courier';
  bold?: boolean;
  italic?: boolean;
}

const STANDARD: Record<TextSpec['family'], [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export interface AddResult {
  bytes: Uint8Array;
  /** Box of what was added, in display space. */
  bbox: Rect;
  warnings: string[];
}

/** Add text as real page content (not an annotation). Characters outside Latin-1 use the bundled fallback font. */
export async function addText(bytes: Uint8Array, pageIndex: number, spec: TextSpec, opts: EditOptions = {}): Promise<AddResult> {
  const doc = await openForEdit(bytes);
  const page = doc.getPages()[pageIndex];
  if (!page) throw new Error(`No page ${pageIndex + 1}`);
  const ctx = doc.context;
  const g = pageGeometry(page);
  const warnings: string[] = [];
  const lines = spec.text.split(/\r?\n/);

  const std = doc.embedStandardFont(STANDARD[spec.family][(spec.bold ? 1 : 0) + (spec.italic ? 2 : 0) === 3 ? 3 : spec.bold ? 1 : spec.italic ? 2 : 0]);
  let font: PDFFont = std;
  const supported = new Set(std.getCharacterSet());
  const unsupported = Array.from(spec.text).filter((c) => c !== '\n' && c !== '\r' && !supported.has(c.codePointAt(0)!));
  if (unsupported.length) {
    if (!opts.fallbackFont) throw new Error(`The font cannot show ${[...new Set(unsupported)].join(' ')}.`);
    font = await doc.embedFont(await opts.fallbackFont({ bold: !!spec.bold, italic: !!spec.italic }), { subset: true });
    const has = new Set(font.getCharacterSet());
    const lost = unsupported.filter((c) => !has.has(c.codePointAt(0)!));
    if (lost.length) warnings.push(`No font available for ${[...new Set(lost)].join(' ')}: shown as "?".`);
  }
  const resources = ownResources(ctx, page);
  const fontName = addResource(ctx, resources, 'Font', 'AddF', font.ref);
  const has = new Set(font.getCharacterSet());
  const clean = (s: string) => Array.from(s).map((c) => (has.has(c.codePointAt(0)!) ? c : '?')).join('');

  const [r, gr, b] = hexToRgb(spec.color);
  const lead = spec.size * 1.2;
  const ascent = spec.size * 0.8;
  const ops: Op[] = [op('rg', r, gr, b), op('BT'), op('Tf', name(fontName), spec.size)];
  let width = 0;
  lines.forEach((line, i) => {
    const text = clean(line);
    width = Math.max(width, font.widthOfTextAtSize(text, spec.size));
    const f = frame(g, { x: spec.x, y: spec.y + ascent + i * lead });
    ops.push(op('Tm', f.ex.x, f.ex.y, -f.ey.x, -f.ey.y, f.o.x, f.o.y), op('Tj', { str: font.encodeText(text).asBytes() }));
  });
  ops.push(op('ET'));
  appendPageContent(ctx, page, ops);
  return { bytes: await doc.save({ useObjectStreams: false }), bbox: { x: spec.x, y: spec.y, width, height: lead * lines.length }, warnings };
}

/** Place a picture on the page, stretched into `rect` (display space). */
export async function addImage(bytes: Uint8Array, pageIndex: number, rect: Rect, image: RasterImage): Promise<AddResult> {
  const doc = await openForEdit(bytes);
  const page = doc.getPages()[pageIndex];
  if (!page) throw new Error(`No page ${pageIndex + 1}`);
  const ctx = doc.context;
  const g = pageGeometry(page);
  const img = image.type === 'png' ? await doc.embedPng(image.data) : await doc.embedJpg(image.data);
  const resources = ownResources(ctx, page);
  const nn = addResource(ctx, resources, 'XObject', 'AddIm', img.ref);
  const f = frame(g, { x: rect.x, y: rect.y + rect.height });
  appendPageContent(ctx, page, [op('cm', rect.width * f.ex.x, rect.width * f.ex.y, -rect.height * f.ey.x, -rect.height * f.ey.y, f.o.x, f.o.y), op('Do', name(nn))]);
  return { bytes: await doc.save({ useObjectStreams: false }), bbox: rect, warnings: [] };
}

export interface ShapeSpec {
  kind: 'rect' | 'ellipse' | 'line' | 'arrow';
  /** rect/ellipse: the box; line/arrow: p1 = top-left, p2 = bottom-right of the box unless `from`/`to` are given. */
  rect: Rect;
  from?: Point;
  to?: Point;
  stroke: string | null;
  fill: string | null;
  width: number;
}

const KAPPA = 0.5522847498;

/** Draw a rectangle, ellipse, line or arrow as real page content. */
export async function addShape(bytes: Uint8Array, pageIndex: number, spec: ShapeSpec): Promise<AddResult> {
  const doc = await openForEdit(bytes);
  const page = doc.getPages()[pageIndex];
  if (!page) throw new Error(`No page ${pageIndex + 1}`);
  const g = pageGeometry(page);
  const u = (x: number, y: number): [number, number] => {
    const p = toUser(g, { x, y });
    return [p.x, p.y];
  };
  const { x, y, width: w, height: h } = spec.rect;
  const ops: Op[] = [];
  if (spec.stroke) ops.push(op('RG', ...hexToRgb(spec.stroke)), op('w', spec.width));
  if (spec.fill) ops.push(op('rg', ...hexToRgb(spec.fill)));
  if (spec.kind === 'rect') {
    ops.push(op('m', ...u(x, y)), op('l', ...u(x + w, y)), op('l', ...u(x + w, y + h)), op('l', ...u(x, y + h)), op('h'));
  } else if (spec.kind === 'ellipse') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    const kx = rx * KAPPA;
    const ky = ry * KAPPA;
    ops.push(
      op('m', ...u(cx + rx, cy)),
      op('c', ...u(cx + rx, cy + ky), ...u(cx + kx, cy + ry), ...u(cx, cy + ry)),
      op('c', ...u(cx - kx, cy + ry), ...u(cx - rx, cy + ky), ...u(cx - rx, cy)),
      op('c', ...u(cx - rx, cy - ky), ...u(cx - kx, cy - ry), ...u(cx, cy - ry)),
      op('c', ...u(cx + kx, cy - ry), ...u(cx + rx, cy - ky), ...u(cx + rx, cy)),
      op('h'),
    );
  } else {
    const a = spec.from ?? { x, y };
    const b = spec.to ?? { x: x + w, y: y + h };
    ops.push(op('J', 1), op('m', ...u(a.x, a.y)), op('l', ...u(b.x, b.y)));
    if (spec.kind === 'arrow') {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const len = Math.max(8, spec.width * 4);
      for (const s of [-1, 1]) {
        const t = ang + Math.PI + (s * 28 * Math.PI) / 180;
        ops.push(op('m', ...u(b.x, b.y)), op('l', ...u(b.x + len * Math.cos(t), b.y + len * Math.sin(t))));
      }
    }
  }
  const closed = spec.kind === 'rect' || spec.kind === 'ellipse';
  ops.push(op(closed ? (spec.fill && spec.stroke ? 'B' : spec.fill ? 'f' : 'S') : 'S'));
  appendPageContent(doc.context, page, ops);
  const pad = spec.width / 2;
  return { bytes: await doc.save({ useObjectStreams: false }), bbox: { x: x - pad, y: y - pad, width: w + spec.width, height: h + spec.width }, warnings: [] };
}
