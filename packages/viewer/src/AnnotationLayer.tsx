import { memo, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  NOTE_SIZE,
  STAMP_ID_PREFIX,
  annotationBounds,
  baseFields,
  isMovable,
  newId,
  resizeRect,
  translate,
  type Annotation,
  type AnnotationStore,
  type Handle,
  type Point,
  type Rect,
} from '@pdfsuite/annotations';
import { DRAW_TOOLS, type StampArm, type Tool, type ToolStyle } from './annotationTools';
import type { Size } from './layout';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

interface Props {
  page: number;
  size: Size;
  zoom: number;
  annotations: Annotation[];
  tool: Tool;
  style: ToolStyle;
  /** Signature/initials image to place when the 'stamp' tool is active. */
  stamp: StampArm | null;
  author: string;
  selectedId: string | null;
  editingId: string | null;
  store: AnnotationStore;
  onSelect(id: string | null): void;
  onEdit(id: string | null): void;
  onCreated(a: Annotation): void;
  onToolDone(): void;
}

interface Draft {
  tool: Tool;
  start: Point;
  cur: Point;
  points: Point[];
}

const normRect = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

export const AnnotationLayer = memo(function AnnotationLayer(p: Props) {
  const { page, size, zoom, annotations, tool, style, stamp, author, selectedId, editingId, store } = p;
  const svgRef = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  /** Live preview while moving/resizing the selected annotation. */
  const [override, setOverride] = useState<Annotation | null>(null);
  const drawing = DRAW_TOOLS.includes(tool);
  const selecting = tool === 'select';

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = size.width / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };

  const setDraftBoth = (d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  };

  // ---- creation (click / drag on the capture surface)
  const onCapDown = (e: RPointerEvent<SVGRectElement>) => {
    if (e.button !== 0 || !drawing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = toPage(e);
    if (tool === 'note') {
      const a: Annotation = { ...baseFields(page, author, style.color, 1), type: 'note', x: pt.x, y: pt.y };
      store.add(a);
      p.onCreated(a);
      p.onToolDone();
      return;
    }
    if (tool === 'date' || tool === 'check' || tool === 'cross' || tool === 'dot' || tool === 'hline' || tool === 'stamp') {
      const a = createMark(tool, pt, page, author, style, stamp);
      if (a) {
        store.add(a);
        p.onCreated(a);
        p.onToolDone();
      }
      return;
    }
    setDraftBoth({ tool, start: pt, cur: pt, points: [pt] });
  };

  const onCapMove = (e: RPointerEvent<SVGRectElement>) => {
    const d = draftRef.current;
    if (!d) return;
    const pt = toPage(e);
    const last = d.points[d.points.length - 1]!;
    const far = Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.8;
    setDraftBoth({ ...d, cur: pt, points: d.tool === 'ink' && far ? [...d.points, pt] : d.points });
  };

  const onCapUp = (e: RPointerEvent<SVGRectElement>) => {
    const d = draftRef.current;
    setDraftBoth(null);
    if (!d) return;
    const end = toPage(e);
    const b = baseFields(page, author, style.color, style.opacity);
    let a: Annotation | null = null;
    const r = normRect(d.start, end);
    switch (d.tool) {
      case 'ink': {
        const pts = d.points.length > 1 ? d.points : [d.start, { x: d.start.x + 0.1, y: d.start.y }];
        a = { ...b, type: 'ink', strokes: [pts], width: style.width };
        break;
      }
      case 'rect':
      case 'ellipse':
        if (r.width >= 3 && r.height >= 3) a = { ...b, type: d.tool === 'rect' ? 'square' : 'circle', rect: r, width: style.width, fill: null };
        break;
      case 'line':
      case 'arrow':
        if (Math.hypot(r.width, r.height) >= 3)
          a = { ...b, type: 'line', p1: d.start, p2: end, width: style.width, startStyle: 'none', endStyle: d.tool === 'arrow' ? 'arrow' : 'none' };
        break;
      case 'redactArea':
        if (r.width >= 3 && r.height >= 3) a = { ...b, type: 'redact', quads: [r], overlayColor: '#000000', color: '#ff0000', opacity: 1 };
        break;
      case 'textbox': {
        const rect = r.width >= 12 && r.height >= 12 ? r : { x: d.start.x, y: d.start.y, width: 170, height: 48 };
        a = { ...b, type: 'freetext', rect, fontSize: style.fontSize, fill: null, borderWidth: 0 };
        break;
      }
    }
    if (!a) return;
    store.add(a);
    p.onCreated(a);
    if (a.type === 'freetext') {
      p.onEdit(a.id);
      p.onToolDone();
    }
  };

  // ---- move / resize of the selected annotation
  const startMove = (a: Annotation, e: RPointerEvent<Element>) => {
    if (e.button !== 0) return;
    p.onSelect(a.id);
    if (!isMovable(a) || editingId === a.id) return;
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = toPage(e);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const pt = toPage(ev);
      const dx = pt.x - origin.x;
      const dy = pt.y - origin.y;
      if (!moved && Math.hypot(dx, dy) * zoom < 3) return;
      moved = true;
      setOverride({ ...a, ...translate(a, dx, dy) } as Annotation);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up as EventListener);
      el.removeEventListener('pointercancel', up as EventListener);
      setOverride(null);
      if (!moved) return;
      const pt = toPage(ev);
      store.update(a.id, translate(a, pt.x - origin.x, pt.y - origin.y));
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up as EventListener);
    el.addEventListener('pointercancel', up as EventListener);
  };

  const startHandleDrag = (a: Annotation, apply: (pt: Point) => Annotation, e: RPointerEvent<Element>) => {
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setOverride(apply(toPage(ev)));
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move as EventListener);
      el.removeEventListener('pointerup', up as EventListener);
      el.removeEventListener('pointercancel', up as EventListener);
      setOverride(null);
      const next = apply(toPage(ev));
      store.update(a.id, next as Partial<Annotation>);
    };
    el.addEventListener('pointermove', move as EventListener);
    el.addEventListener('pointerup', up as EventListener);
    el.addEventListener('pointercancel', up as EventListener);
  };

  // ---- rendering
  const view = (a: Annotation) => (override && override.id === a.id ? override : a);
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const sel = selected ? view(selected) : undefined;

  const resize = (h: Handle, e: RPointerEvent<Element>) => {
    if (!selected || !('rect' in selected)) return;
    const orig = selected.rect;
    startHandleDrag(selected, (pt) => ({ ...selected, rect: resizeRect(orig, h, pt) }) as Annotation, e);
  };
  const lineEnd = (which: 'p1' | 'p2', e: RPointerEvent<Element>) => {
    if (!selected || selected.type !== 'line') return;
    startHandleDrag(selected, (pt) => ({ ...selected, [which]: pt }) as Annotation, e);
  };

  return (
    <svg
      ref={svgRef}
      className={`pv-ann pv-ann-${tool}`}
      viewBox={`0 0 ${size.width} ${size.height}`}
    >
      {drawing && (
        <rect
          className="pv-ann-capture"
          width={size.width}
          height={size.height}
          fill="transparent"
          onPointerDown={onCapDown}
          onPointerMove={onCapMove}
          onPointerUp={onCapUp}
          onPointerCancel={() => setDraftBoth(null)}
        />
      )}
      {annotations.map((raw) => {
        const a = view(raw);
        return (
          <g
            key={a.id}
            data-annotation={a.id}
            className={a.id === selectedId ? 'pv-ann-item pv-ann-selected' : 'pv-ann-item'}
            style={{ pointerEvents: selecting ? 'auto' : 'none' }}
            onPointerDown={(e) => selecting && startMove(raw, e)}
            onDoubleClick={() => raw.type === 'freetext' && p.onEdit(raw.id)}
          >
            <Shape a={a} zoom={zoom} editing={editingId === a.id} store={store} onEdit={p.onEdit} />
          </g>
        );
      })}
      {draft && <Shape a={draftToAnnotation(draft, style)} zoom={zoom} editing={false} preview />}
      {sel && selecting && editingId !== sel.id && <Selection a={sel} zoom={zoom} onResize={resize} onLineEnd={lineEnd} />}
    </svg>
  );
});

function draftToAnnotation(d: Draft, s: ToolStyle): Annotation {
  const b = { ...baseFields(0, '', s.color, s.opacity), id: 'draft' };
  switch (d.tool) {
    case 'ink':
      return { ...b, type: 'ink', strokes: [d.points.length > 1 ? d.points : [d.start, { x: d.start.x + 0.1, y: d.start.y }]], width: s.width };
    case 'rect':
      return { ...b, type: 'square', rect: normRect(d.start, d.cur), width: s.width, fill: null };
    case 'ellipse':
      return { ...b, type: 'circle', rect: normRect(d.start, d.cur), width: s.width, fill: null };
    case 'textbox':
      return { ...b, type: 'square', rect: normRect(d.start, d.cur), width: 1, fill: null, color: '#2563eb' };
    case 'redactArea':
      return { ...b, type: 'redact', quads: [normRect(d.start, d.cur)], overlayColor: '#000000', color: '#ff0000' };
    default:
      return { ...b, type: 'line', p1: d.start, p2: d.cur, width: s.width, startStyle: 'none', endStyle: d.tool === 'arrow' ? 'arrow' : 'none' };
  }
}

// ---------------------------------------------------------------- shapes

function squigglyPoints(q: Rect): string {
  const step = 2.5;
  const amp = 1.3;
  const base = q.y + q.height - amp - 0.5;
  const pts: string[] = [];
  let up = false;
  for (let x = q.x; x < q.x + q.width + step; x += step) {
    pts.push(`${Math.min(x, q.x + q.width)},${base + (up ? -amp : amp)}`);
    up = !up;
  }
  return pts.join(' ');
}

function arrowHead(tip: Point, from: Point, width: number): string {
  const len = Math.max(7, width * 4);
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const spread = (28 * Math.PI) / 180;
  const a = { x: tip.x - len * Math.cos(ang - spread), y: tip.y - len * Math.sin(ang - spread) };
  const b = { x: tip.x - len * Math.cos(ang + spread), y: tip.y - len * Math.sin(ang + spread) };
  return `${tip.x},${tip.y} ${a.x},${a.y} ${b.x},${b.y}`;
}

function Shape({
  a,
  zoom,
  editing,
  store,
  onEdit,
  preview,
}: {
  a: Annotation;
  zoom: number;
  editing: boolean;
  store?: AnnotationStore;
  onEdit?: (id: string | null) => void;
  preview?: boolean;
}) {
  const hit = Math.max(10 / zoom, 6);
  const op = a.opacity;
  switch (a.type) {
    case 'highlight':
      return (
        <>
          {a.quads.map((q, i) => (
            <rect key={i} x={q.x} y={q.y} width={q.width} height={q.height} fill={a.color} fillOpacity={op} style={{ mixBlendMode: 'multiply' }} />
          ))}
        </>
      );
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return (
        <>
          {a.quads.map((q, i) => (
            <g key={i}>
              <rect x={q.x} y={q.y} width={q.width} height={q.height} fill="transparent" />
              {a.type === 'squiggly' ? (
                <polyline points={squigglyPoints(q)} fill="none" stroke={a.color} strokeOpacity={op} strokeWidth={0.8} strokeLinejoin="round" strokeLinecap="round" />
              ) : (
                <line
                  x1={q.x}
                  x2={q.x + q.width}
                  y1={a.type === 'underline' ? q.y + q.height - 1 : q.y + q.height * 0.55}
                  y2={a.type === 'underline' ? q.y + q.height - 1 : q.y + q.height * 0.55}
                  stroke={a.color}
                  strokeOpacity={op}
                  strokeWidth={1}
                />
              )}
            </g>
          ))}
        </>
      );
    case 'note':
      return (
        <g transform={`translate(${a.x} ${a.y})`}>
          <rect x={0.5} y={0.5} width={NOTE_SIZE - 1} height={NOTE_SIZE - 1} rx={2} fill={a.color} stroke="#735a00" strokeWidth={1} />
          {[6, 10, 14].map((dy) => (
            <line key={dy} x1={4} x2={NOTE_SIZE - 4} y1={dy} y2={dy} stroke="#735a00" strokeWidth={1} />
          ))}
        </g>
      );
    case 'freetext': {
      const r = a.rect;
      return (
        <foreignObject x={r.x} y={r.y} width={r.width} height={r.height}>
          {editing && store ? (
            <FreeTextEditor a={a} store={store} onDone={() => onEdit?.(null)} />
          ) : (
            <div
              className="pv-ft"
              style={{
                fontSize: a.fontSize,
                color: a.color,
                opacity: op,
                background: a.fill ?? 'transparent',
                border: a.borderWidth > 0 ? `${a.borderWidth}px solid ${a.color}` : undefined,
              }}
            >
              {a.contents}
            </div>
          )}
        </foreignObject>
      );
    }
    case 'ink':
      return (
        <>
          {a.strokes.map((s, i) => {
            const d = s.map((pt, k) => `${k ? 'L' : 'M'}${pt.x},${pt.y}`).join(' ');
            return (
              <g key={i}>
                <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(a.width, hit)} strokeLinecap="round" strokeLinejoin="round" />
                <path d={d} fill="none" stroke={a.color} strokeOpacity={op} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          })}
        </>
      );
    case 'square':
    case 'circle': {
      const r = a.rect;
      const h = a.width / 2;
      const common = { fill: a.fill ?? 'none', fillOpacity: op, stroke: a.color, strokeOpacity: op, strokeWidth: a.width, strokeDasharray: preview ? '4 3' : undefined };
      const target = a.fill ? 'visiblePainted' : 'stroke';
      return a.type === 'square' ? (
        <g>
          <rect x={r.x + h} y={r.y + h} width={Math.max(0, r.width - a.width)} height={Math.max(0, r.height - a.width)} {...common} style={{ pointerEvents: target }} />
          {!a.fill && <rect x={r.x + h} y={r.y + h} width={Math.max(0, r.width - a.width)} height={Math.max(0, r.height - a.width)} fill="none" stroke="transparent" strokeWidth={Math.max(a.width, hit)} />}
        </g>
      ) : (
        <g>
          <ellipse cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={Math.max(0.1, r.width / 2 - h)} ry={Math.max(0.1, r.height / 2 - h)} {...common} style={{ pointerEvents: target }} />
          {!a.fill && <ellipse cx={r.x + r.width / 2} cy={r.y + r.height / 2} rx={Math.max(0.1, r.width / 2 - h)} ry={Math.max(0.1, r.height / 2 - h)} fill="none" stroke="transparent" strokeWidth={Math.max(a.width, hit)} />}
        </g>
      );
    }
    case 'line':
      return (
        <g>
          <line x1={a.p1.x} y1={a.p1.y} x2={a.p2.x} y2={a.p2.y} stroke="transparent" strokeWidth={Math.max(a.width, hit)} />
          <line x1={a.p1.x} y1={a.p1.y} x2={a.p2.x} y2={a.p2.y} stroke={a.color} strokeOpacity={op} strokeWidth={a.width} strokeLinecap="round" />
          {a.endStyle === 'arrow' && <polygon points={arrowHead(a.p2, a.p1, a.width)} fill={a.color} fillOpacity={op} />}
          {a.startStyle === 'arrow' && <polygon points={arrowHead(a.p1, a.p2, a.width)} fill={a.color} fillOpacity={op} />}
        </g>
      );
    case 'redact':
      return (
        <>
          {a.quads.map((q, i) => (
            <rect key={i} x={q.x} y={q.y} width={q.width} height={q.height} fill="#ff0000" fillOpacity={0.12} stroke="#d00000" strokeWidth={1.2} strokeDasharray="4 3" />
          ))}
        </>
      );
    case 'stamp':
      return <image href={a.dataUrl} x={a.rect.x} y={a.rect.y} width={a.rect.width} height={a.rect.height} preserveAspectRatio="none" opacity={op} />;
    case 'reply':
      return null;
  }
}

function FreeTextEditor({ a, store, onDone }: { a: Extract<Annotation, { type: 'freetext' }>; store: AnnotationStore; onDone(): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <textarea
      ref={ref}
      className="pv-ft pv-ft-edit"
      value={a.contents}
      style={{ fontSize: a.fontSize, color: a.color, background: a.fill ?? 'rgba(255,255,255,0.7)' }}
      onChange={(e) => store.update(a.id, { contents: e.target.value } as Partial<Annotation>, { coalesceKey: `text:${a.id}` })}
      onBlur={() => {
        onDone();
        if (!store.get(a.id)?.contents.trim()) store.remove(a.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.currentTarget.blur();
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------- selection chrome

function Selection({
  a,
  zoom,
  onResize,
  onLineEnd,
}: {
  a: Annotation;
  zoom: number;
  onResize(h: Handle, e: RPointerEvent<Element>): void;
  onLineEnd(which: 'p1' | 'p2', e: RPointerEvent<Element>): void;
}) {
  const b = annotationBounds(a);
  const pad = 2 / zoom;
  const hs = 8 / zoom;
  const resizable = a.type === 'freetext' || a.type === 'square' || a.type === 'circle' || a.type === 'stamp';
  const pos = (h: Handle): Point => ({
    x: h.includes('w') ? b.x : h.includes('e') ? b.x + b.width : b.x + b.width / 2,
    y: h.includes('n') ? b.y : h.includes('s') ? b.y + b.height : b.y + b.height / 2,
  });
  const cursor: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect x={b.x - pad} y={b.y - pad} width={b.width + 2 * pad} height={b.height + 2 * pad} fill="none" stroke="#2563eb" strokeWidth={1.5} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
      {resizable &&
        HANDLES.map((h) => {
          const p = pos(h);
          return (
            <rect
              key={h}
              className="pv-handle"
              x={p.x - hs / 2}
              y={p.y - hs / 2}
              width={hs}
              height={hs}
              style={{ cursor: cursor[h], pointerEvents: 'all' }}
              onPointerDown={(e) => onResize(h, e)}
            />
          );
        })}
      {a.type === 'line' &&
        (['p1', 'p2'] as const).map((k) => (
          <circle key={k} className="pv-handle" cx={a[k].x} cy={a[k].y} r={hs / 1.6} style={{ cursor: 'move', pointerEvents: 'all' }} onPointerDown={(e) => onLineEnd(k, e)} />
        ))}
    </g>
  );
}

/** One-click Fill & Sign marks, centred on the click. */
function createMark(tool: Tool, pt: Point, page: number, author: string, style: ToolStyle, stamp: StampArm | null): Annotation | null {
  const b = baseFields(page, author, style.color, 1);
  const S = Math.max(8, style.fontSize) * 0.9;
  switch (tool) {
    case 'date': {
      const text = new Date().toLocaleDateString();
      const w = Math.max(60, text.length * style.fontSize * 0.62 + 8);
      return { ...b, type: 'freetext', contents: text, rect: { x: pt.x, y: pt.y - style.fontSize * 0.8, width: w, height: style.fontSize * 1.6 }, fontSize: style.fontSize, fill: null, borderWidth: 0 };
    }
    case 'check':
      return { ...b, type: 'ink', width: 1.8, strokes: [[{ x: pt.x - 0.45 * S, y: pt.y }, { x: pt.x - 0.1 * S, y: pt.y + 0.4 * S }, { x: pt.x + 0.5 * S, y: pt.y - 0.45 * S }]] };
    case 'cross':
      return {
        ...b,
        type: 'ink',
        width: 1.8,
        strokes: [
          [{ x: pt.x - 0.4 * S, y: pt.y - 0.4 * S }, { x: pt.x + 0.4 * S, y: pt.y + 0.4 * S }],
          [{ x: pt.x + 0.4 * S, y: pt.y - 0.4 * S }, { x: pt.x - 0.4 * S, y: pt.y + 0.4 * S }],
        ],
      };
    case 'dot': {
      const d = S * 0.5;
      return { ...b, type: 'circle', rect: { x: pt.x - d / 2, y: pt.y - d / 2, width: d, height: d }, width: 1, fill: style.color };
    }
    case 'hline':
      return { ...b, type: 'line', p1: { x: pt.x - 30, y: pt.y }, p2: { x: pt.x + 30, y: pt.y }, width: style.width, startStyle: 'none', endStyle: 'none' };
    case 'stamp': {
      if (!stamp) return null;
      const h = stamp.width / stamp.aspect;
      return { ...b, id: STAMP_ID_PREFIX + newId(), type: 'stamp', dataUrl: stamp.dataUrl, rect: { x: pt.x - stamp.width / 2, y: pt.y - h / 2, width: stamp.width, height: h } };
    }
    default:
      return null;
  }
}
