import { memo, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { LinkInfo, PageObject } from '@pdfsuite/editor';
import { resizeRect, type Handle, type Point, type Rect } from '@pdfsuite/annotations';
import type { PdfDocument } from '@pdfsuite/engine';
import { SHAPE_MODES, type EditMode, type EditTools, type PlaceImage, type ShapeStyle, type TextStyle } from './EditTypes';
import type { Size } from './layout';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const normRect = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) });
const area = (r: Rect) => r.width * r.height;

interface Props {
  page: number;
  size: Size;
  zoom: number;
  doc: PdfDocument;
  tools: EditTools;
  mode: EditMode;
  selection: string[];
  linkSel: number | null;
  textStyle: TextStyle;
  shapeStyle: ShapeStyle;
  place: PlaceImage | null;
  /** Object being cropped (mode 'crop'). */
  cropId: string | null;
  onSelect(ids: string[]): void;
  onLinkSelect(index: number | null): void;
  onLinkRect(rect: Rect): void;
  onCrop(rect: Rect): void;
  onNotice(msg: string): void;
  onModeDone(): void;
}

interface Drag {
  kind: 'move' | 'resize' | 'draw';
  start: Point;
  cur: Point;
  handle?: Handle;
  /** Boxes of the dragged objects when the drag began. */
  base?: Map<string, Rect>;
}

const KIND_LABEL: Record<string, string> = { text: 'Text', image: 'Image', 'inline-image': 'Image', form: 'Graphic', path: 'Shape' };

export const EditLayer = memo(function EditLayer(p: Props) {
  const { page, size, zoom, doc, tools, mode, selection, linkSel } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;
  const [objects, setObjects] = useState<PageObject[]>([]);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = useState<Point | null>(null);
  const [addText, setAddText] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([toolsRef.current.listObjects(page), toolsRef.current.listLinks(page)]).then(
      ([o, l]) => {
        if (!alive) return;
        setObjects(o);
        setLinks(l);
      },
      () => alive && (setObjects([]), setLinks([])),
    );
    return () => {
      alive = false;
    };
  }, [doc, page]);

  // leave the inline editors when the mode changes
  useEffect(() => {
    setEditing(null);
    setAdding(null);
  }, [mode]);

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = size.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  const setDragBoth = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const byId = new Map(objects.map((o) => [o.id, o]));
  const selected = selection.map((id) => byId.get(id)).filter((o): o is PageObject => !!o);
  const single = selected.length === 1 ? selected[0]! : null;

  /** Where an object is drawn right now (follows an active drag). */
  const shown = (o: PageObject): Rect => {
    if (!drag || !drag.base?.has(o.id)) return o.bbox;
    const b = drag.base.get(o.id)!;
    if (drag.kind === 'move') return { ...b, x: b.x + (drag.cur.x - drag.start.x), y: b.y + (drag.cur.y - drag.start.y) };
    if (drag.kind === 'resize' && drag.handle) return resizeRect(b, drag.handle, drag.cur, 6);
    return b;
  };

  // ---- pointer handling shared by moving, resizing and drawing
  const track = (e: RPointerEvent<Element>, drag0: Drag, finish: (d: Drag) => void) => {
    const el = svgRef.current!;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released pointer: dragging still works through the element's own events */
    }
    setDragBoth(drag0);
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (d) setDragBoth({ ...d, cur: toPage(ev) });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up as EventListener);
      el.removeEventListener('pointercancel', up as EventListener);
      const d = dragRef.current;
      setDragBoth(null);
      if (d && ev.type === 'pointerup') finish({ ...d, cur: toPage(ev) });
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up as EventListener);
    el.addEventListener('pointercancel', up as EventListener);
  };

  const failure = (e: unknown) => p.onNotice(e instanceof Error ? e.message : String(e));

  const startMove = (o: PageObject, e: RPointerEvent<Element>) => {
    if (e.button !== 0 || mode !== 'select') return;
    e.stopPropagation();
    let ids = selection;
    if (e.shiftKey) ids = selection.includes(o.id) ? selection.filter((i) => i !== o.id) : [...selection, o.id];
    else if (!selection.includes(o.id)) ids = [o.id];
    p.onSelect(ids);
    p.onLinkSelect(null);
    if (!ids.includes(o.id) || tools.busy) return;
    const base = new Map(ids.map((id) => [id, byId.get(id)!.bbox] as const));
    const start = toPage(e);
    track(e, { kind: 'move', start, cur: start, base }, (d) => {
      const dx = d.cur.x - d.start.x;
      const dy = d.cur.y - d.start.y;
      if (Math.hypot(dx, dy) < 2) return;
      void tools.onMove(page, ids.map((id) => ({ id, bbox: { ...base.get(id)!, x: base.get(id)!.x + dx, y: base.get(id)!.y + dy } }))).catch(failure);
    });
  };

  const startResize = (h: Handle, e: RPointerEvent<Element>) => {
    if (!single || tools.busy) return;
    e.stopPropagation();
    const start = toPage(e);
    track(e, { kind: 'resize', start, cur: start, handle: h, base: new Map([[single.id, single.bbox]]) }, (d) => {
      void tools.onMove(page, [{ id: single.id, bbox: resizeRect(single.bbox, h, d.cur, 6) }]).catch(failure);
    });
  };

  const onCapDown = (e: RPointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    const pt = toPage(e);
    if (mode === 'select') {
      p.onSelect([]);
      p.onLinkSelect(null);
      return;
    }
    if (mode === 'text') {
      setAdding(pt);
      setAddText('');
      return;
    }
    if (mode === 'image') {
      if (!p.place || tools.busy) return;
      const w = Math.min(200, size.width * 0.5);
      const rect = { x: pt.x, y: pt.y, width: w, height: w / p.place.aspect };
      void tools.onAddImage(page, rect, p.place.file).then(p.onModeDone, failure);
      return;
    }
    if (SHAPE_MODES.includes(mode) || mode === 'link' || mode === 'crop') track(e, { kind: 'draw', start: pt, cur: pt }, (d) => finishDraw(d));
  };

  const finishDraw = (d: Drag) => {
    const r = normRect(d.start, d.cur);
    if (mode === 'link') {
      if (r.width >= 4 && r.height >= 4) p.onLinkRect(r);
      return;
    }
    if (mode === 'crop') {
      if (r.width >= 4 && r.height >= 4) p.onCrop(r);
      return;
    }
    if (Math.hypot(r.width, r.height) < 4) return;
    const s = p.shapeStyle;
    const kind = mode as 'rect' | 'ellipse' | 'line' | 'arrow';
    void tools
      .onAddShape(page, { kind, rect: r, from: d.start, to: d.cur, stroke: s.stroke, fill: kind === 'rect' || kind === 'ellipse' ? s.fill : null, width: s.width })
      .then(p.onModeDone, failure);
  };

  const commitEdit = async () => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    const o = byId.get(ed.id);
    if (!o || ed.text === o.text) return;
    try {
      const warnings = await tools.onEditText(page, ed.id, ed.text);
      if (warnings.length) p.onNotice(warnings.join(' '));
    } catch (e) {
      failure(e);
    }
  };
  const commitAdd = async () => {
    const at = adding;
    const text = addText;
    setAdding(null);
    if (!at || !text.trim()) return;
    const s = p.textStyle;
    try {
      const warnings = await tools.onAddText(page, { x: at.x, y: at.y, text, size: s.size, color: s.color, family: s.family, bold: s.bold, italic: s.italic });
      if (warnings.length) p.onNotice(warnings.join(' '));
      p.onModeDone();
    } catch (e) {
      failure(e);
    }
  };

  const capturing = mode !== 'select' || true; // the capture surface also clears the selection in select mode
  const ordered = [...objects].sort((a, b) => area(b.bbox) - area(a.bbox));
  const draft = drag?.kind === 'draw' ? normRect(drag.start, drag.cur) : null;
  const sh = p.shapeStyle;

  return (
    <svg ref={svgRef} className={`pv-ann pv-edit pv-edit-${mode}`} viewBox={`0 0 ${size.width} ${size.height}`}>
      {capturing && <rect className="pv-edit-capture" width={size.width} height={size.height} fill="transparent" onPointerDown={onCapDown} style={{ cursor: mode === 'select' ? 'default' : 'crosshair' }} />}

      {links.map((l) => (
        <rect
          key={`l${l.index}`}
          className={`pv-edit-link${linkSel === l.index ? ' pv-edit-link-sel' : ''}`}
          x={l.rect.x}
          y={l.rect.y}
          width={l.rect.width}
          height={l.rect.height}
          style={{ pointerEvents: mode === 'select' ? 'all' : 'none' }}
          onPointerDown={(e) => {
            if (mode !== 'select') return;
            e.stopPropagation();
            p.onSelect([]);
            p.onLinkSelect(l.index);
          }}
        >
          <title>{l.kind === 'uri' ? l.uri : l.kind === 'page' ? `Go to page ${(l.page ?? 0) + 1}` : 'Link'}</title>
        </rect>
      ))}

      {mode === 'select' &&
        ordered.map((o) => {
          const b = shown(o);
          const sel = selection.includes(o.id);
          return (
            <rect
              key={o.id}
              data-object={o.id}
              className={`pv-eo pv-eo-${o.kind}${sel ? ' pv-eo-sel' : ''}`}
              x={b.x}
              y={b.y}
              width={Math.max(b.width, 2)}
              height={Math.max(b.height, 2)}
              onPointerDown={(e) => startMove(o, e)}
              onDoubleClick={() => o.kind === 'text' && !tools.busy && setEditing({ id: o.id, text: o.text ?? '' })}
            >
              <title>{o.kind === 'text' ? o.text : KIND_LABEL[o.kind]}</title>
            </rect>
          );
        })}

      {mode === 'select' && single && !editing && single.kind !== 'text' && !drag &&
        HANDLES.map((h) => {
          const b = single.bbox;
          const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.width : b.x + b.width / 2;
          const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.height : b.y + b.height / 2;
          const s = 8 / zoom;
          return <rect key={h} className="pv-eo-handle" x={x - s / 2} y={y - s / 2} width={s} height={s} style={{ cursor: `${h}-resize` }} onPointerDown={(e) => startResize(h, e)} />;
        })}

      {draft && mode === 'rect' && <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} fill={sh.fill ?? 'none'} stroke={sh.stroke} strokeWidth={sh.width} strokeDasharray="4 3" />}
      {draft && mode === 'ellipse' && <ellipse cx={draft.x + draft.width / 2} cy={draft.y + draft.height / 2} rx={draft.width / 2} ry={draft.height / 2} fill={sh.fill ?? 'none'} stroke={sh.stroke} strokeWidth={sh.width} strokeDasharray="4 3" />}
      {drag?.kind === 'draw' && (mode === 'line' || mode === 'arrow') && <line x1={drag.start.x} y1={drag.start.y} x2={drag.cur.x} y2={drag.cur.y} stroke={sh.stroke} strokeWidth={sh.width} strokeDasharray="4 3" />}
      {draft && (mode === 'link' || mode === 'crop') && <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} fill="rgba(26,115,232,.15)" stroke="#1a73e8" strokeDasharray="4 3" />}

      {editing && (() => {
        const o = byId.get(editing.id);
        if (!o) return null;
        return (
          <foreignObject x={o.bbox.x - 2} y={o.bbox.y - 2} width={Math.max(o.bbox.width + 40, 160)} height={o.bbox.height + 6}>
            <input
              className="pv-edit-input"
              autoFocus
              value={editing.text}
              style={{ fontSize: Math.max(8, o.fontSize ?? 12) }}
              aria-label="Edit text"
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') void commitEdit();
                else if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={() => void commitEdit()}
            />
          </foreignObject>
        );
      })()}
      {adding && (
        <foreignObject x={adding.x} y={adding.y} width={Math.max(220, size.width - adding.x - 8)} height={Math.max(60, p.textStyle.size * 3)}>
          <textarea
            className="pv-edit-input"
            autoFocus
            rows={2}
            value={addText}
            placeholder="Type, then press Enter"
            style={{ fontSize: p.textStyle.size, color: p.textStyle.color, fontWeight: p.textStyle.bold ? 700 : 400, fontStyle: p.textStyle.italic ? 'italic' : 'normal' }}
            aria-label="New text"
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void commitAdd();
              } else if (e.key === 'Escape') setAdding(null);
            }}
            onBlur={() => void commitAdd()}
          />
        </foreignObject>
      )}
    </svg>
  );
});
