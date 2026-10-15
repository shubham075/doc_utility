import type { PDFFont } from 'pdf-lib';
import { rectToUser, toUser, unionRects, type PageGeometry } from './geometry';
import type { Annotation, Point, Rect } from './model';
import { NOTE_SIZE } from './model';
import { colorOp, fmt } from './pdfutil';

/** Result of building an annotation's appearance stream. Content is in PDF user space (BBox == Rect, identity Matrix). */
export interface Appearance {
  /** [x1, y1, x2, y2] in user space: annotation /Rect and appearance /BBox. */
  rect: [number, number, number, number];
  content: string;
  blendMultiply: boolean;
  /** Fill/stroke alpha for the ExtGState (the annotation also gets /CA). */
  opacity: number;
  /** Stamp image; the content stream paints it as `/Im Do`. */
  image?: { dataUrl: string };
}

export const needsFont = (a: Annotation) => a.type === 'freetext';

const FONT_RES = 'Helv';
export const FONT_RESOURCE_NAME = FONT_RES;

const pad = (r: [number, number, number, number], p: number): [number, number, number, number] => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
/** Encode text for the standard font as a hex string operand; characters the font cannot encode become '?'. */
function encodeLine(font: PDFFont, line: string): string {
  const supported = new Set(font.getCharacterSet());
  const safe = Array.from(line, (ch) => (supported.has(ch.codePointAt(0)!) ? ch : '?')).join('');
  return font.encodeText(safe).toString();
}

/** Greedy word wrap using real font metrics; honours explicit newlines. */
export function wrapText(font: PDFFont, text: string, fontSize: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && font.widthOfTextAtSize(test.trimEnd(), fontSize) > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = test;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function buildAppearance(a: Annotation, g: PageGeometry, font?: PDFFont): Appearance {
  const U = (p: Point) => toUser(g, p);
  const pt = (x: number, y: number) => {
    const u = U({ x, y });
    return `${fmt(u.x)} ${fmt(u.y)}`;
  };
  const poly = (pts: Point[], close = false) =>
    pts.map((p, i) => `${pt(p.x, p.y)} ${i ? 'l' : 'm'}`).join('\n') + (close ? '\nh' : '');

  switch (a.type) {
    case 'highlight': {
      const rect = pad(rectToUser(g, unionRects(a.quads)), 0);
      const body = a.quads
        .map((q) => poly([{ x: q.x, y: q.y }, { x: q.x + q.width, y: q.y }, { x: q.x + q.width, y: q.y + q.height }, { x: q.x, y: q.y + q.height }], true) + '\nf')
        .join('\n');
      return { rect, content: `${colorOp(a.color)}\n${body}`, blendMultiply: true, opacity: a.opacity };
    }
    case 'underline':
    case 'strikeout': {
      const rect = pad(rectToUser(g, unionRects(a.quads)), 1);
      const w = 1;
      const body = a.quads
        .map((q) => {
          const y = a.type === 'underline' ? q.y + q.height - w : q.y + q.height * 0.55;
          return `${pt(q.x, y)} m ${pt(q.x + q.width, y)} l S`;
        })
        .join('\n');
      return { rect, content: `${colorOp(a.color, true)}\n${fmt(w)} w\n${body}`, blendMultiply: false, opacity: a.opacity };
    }
    case 'squiggly': {
      const rect = pad(rectToUser(g, unionRects(a.quads)), 2);
      const step = 2.5;
      const amp = 1.3;
      const body = a.quads
        .map((q) => {
          const base = q.y + q.height - amp - 0.5;
          const pts: Point[] = [];
          let up = false;
          for (let x = q.x; x < q.x + q.width + step; x += step) {
            pts.push({ x: Math.min(x, q.x + q.width), y: base + (up ? -amp : amp) });
            up = !up;
          }
          return poly(pts) + '\nS';
        })
        .join('\n');
      return { rect, content: `${colorOp(a.color, true)}\n0.8 w\n1 j 1 J\n${body}`, blendMultiply: false, opacity: a.opacity };
    }
    case 'redact': {
      const rect = pad(rectToUser(g, unionRects(a.quads)), 1);
      const body = a.quads
        .map((q) => {
          const pts = poly([{ x: q.x, y: q.y }, { x: q.x + q.width, y: q.y }, { x: q.x + q.width, y: q.y + q.height }, { x: q.x, y: q.y + q.height }], true);
          return pts + '\nS';
        })
        .join('\n');
      return { rect, content: `1 0 0 RG 1.2 w [3 2] 0 d\n${body}`, blendMultiply: false, opacity: 1 };
    }
    case 'note': {
      const r: Rect = { x: a.x, y: a.y, width: NOTE_SIZE, height: NOTE_SIZE };
      const rect = rectToUser(g, r);
      const box = poly([{ x: a.x + 0.5, y: a.y + 0.5 }, { x: a.x + NOTE_SIZE - 0.5, y: a.y + 0.5 }, { x: a.x + NOTE_SIZE - 0.5, y: a.y + NOTE_SIZE - 0.5 }, { x: a.x + 0.5, y: a.y + NOTE_SIZE - 0.5 }], true);
      const lines = [6, 10, 14]
        .map((dy) => `${pt(a.x + 4, a.y + dy)} m ${pt(a.x + NOTE_SIZE - 4, a.y + dy)} l S`)
        .join('\n');
      const content = `${colorOp(a.color)}\n${box}\nf\n0.45 0.35 0 RG 1 w\n${box}\nS\n${lines}`;
      return { rect, content, blendMultiply: false, opacity: a.opacity };
    }
    case 'freetext': {
      if (!font) throw new Error('free text needs a font');
      const rect = rectToUser(g, a.rect);
      const parts: string[] = [];
      const R = a.rect;
      const box = poly([{ x: R.x, y: R.y }, { x: R.x + R.width, y: R.y }, { x: R.x + R.width, y: R.y + R.height }, { x: R.x, y: R.y + R.height }], true);
      if (a.fill) parts.push(`${colorOp(a.fill)}\n${box}\nf`);
      if (a.borderWidth > 0) {
        const h = a.borderWidth / 2;
        const inset = poly([{ x: R.x + h, y: R.y + h }, { x: R.x + R.width - h, y: R.y + h }, { x: R.x + R.width - h, y: R.y + R.height - h }, { x: R.x + h, y: R.y + R.height - h }], true);
        parts.push(`${colorOp(a.color, true)}\n${fmt(a.borderWidth)} w\n${inset}\nS`);
      }
      const padding = 3 + a.borderWidth;
      const lines = wrapText(font, a.contents, a.fontSize, Math.max(1, R.width - 2 * padding));
      const lead = a.fontSize * 1.2;
      // Text is drawn upright on screen: rotate the text matrix against the page rotation.
      const th = (g.rotation * Math.PI) / 180;
      const [c, s] = [Math.cos(th), Math.sin(th)];
      const text = lines
        .map((ln, i) => {
          const base = U({ x: R.x + padding, y: R.y + padding + a.fontSize * 0.85 + i * lead });
          return `${fmt(c)} ${fmt(s)} ${fmt(-s)} ${fmt(c)} ${fmt(base.x)} ${fmt(base.y)} Tm ${encodeLine(font, ln)} Tj`;
        })
        .join('\n');
      const clip = `${pt(R.x, R.y)} m ${pt(R.x + R.width, R.y)} l ${pt(R.x + R.width, R.y + R.height)} l ${pt(R.x, R.y + R.height)} l h W n`;
      parts.push(`q\n${clip}\nBT\n/${FONT_RES} ${fmt(a.fontSize)} Tf\n${colorOp(a.color)}\n${text}\nET\nQ`);
      return { rect, content: parts.join('\n'), blendMultiply: false, opacity: a.opacity };
    }
    case 'ink': {
      const all = a.strokes.flat();
      const rect = pad(rectToUser(g, unionRects(all.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })))), a.width);
      const body = a.strokes
        .map((s) => {
          const pts = s.length === 1 ? [s[0]!, { x: s[0]!.x + 0.01, y: s[0]!.y }] : s;
          return poly(pts) + '\nS';
        })
        .join('\n');
      return { rect, content: `${colorOp(a.color, true)}\n${fmt(a.width)} w\n1 J 1 j\n${body}`, blendMultiply: false, opacity: a.opacity };
    }
    case 'square': {
      const rect = rectToUser(g, a.rect);
      const h = a.width / 2;
      const R = a.rect;
      const path = poly([{ x: R.x + h, y: R.y + h }, { x: R.x + R.width - h, y: R.y + h }, { x: R.x + R.width - h, y: R.y + R.height - h }, { x: R.x + h, y: R.y + R.height - h }], true);
      return { rect, content: shapeOps(a.color, a.fill, a.width, path), blendMultiply: false, opacity: a.opacity };
    }
    case 'circle': {
      const rect = rectToUser(g, a.rect);
      const h = a.width / 2;
      const R = a.rect;
      const cx = R.x + R.width / 2;
      const cy = R.y + R.height / 2;
      const rx = Math.max(0.1, R.width / 2 - h);
      const ry = Math.max(0.1, R.height / 2 - h);
      const k = 0.5522847498;
      const C = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => `${pt(x1, y1)} ${pt(x2, y2)} ${pt(x3, y3)} c`;
      const path = [
        `${pt(cx + rx, cy)} m`,
        C(cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
        C(cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
        C(cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
        C(cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
        'h',
      ].join('\n');
      return { rect, content: shapeOps(a.color, a.fill, a.width, path), blendMultiply: false, opacity: a.opacity };
    }
    case 'line': {
      const heads: Point[][] = [];
      const head = (tip: Point, from: Point) => {
        const len = Math.max(7, a.width * 4);
        const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
        const spread = (28 * Math.PI) / 180;
        return [
          tip,
          { x: tip.x - len * Math.cos(ang - spread), y: tip.y - len * Math.sin(ang - spread) },
          { x: tip.x - len * Math.cos(ang + spread), y: tip.y - len * Math.sin(ang + spread) },
        ];
      };
      if (a.endStyle === 'arrow') heads.push(head(a.p2, a.p1));
      if (a.startStyle === 'arrow') heads.push(head(a.p1, a.p2));
      const pts = [a.p1, a.p2, ...heads.flat()];
      const rect = pad(rectToUser(g, unionRects(pts.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })))), a.width);
      const arrows = heads.map((h) => poly(h, true) + '\nf').join('\n');
      const content = `${colorOp(a.color, true)}\n${colorOp(a.color)}\n${fmt(a.width)} w\n1 J 1 j\n${pt(a.p1.x, a.p1.y)} m ${pt(a.p2.x, a.p2.y)} l S\n${arrows}`;
      return { rect, content, blendMultiply: false, opacity: a.opacity };
    }
    case 'stamp': {
      const R = a.rect;
      // Affine map from the unit image square (v up) to the display rect, expressed in user space.
      const o = U({ x: R.x, y: R.y + R.height });
      const ux = U({ x: R.x + R.width, y: R.y + R.height });
      const vy = U({ x: R.x, y: R.y });
      const m = [ux.x - o.x, ux.y - o.y, vy.x - o.x, vy.y - o.y, o.x, o.y].map(fmt).join(' ');
      return { rect: rectToUser(g, R), content: `q ${m} cm /Im Do Q`, blendMultiply: false, opacity: a.opacity, image: { dataUrl: a.dataUrl } };
    }
    case 'reply':
      throw new Error('replies have no appearance');
  }
}

function shapeOps(color: string, fill: string | null, width: number, path: string): string {
  const stroke = `${colorOp(color, true)}\n${fmt(width)} w`;
  if (fill) return `${colorOp(fill)}\n${stroke}\n${path}\nB`;
  return `${stroke}\n${path}\nS`;
}
