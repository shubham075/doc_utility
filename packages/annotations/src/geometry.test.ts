import { describe, expect, it } from 'vitest';
import { displaySize, fromUser, mergeLineRects, rectFromUser, rectToUser, resizeRect, toUser, translate, type PageGeometry } from './geometry';
import type { InkAnnotation, NoteAnnotation } from './model';

const geo = (rotation: PageGeometry['rotation']): PageGeometry => ({ cropX: 10, cropY: 20, cropW: 200, cropH: 300, rotation });

describe('display <-> user space', () => {
  it('maps the display top-left corner for each rotation', () => {
    // Unrotated page: top-left of display is (cropX, cropY + cropH).
    expect(toUser(geo(0), { x: 0, y: 0 })).toEqual({ x: 10, y: 320 });
    // Rotated 90 cw: display top-left shows the unrotated bottom-left corner.
    expect(toUser(geo(90), { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    // 180: display top-left is unrotated bottom-right.
    expect(toUser(geo(180), { x: 0, y: 0 })).toEqual({ x: 210, y: 20 });
    // 270: display top-left is unrotated top-right.
    expect(toUser(geo(270), { x: 0, y: 0 })).toEqual({ x: 210, y: 320 });
  });

  it('round-trips points and rects for every rotation', () => {
    for (const r of [0, 90, 180, 270] as const) {
      const g = geo(r);
      const d = displaySize(g);
      const p = { x: d.width * 0.3, y: d.height * 0.7 };
      const back = fromUser(g, toUser(g, p));
      expect(back.x).toBeCloseTo(p.x);
      expect(back.y).toBeCloseTo(p.y);
      const rect = { x: 12, y: 30, width: 40, height: 15 };
      const rr = rectFromUser(g, rectToUser(g, rect));
      expect(rr.x).toBeCloseTo(rect.x);
      expect(rr.y).toBeCloseTo(rect.y);
      expect(rr.width).toBeCloseTo(rect.width);
      expect(rr.height).toBeCloseTo(rect.height);
    }
  });

  it('swaps display size for sideways pages', () => {
    expect(displaySize(geo(90))).toEqual({ width: 300, height: 200 });
    expect(displaySize(geo(0))).toEqual({ width: 200, height: 300 });
  });
});

describe('editing helpers', () => {
  it('resizes from a handle and keeps a minimum size', () => {
    const r = { x: 10, y: 10, width: 100, height: 50 };
    expect(resizeRect(r, 'se', { x: 160, y: 90 })).toEqual({ x: 10, y: 10, width: 150, height: 80 });
    expect(resizeRect(r, 'nw', { x: 200, y: 200 }, 6)).toEqual({ x: 104, y: 54, width: 6, height: 6 });
    expect(resizeRect(r, 'e', { x: 60, y: 999 })).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  it('merges client rects on the same line and keeps separate lines', () => {
    const merged = mergeLineRects([
      { x: 0, y: 0, width: 50, height: 10 },
      { x: 50.5, y: 0.5, width: 30, height: 10 },
      { x: 0, y: 20, width: 40, height: 10 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.width).toBeCloseTo(80.5);
  });

  it('translates notes and ink', () => {
    const note = { type: 'note', x: 5, y: 6 } as NoteAnnotation;
    expect(translate(note, 10, 20)).toEqual({ x: 15, y: 26 });
    const ink = { type: 'ink', strokes: [[{ x: 1, y: 1 }]] } as InkAnnotation;
    expect(translate(ink, 2, 3)).toEqual({ strokes: [[{ x: 3, y: 4 }]] });
  });
});
