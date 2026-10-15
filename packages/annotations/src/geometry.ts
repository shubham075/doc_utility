import type { Annotation, Point, Rect } from './model';
import { NOTE_SIZE } from './model';

/** Page box facts needed to map between display space and PDF user space. */
export interface PageGeometry {
  /** Crop box (or media box) origin and *unrotated* size, in user space. */
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  /** /Rotate, normalised to 0 | 90 | 180 | 270. */
  rotation: 0 | 90 | 180 | 270;
}

export const normaliseRotation = (deg: number): PageGeometry['rotation'] =>
  ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as PageGeometry['rotation'];

/** Display size of the page (after rotation). */
export function displaySize(g: PageGeometry) {
  return g.rotation === 90 || g.rotation === 270
    ? { width: g.cropH, height: g.cropW }
    : { width: g.cropW, height: g.cropH };
}

/** Display space (top-left origin, rotated) -> PDF user space. */
export function toUser(g: PageGeometry, p: Point): Point {
  const { cropW: w, cropH: h } = g;
  let x: number;
  let y: number;
  switch (g.rotation) {
    case 0:
      x = p.x;
      y = h - p.y;
      break;
    case 90:
      x = p.y;
      y = p.x;
      break;
    case 180:
      x = w - p.x;
      y = p.y;
      break;
    case 270:
      x = w - p.y;
      y = h - p.x;
      break;
  }
  return { x: x + g.cropX, y: y + g.cropY };
}

/** PDF user space -> display space. Inverse of toUser. */
export function fromUser(g: PageGeometry, u: Point): Point {
  const x = u.x - g.cropX;
  const y = u.y - g.cropY;
  const { cropW: w, cropH: h } = g;
  switch (g.rotation) {
    case 0:
      return { x, y: h - y };
    case 90:
      return { x: y, y: x };
    case 180:
      return { x: w - x, y };
    case 270:
      return { x: h - y, y: w - x };
  }
}

/** Axis-aligned bounds of a display-space rect expressed in user space, as [x1,y1,x2,y2] (x1<x2, y1<y2). */
export function rectToUser(g: PageGeometry, r: Rect): [number, number, number, number] {
  const a = toUser(g, { x: r.x, y: r.y });
  const b = toUser(g, { x: r.x + r.width, y: r.y + r.height });
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

export function rectFromUser(g: PageGeometry, box: [number, number, number, number]): Rect {
  const a = fromUser(g, { x: box[0], y: box[1] });
  const b = fromUser(g, { x: box[2], y: box[3] });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function unionRects(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Bounding box in display space (used for selection outlines, hit-testing, sorting). */
export function annotationBounds(a: Annotation): Rect {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return unionRects(a.quads);
    case 'note':
      return { x: a.x, y: a.y, width: NOTE_SIZE, height: NOTE_SIZE };
    case 'freetext':
    case 'square':
    case 'circle':
    case 'stamp':
      return a.rect;
    case 'ink': {
      const pts = a.strokes.flat();
      const pad = a.width / 2;
      const r = unionRects(pts.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })));
      return { x: r.x - pad, y: r.y - pad, width: r.width + 2 * pad, height: r.height + 2 * pad };
    }
    case 'line': {
      const x = Math.min(a.p1.x, a.p2.x);
      const y = Math.min(a.p1.y, a.p2.y);
      const pad = a.width / 2;
      return { x: x - pad, y: y - pad, width: Math.abs(a.p2.x - a.p1.x) + 2 * pad, height: Math.abs(a.p2.y - a.p1.y) + 2 * pad };
    }
    case 'reply':
      return { x: 0, y: 0, width: 0, height: 0 };
  }
}

/** Whether the annotation's geometry can be dragged in the viewer (text markup is anchored to text). */
export const isMovable = (a: Annotation) => !['highlight', 'underline', 'strikeout', 'squiggly', 'reply'].includes(a.type);

/** Move an annotation by (dx, dy) in display space. Returns a patch. */
export function translate(a: Annotation, dx: number, dy: number): Partial<Annotation> {
  const mv = (r: Rect): Rect => ({ ...r, x: r.x + dx, y: r.y + dy });
  const mp = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  switch (a.type) {
    case 'note':
      return { x: a.x + dx, y: a.y + dy };
    case 'freetext':
    case 'square':
    case 'circle':
    case 'stamp':
      return { rect: mv(a.rect) };
    case 'ink':
      return { strokes: a.strokes.map((s) => s.map(mp)) };
    case 'line':
      return { p1: mp(a.p1), p2: mp(a.p2) };
    default:
      return {};
  }
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Resize a rect by dragging one of its handles to `p`. Keeps a minimum size and normalises flips. */
export function resizeRect(r: Rect, handle: Handle, p: Point, min = 6): Rect {
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.width;
  let y1 = r.y + r.height;
  if (handle.includes('w')) x0 = Math.min(p.x, x1 - min);
  if (handle.includes('e')) x1 = Math.max(p.x, x0 + min);
  if (handle.includes('n')) y0 = Math.min(p.y, y1 - min);
  if (handle.includes('s')) y1 = Math.max(p.y, y0 + min);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Merge per-span client rects of one selection into one rect per visual line. */
export function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = rects
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    const sameLine =
      last && Math.abs(last.y + last.height / 2 - (r.y + r.height / 2)) < Math.min(last.height, r.height) * 0.5;
    if (last && sameLine && r.x <= last.x + last.width + Math.max(2, last.height * 0.4)) {
      const x1 = Math.max(last.x + last.width, r.x + r.width);
      const y0 = Math.min(last.y, r.y);
      const y1 = Math.max(last.y + last.height, r.y + r.height);
      last.x = Math.min(last.x, r.x);
      last.width = x1 - last.x;
      last.y = y0;
      last.height = y1 - y0;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
