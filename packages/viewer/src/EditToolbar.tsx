import { useEffect, useRef, useState } from 'react';
import type { LinkInfo, PageObject } from '@pdfsuite/editor';
import type { Rect } from '@pdfsuite/annotations';
import type { PdfDocument } from '@pdfsuite/engine';
import { Footer, Modal, useRun } from './PageToolDialogs';
import type { EditMode, EditTools, PlaceImage, ShapeStyle, TextStyle } from './EditTypes';

export interface EditState {
  on: boolean;
  mode: EditMode;
  sel: { page: number; ids: string[] };
  linkSel: { page: number; index: number } | null;
  textStyle: TextStyle;
  shapeStyle: ShapeStyle;
  place: PlaceImage | null;
  cropId: string | null;
  linkDialog: { page: number; rect?: Rect; link?: LinkInfo } | null;
}

export const initialEditState: EditState = {
  on: false,
  mode: 'select',
  sel: { page: 0, ids: [] },
  linkSel: null,
  textStyle: { family: 'Helvetica', size: 14, color: '#111111', bold: false, italic: false },
  shapeStyle: { stroke: '#d32f2f', fill: null, width: 2 },
  place: null,
  cropId: null,
  linkDialog: null,
};

const SIZES = [8, 10, 12, 14, 18, 24, 36, 48];
const WIDTHS = [1, 2, 3, 5, 8];

interface Props {
  tools: EditTools;
  doc: PdfDocument;
  state: EditState;
  set(patch: Partial<EditState>): void;
  onNotice(msg: string): void;
}

export function EditToolbar({ tools, doc, state, set, onNotice }: Props) {
  const { on, mode } = state;
  const [objects, setObjects] = useState<PageObject[]>([]);
  const [links, setLinks] = useState<LinkInfo[]>([]);
  const imageInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  // Facts about the current selection, to offer the right buttons.
  useEffect(() => {
    let alive = true;
    if (!on || (!state.sel.ids.length && !state.linkSel)) {
      setObjects([]);
      setLinks([]);
      return;
    }
    const page = state.linkSel?.page ?? state.sel.page;
    Promise.all([tools.listObjects(page), tools.listLinks(page)]).then(([o, l]) => {
      if (!alive) return;
      setObjects(o.filter((x) => state.sel.ids.includes(x.id)));
      setLinks(l.filter((x) => state.linkSel?.index === x.index));
    }, () => undefined);
    return () => {
      alive = false;
    };
  }, [on, doc, state.sel, state.linkSel, tools]);

  const fail = (e: unknown) => onNotice(e instanceof Error ? e.message : String(e));
  const single = objects.length === 1 ? objects[0]! : null;
  const isImage = single && (single.kind === 'image');
  const busy = tools.busy;
  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const aspect = bmp.width / Math.max(1, bmp.height);
      bmp.close();
      set({ place: { file: f, aspect }, mode: 'image' });
      onNotice('Click on the page where the picture should go.');
    } catch {
      onNotice('That file is not a picture this browser can read.');
    }
  };

  const modeBtn = (m: EditMode, label: string, title: string) => (
    <button key={m} aria-pressed={mode === m} title={title} onClick={() => set({ mode: mode === m ? 'select' : m, cropId: null })} disabled={busy}>
      {label}
    </button>
  );
  const shapeMode = mode === 'rect' || mode === 'ellipse' || mode === 'line' || mode === 'arrow';
  const ts = state.textStyle;
  const ss = state.shapeStyle;
  const sel = state.sel;

  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Edit">
      <strong className="pv-muted">Edit</strong>
      <button aria-pressed={on} onClick={() => set({ on: !on, mode: 'select', sel: { page: sel.page, ids: [] }, linkSel: null, cropId: null })} title="Edit text, images and graphics on the page">
        {on ? 'Done editing' : 'Edit PDF'}
      </button>
      {on && (
        <>
          <span className="pv-sep" />
          {modeBtn('select', 'Select', 'Select, move and resize objects; double-click text to edit it')}
          {modeBtn('text', 'Add text', 'Click on the page and type')}
          <button aria-pressed={mode === 'image'} onClick={() => imageInput.current?.click()} disabled={busy} title="Add a picture">
            Add image…
          </button>
          <input ref={imageInput} type="file" accept="image/*" hidden onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = ''; }} />
          {modeBtn('rect', 'Rectangle', 'Draw a rectangle')}
          {modeBtn('ellipse', 'Ellipse', 'Draw an ellipse')}
          {modeBtn('line', 'Line', 'Draw a line')}
          {modeBtn('arrow', 'Arrow', 'Draw an arrow')}
          {modeBtn('link', 'Link', 'Drag a rectangle to make a link')}
          <span className="pv-sep" />
          {(mode === 'text' || single?.kind === 'text') && (
            <>
              <select aria-label="Font" value={ts.family} onChange={(e) => set({ textStyle: { ...ts, family: e.target.value as TextStyle['family'] } })}>
                <option>Helvetica</option>
                <option>Times</option>
                <option>Courier</option>
              </select>
              <select aria-label="Font size" value={ts.size} onChange={(e) => set({ textStyle: { ...ts, size: Number(e.target.value) } })}>
                {SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} pt
                  </option>
                ))}
              </select>
              <input type="color" aria-label="Text colour" value={ts.color} onChange={(e) => set({ textStyle: { ...ts, color: e.target.value } })} />
              <button aria-pressed={ts.bold} onClick={() => set({ textStyle: { ...ts, bold: !ts.bold } })} title="Bold"><b>B</b></button>
              <button aria-pressed={ts.italic} onClick={() => set({ textStyle: { ...ts, italic: !ts.italic } })} title="Italic"><i>I</i></button>
            </>
          )}
          {shapeMode && (
            <>
              <input type="color" aria-label="Line colour" value={ss.stroke} onChange={(e) => set({ shapeStyle: { ...ss, stroke: e.target.value } })} />
              {(mode === 'rect' || mode === 'ellipse') && (
                <label className="pv-muted pv-inline">
                  Fill
                  <input type="checkbox" checked={ss.fill !== null} onChange={(e) => set({ shapeStyle: { ...ss, fill: e.target.checked ? '#ffeb3b' : null } })} aria-label="Fill" />
                  {ss.fill !== null && <input type="color" aria-label="Fill colour" value={ss.fill} onChange={(e) => set({ shapeStyle: { ...ss, fill: e.target.value } })} />}
                </label>
              )}
              <select aria-label="Line width" value={ss.width} onChange={(e) => set({ shapeStyle: { ...ss, width: Number(e.target.value) } })}>
                {WIDTHS.map((w) => (
                  <option key={w} value={w}>
                    {w} pt
                  </option>
                ))}
              </select>
            </>
          )}
          {isImage && (
            <>
              <button disabled={busy} onClick={() => replaceInput.current?.click()} title="Show a different picture here">
                Replace…
              </button>
              <input ref={replaceInput} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void tools.onReplaceImage(sel.page, single!.id, f).catch(fail); }} />
              <button disabled={busy} onClick={() => void tools.onExportImage(sel.page, single!.id).catch(fail)} title="Save the picture as a file">
                Export
              </button>
              <button aria-pressed={mode === 'crop'} disabled={busy} onClick={() => { set({ mode: mode === 'crop' ? 'select' : 'crop', cropId: single!.id }); onNotice('Drag a rectangle on the image to keep that part.'); }} title="Hide everything outside a rectangle">
                Crop
              </button>
            </>
          )}
          {links.length === 1 && (
            <button disabled={busy} onClick={() => set({ linkDialog: { page: state.linkSel!.page, link: links[0] } })}>
              Edit link…
            </button>
          )}
          {(objects.length > 0 || links.length > 0) && (
            <button
              disabled={busy}
              onClick={() => {
                if (links.length) void tools.onDeleteLink(state.linkSel!.page, state.linkSel!.index).then(() => set({ linkSel: null }), fail);
                else void tools.onDelete(sel.page, sel.ids).then(() => set({ sel: { page: sel.page, ids: [] } }), fail);
              }}
              title="Delete the selection (Del)"
            >
              Delete
            </button>
          )}
          <span className="pv-spacer" />
          <span className="pv-muted">{busy ? 'Working…' : mode === 'select' ? (single?.kind === 'text' ? 'Double-click the text to edit' : 'Select an object') : ''}</span>
        </>
      )}
      {state.linkDialog && <LinkDialog dlg={state.linkDialog} tools={tools} pageCount={doc.pageCount} onClose={() => set({ linkDialog: null })} onDone={() => set({ mode: 'select' })} />}
    </div>
  );
}

function LinkDialog({ dlg, tools, pageCount, onClose, onDone }: { dlg: { page: number; rect?: Rect; link?: LinkInfo }; tools: EditTools; pageCount: number; onClose(): void; onDone(): void }) {
  const [kind, setKind] = useState<'uri' | 'page'>(dlg.link?.kind === 'page' ? 'page' : 'uri');
  const [uri, setUri] = useState(dlg.link?.uri ?? 'https://');
  const [target, setTarget] = useState(dlg.link?.page ?? 0);
  const { error, running, run } = useRun(() => {
    onDone();
    onClose();
  });
  const apply = () =>
    run(async () => {
      const t = kind === 'uri' ? { uri: uri.trim() } : { page: target };
      if (dlg.link) await tools.onUpdateLink(dlg.page, dlg.link.index, t);
      else await tools.onAddLink(dlg.page, dlg.rect!, t);
    });
  return (
    <Modal title={dlg.link ? 'Edit link' : 'Create link'} onClose={onClose}>
      <div className="pv-tabs" role="tablist">
        <button role="tab" aria-selected={kind === 'uri'} onClick={() => setKind('uri')}>
          Web address
        </button>
        <button role="tab" aria-selected={kind === 'page'} onClick={() => setKind('page')}>
          Page in this document
        </button>
      </div>
      {kind === 'uri' ? (
        <input className="pv-search-input" value={uri} onChange={(e) => setUri(e.target.value)} aria-label="Web address" placeholder="https://example.com" autoFocus />
      ) : (
        <label>
          Go to page{' '}
          <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Target page">
            {Array.from({ length: pageCount }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
      )}
      <Footer error={error} running={running} onClose={onClose} action={dlg.link ? 'Save link' : 'Create link'} onAction={() => void apply()} />
    </Modal>
  );
}
