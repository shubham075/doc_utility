import type { OutlineItem } from '@pdfsuite/pages';
import type { DialogKind } from './PageToolDialogs';

interface Props {
  organizing: boolean;
  onOrganize(): void;
  onDialog(k: DialogKind): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  busy: boolean;
}

export function PageToolbar(p: Props) {
  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Page tools">
      <strong className="pv-muted">Pages</strong>
      <button aria-pressed={p.organizing} onClick={p.onOrganize} disabled={p.busy} title="Reorder, rotate, delete, insert, extract">
        Organize
      </button>
      <button onClick={() => p.onDialog('combine')} disabled={p.busy} title="Merge several PDFs into one">
        Combine
      </button>
      <button onClick={() => p.onDialog('split')} disabled={p.busy} title="Split into several PDFs">
        Split
      </button>
      <button onClick={() => p.onDialog('crop')} disabled={p.busy}>
        Crop
      </button>
      <button onClick={() => p.onDialog('headerFooter')} disabled={p.busy} title="Headers, footers, page numbers, Bates numbering">
        Header &amp; footer
      </button>
      <button onClick={() => p.onDialog('watermark')} disabled={p.busy}>
        Watermark
      </button>
      <span className="pv-spacer" />
      <button onClick={p.onUndo} disabled={!p.canUndo || p.busy} title="Undo the last page operation">
        Undo edit
      </button>
      <button onClick={p.onRedo} disabled={!p.canRedo || p.busy}>
        Redo edit
      </button>
      {p.busy && <span className="pv-muted" role="status">Working…</span>}
    </div>
  );
}

export function OutlinePanel({ items, onGoto }: { items: OutlineItem[]; onGoto(page: number): void }) {
  return (
    <div className="pv-outline" role="tree" aria-label="Bookmarks">
      {items.length ? <OutlineList items={items} onGoto={onGoto} depth={0} /> : <p className="pv-muted">No bookmarks</p>}
    </div>
  );
}

function OutlineList({ items, onGoto, depth }: { items: OutlineItem[]; onGoto(page: number): void; depth: number }) {
  return (
    <ul className="pv-outline-list">
      {items.map((it, i) => (
        <li key={i} role="treeitem">
          <button className="pv-outline-item" style={{ paddingLeft: 6 + depth * 12 }} disabled={it.page === null} onClick={() => it.page !== null && onGoto(it.page)} title={it.page !== null ? `Page ${it.page + 1}` : 'Destination not found'}>
            {it.title || '(untitled)'}
          </button>
          {it.children.length > 0 && <OutlineList items={it.children} onGoto={onGoto} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
