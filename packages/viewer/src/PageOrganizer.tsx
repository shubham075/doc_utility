import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
import {
  deleteItems,
  duplicateItems,
  identityPlan,
  insertBlank,
  isIdentity,
  moveItems,
  rotateItems,
  type PlanItem,
} from '@pdfsuite/pages';
import type { Size } from './layout';
import type { RenderQueue } from './renderQueue';

const THUMB_W = 140;
const THUMB_H = 180;

interface Props {
  doc: PdfDocument;
  sizes: Size[];
  queue: RenderQueue;
  busy: boolean;
  /** Apply the edited plan to the document. */
  onApply(items: PlanItem[]): void;
  onCancel(): void;
  /** Save the given pages as a new PDF (the document itself is unchanged). */
  onExtract(items: PlanItem[]): void;
  /** Insert all pages of a PDF file after plan position `afterIndex` (-1 = at the start). */
  onInsertFile(plan: PlanItem[], afterIndex: number, file: File): void;
}

/** Full-pane page grid: select, drag to reorder, rotate, delete, duplicate, insert blank/file, extract. */
export function PageOrganizer({ doc, sizes, queue, busy, onApply, onCancel, onExtract, onInsertFile }: Props) {
  const [items, setItems] = useState<PlanItem[]>(() => identityPlan(sizes.length));
  const [history, setHistory] = useState<{ undo: PlanItem[][]; redo: PlanItem[][] }>({ undo: [], redo: [] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number>(-1);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragIds = useRef<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const edit = useCallback(
    (next: PlanItem[]) => {
      setHistory((h) => ({ undo: [...h.undo, items], redo: [] }));
      setItems(next);
    },
    [items],
  );
  const undo = () => {
    const prev = history.undo[history.undo.length - 1];
    if (!prev) return;
    setItems(prev);
    setHistory({ undo: history.undo.slice(0, -1), redo: [...history.redo, items] });
  };
  const redo = () => {
    const next = history.redo[history.redo.length - 1];
    if (!next) return;
    setItems(next);
    setHistory({ undo: [...history.undo, items], redo: history.redo.slice(0, -1) });
  };

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected]);
  const lastSelectedIndex = items.reduce((acc, it, i) => (selected.has(it.id) ? i : acc), -1);
  const changed = !isIdentity(items, sizes.length);

  const sizeOf = (it: PlanItem): Size => (it.page === 'blank' ? (it.blank ?? { width: 612, height: 792 }) : (sizes[it.page] ?? { width: 612, height: 792 }));

  const onTileClick = (index: number, e: React.MouseEvent) => {
    const id = items[index]!.id;
    if (e.shiftKey && anchor >= 0) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(items.slice(a, b + 1).map((i) => i.id)));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
      setAnchor(index);
    } else {
      setSelected(new Set([id]));
      setAnchor(index);
    }
  };

  const rotate = (delta: number) => selected.size && edit(rotateItems(items, selected, delta));
  const remove = () => {
    if (!selected.size) return;
    if (selected.size >= items.length) return; // a PDF needs at least one page
    edit(deleteItems(items, selected));
    setSelected(new Set());
  };
  const duplicate = () => selected.size && edit(duplicateItems(items, selected));
  const addBlank = () => {
    const ref = sizeOf(items[lastSelectedIndex >= 0 ? lastSelectedIndex : items.length - 1]!);
    const at = lastSelectedIndex >= 0 ? lastSelectedIndex : items.length - 1;
    edit(insertBlank(items, at, { width: ref.width, height: ref.height }));
  };

  // ---- drag & drop reordering
  const onDragStart = (index: number, e: React.DragEvent) => {
    const id = items[index]!.id;
    const ids = selected.has(id) ? selected : new Set([id]);
    if (!selected.has(id)) setSelected(ids);
    dragIds.current = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', 'pages');
  };
  const onDragOver = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt(e.clientX < r.left + r.width / 2 ? index : index + 1);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (dropAt === null) return;
    const moving = dragIds.current;
    const toIndex = items.slice(0, dropAt).filter((it) => !moving.has(it.id)).length;
    const next = moveItems(items, moving, toIndex);
    if (next.some((it, i) => it !== items[i])) edit(next);
    setDropAt(null);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove();
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape') onCancel();
  };
  useEffect(() => rootRef.current?.focus(), []);

  return (
    <div className="pv-org" ref={rootRef} tabIndex={0} onKeyDown={onKey} aria-label="Organize pages">
      <div className="pv-toolbar pv-org-bar" role="toolbar" aria-label="Organize pages">
        <strong>Organize pages</strong>
        <span className="pv-muted">{selected.size ? `${selected.size} selected` : 'Click to select · drag to reorder'}</span>
        <span className="pv-sep" />
        <button onClick={() => rotate(-90)} disabled={!selected.size} title="Rotate selected pages counter-clockwise">
          ⟲ Left
        </button>
        <button onClick={() => rotate(90)} disabled={!selected.size} title="Rotate selected pages clockwise">
          ⟳ Right
        </button>
        <button onClick={remove} disabled={!selected.size || selected.size >= items.length} title="Delete selected pages (Del)">
          Delete
        </button>
        <button onClick={duplicate} disabled={!selected.size}>
          Duplicate
        </button>
        <button onClick={addBlank} title="Insert a blank page after the selection">
          Insert blank
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy} title="Insert the pages of another PDF after the selection">
          Insert file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onInsertFile(items, lastSelectedIndex >= 0 ? lastSelectedIndex : items.length - 1, f);
          }}
        />
        <button onClick={() => onExtract(selectedItems)} disabled={!selected.size || busy} title="Save the selected pages as a new PDF">
          Extract
        </button>
        <span className="pv-spacer" />
        <button onClick={undo} disabled={!history.undo.length}>
          Undo
        </button>
        <button onClick={redo} disabled={!history.redo.length}>
          Redo
        </button>
        <button onClick={onCancel}>Cancel</button>
        <button className="pv-primary" onClick={() => (changed ? onApply(items) : onCancel())} disabled={busy}>
          {busy ? 'Applying…' : changed ? 'Apply changes' : 'Close'}
        </button>
      </div>
      <div className="pv-org-grid" onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
        {items.map((it, i) => (
          <Tile
            key={it.id}
            item={it}
            index={i}
            size={sizeOf(it)}
            doc={doc}
            queue={queue}
            selected={selected.has(it.id)}
            marker={dropAt === i ? 'before' : dropAt === i + 1 && i === items.length - 1 ? 'after' : null}
            onClick={onTileClick}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
          />
        ))}
      </div>
      <div className="pv-org-foot pv-muted">
        {items.length} pages{changed ? ' · changes not applied yet' : ''}
      </div>
    </div>
  );
}

interface TileProps {
  item: PlanItem;
  index: number;
  size: Size;
  doc: PdfDocument;
  queue: RenderQueue;
  selected: boolean;
  marker: 'before' | 'after' | null;
  onClick(index: number, e: React.MouseEvent): void;
  onDragStart(index: number, e: React.DragEvent): void;
  onDragOver(index: number, e: React.DragEvent): void;
}

const Tile = memo(function Tile({ item, index, size, doc, queue, selected, marker, onClick, onDragStart, onDragOver }: TileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const page = item.page;

  useEffect(() => {
    const el = tileRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || page === 'blank') return;
    const cancel = queue.enqueue({
      priority: () => 2000 + (page as number),
      run: async (signal) => {
        const p = await doc.getPage(page as number);
        try {
          const scale = Math.min(THUMB_W / p.width, THUMB_H / p.height) * (window.devicePixelRatio || 1);
          const bmp = await p.render({ scale });
          if (signal.aborted || !canvasRef.current) return;
          const c = canvasRef.current;
          c.width = bmp.width;
          c.height = bmp.height;
          c.getContext('2d')!.putImageData(new ImageData(bmp.data as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height), 0, 0);
        } finally {
          p.close();
        }
      },
    });
    return cancel;
  }, [visible, page, doc, queue]);

  // Box the page occupies once the pending rotation is applied.
  const sideways = item.rotate === 90 || item.rotate === 270;
  const w = sideways ? size.height : size.width;
  const h = sideways ? size.width : size.height;
  const k = Math.min(THUMB_W / w, THUMB_H / h);
  const boxW = w * k;
  const boxH = h * k;
  const innerW = size.width * k;
  const innerH = size.height * k;

  return (
    <div
      ref={tileRef}
      className={`pv-tile${selected ? ' pv-tile-selected' : ''}${marker ? ` pv-tile-drop-${marker}` : ''}`}
      draggable
      onClick={(e) => onClick(index, e)}
      onDragStart={(e) => onDragStart(index, e)}
      onDragOver={(e) => onDragOver(index, e)}
      aria-label={`Page ${index + 1}`}
      aria-selected={selected}
      role="option"
    >
      <div className="pv-tile-box" style={{ width: THUMB_W, height: THUMB_H }}>
        <div style={{ width: boxW, height: boxH, position: 'relative' }}>
          <div
            className="pv-tile-page"
            style={{
              width: innerW,
              height: innerH,
              left: (boxW - innerW) / 2,
              top: (boxH - innerH) / 2,
              transform: `rotate(${item.rotate}deg)`,
            }}
          >
            {page === 'blank' ? <span className="pv-muted">blank</span> : <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />}
          </div>
        </div>
      </div>
      <div className="pv-tile-label">
        {index + 1}
        {item.page !== 'blank' && item.page !== index && <span className="pv-muted"> (was {item.page + 1})</span>}
        {item.rotate ? <span className="pv-muted"> · {item.rotate}°</span> : null}
      </div>
    </div>
  );
});
