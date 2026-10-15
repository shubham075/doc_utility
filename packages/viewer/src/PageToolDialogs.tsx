import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  parseRanges,
  planSplit,
  type HeaderFooterSpec,
  type Margins,
  type OutlineItem,
  type SplitSpec,
  type TextStyle,
  type WatermarkSpec,
} from '@pdfsuite/pages';

/** Everything the page tools need from the host application. */
export interface PageTools {
  fileName: string;
  busy: boolean;
  outline: OutlineItem[];
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onApplyPlan(items: import('@pdfsuite/pages').PlanItem[]): Promise<void>;
  onExtract(items: import('@pdfsuite/pages').PlanItem[]): Promise<void>;
  onInsertFile(plan: import('@pdfsuite/pages').PlanItem[], afterIndex: number, file: File): Promise<void>;
  onCombine(entries: { file: File | null; ranges: string }[]): Promise<void>;
  onSplit(spec: SplitSpec): Promise<void>;
  onCrop(pages: number[], margins: Margins): Promise<void>;
  onResetCrop(pages: number[]): Promise<void>;
  onHeaderFooter(spec: HeaderFooterSpec): Promise<void>;
  onWatermark(spec: WatermarkSpec): Promise<void>;
  /** Margins that would trim the blank border of a page (0-based). */
  autoCropMargins(page: number): Promise<Margins>;
}

export type DialogKind = 'combine' | 'split' | 'crop' | 'headerFooter' | 'watermark';

interface Common {
  tools: PageTools;
  pageCount: number;
  currentPage: number;
  onClose(): void;
}

// ---------------------------------------------------------------- shared bits

function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="pv-modal-backdrop" role="presentation" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`pv-modal${wide ? ' pv-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

type Scope = 'all' | 'current' | 'odd' | 'even' | 'range';

function useScope(pageCount: number, current: number) {
  const [scope, setScope] = useState<Scope>('all');
  const [range, setRange] = useState('');
  let pages: number[] = [];
  let error: string | null = null;
  try {
    pages =
      scope === 'current'
        ? [current]
        : scope === 'range'
          ? parseRanges(range || '1', pageCount)
          : parseRanges(scope, pageCount);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { scope, setScope, range, setRange, pages, error };
}

function ScopeInput({ s }: { s: ReturnType<typeof useScope> }) {
  return (
    <fieldset className="pv-fieldset">
      <legend>Pages</legend>
      <div className="pv-search-row">
        {(['all', 'current', 'odd', 'even', 'range'] as const).map((k) => (
          <label key={k}>
            <input type="radio" name="scope" checked={s.scope === k} onChange={() => s.setScope(k)} />
            {k === 'all' ? 'All' : k === 'current' ? 'Current' : k === 'odd' ? 'Odd' : k === 'even' ? 'Even' : 'Range'}
          </label>
        ))}
        {s.scope === 'range' && <input className="pv-search-input pv-narrow" placeholder="e.g. 1-3, 5, 8-" value={s.range} onChange={(e) => s.setRange(e.target.value)} />}
      </div>
      {s.error && <div className="pv-error">{s.error}</div>}
    </fieldset>
  );
}

function useRun(onClose: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setRunning(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };
  return { error, running, run };
}

const Footer = ({ error, running, onClose, action, onAction, disabled }: { error: string | null; running: boolean; onClose(): void; action: string; onAction(): void; disabled?: boolean }) => (
  <>
    {error && <div className="pv-error">{error}</div>}
    <div className="pv-search-row">
      <span className="pv-spacer" />
      <button onClick={onClose}>Cancel</button>
      <button className="pv-primary" onClick={onAction} disabled={running || disabled}>
        {running ? 'Working…' : action}
      </button>
    </div>
  </>
);

const num = (v: string, fallback = 0) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);

// ---------------------------------------------------------------- crop

export function CropDialog({ tools, pageCount, currentPage, onClose }: Common) {
  const scope = useScope(pageCount, currentPage);
  const [m, setM] = useState({ top: '0', right: '0', bottom: '0', left: '0' });
  const { error, running, run } = useRun(onClose);
  const margins: Margins = { top: num(m.top), right: num(m.right), bottom: num(m.bottom), left: num(m.left) };
  const set = (k: keyof typeof m) => (e: React.ChangeEvent<HTMLInputElement>) => setM({ ...m, [k]: e.target.value });
  return (
    <Modal title="Crop pages" onClose={onClose}>
      <p className="pv-muted">Trim margins (in points, 72 = 1 inch) from the pages as they appear. Cropping only hides content and can be undone.</p>
      <div className="pv-grid2">
        {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
          <label key={k}>
            {k[0]!.toUpperCase() + k.slice(1)}
            <input className="pv-search-input" inputMode="decimal" value={m[k]} onChange={set(k)} />
          </label>
        ))}
      </div>
      <div className="pv-search-row">
        <button
          onClick={async () => {
            const a = await tools.autoCropMargins(currentPage);
            setM({ top: a.top.toFixed(1), right: a.right.toFixed(1), bottom: a.bottom.toFixed(1), left: a.left.toFixed(1) });
          }}
        >
          Detect blank margins (current page)
        </button>
        <button onClick={() => setM({ top: '0', right: '0', bottom: '0', left: '0' })}>Zero</button>
      </div>
      <ScopeInput s={scope} />
      {error && <div className="pv-error">{error}</div>}
      <div className="pv-search-row">
        <button onClick={() => run(() => tools.onResetCrop(scope.pages))} disabled={running || !!scope.error} title="Remove the crop box from the chosen pages">
          Reset crop
        </button>
        <span className="pv-spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="pv-primary" onClick={() => run(() => tools.onCrop(scope.pages, margins))} disabled={running || !!scope.error}>
          {running ? 'Working…' : 'Crop'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- header / footer / Bates

type Slots = { hl: string; hc: string; hr: string; fl: string; fc: string; fr: string };

export function HeaderFooterDialog({ tools, pageCount, currentPage, onClose }: Common) {
  const scope = useScope(pageCount, currentPage);
  const [t, setT] = useState<Slots>({ hl: '', hc: '', hr: '', fl: '', fc: '<<page>>', fr: '' });
  const [style, setStyle] = useState<TextStyle>({ family: 'Helvetica', size: 10, color: '#000000' });
  const [margin, setMargin] = useState({ top: '30', bottom: '30', side: '36' });
  const [start, setStart] = useState('1');
  const [bates, setBates] = useState({ on: false, prefix: '', suffix: '', start: '1', digits: '6' });
  const focused = useRef<keyof Slots>('fc');
  const { error, running, run } = useRun(onClose);

  const insert = (token: string) => setT((cur) => ({ ...cur, [focused.current]: cur[focused.current] + token }));
  const field = (k: keyof Slots, label: string) => (
    <label key={k}>
      {label}
      <input className="pv-search-input" value={t[k]} onFocus={() => (focused.current = k)} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
    </label>
  );
  const preset = (p: Partial<Slots>) => setT({ hl: '', hc: '', hr: '', fl: '', fc: '', fr: '', ...p });

  const spec = (): HeaderFooterSpec => ({
    pages: scope.pages,
    header: { left: t.hl, center: t.hc, right: t.hr },
    footer: { left: t.fl, center: t.fc, right: t.fr },
    style,
    margin: { top: num(margin.top, 30), bottom: num(margin.bottom, 30), side: num(margin.side, 36) },
    startNumber: Math.round(num(start, 1)),
    bates: bates.on ? { prefix: bates.prefix, suffix: bates.suffix, start: Math.round(num(bates.start, 1)), digits: Math.max(1, Math.round(num(bates.digits, 6))) } : undefined,
    fileName: tools.fileName,
  });
  const empty = Object.values(t).every((v) => !v.trim());

  return (
    <Modal title="Header, footer, page numbers and Bates" onClose={onClose} wide>
      <div className="pv-search-row">
        <span className="pv-muted">Presets</span>
        <button onClick={() => preset({ fc: '<<page>>' })}>Page numbers</button>
        <button onClick={() => preset({ fc: 'Page <<page>> of <<pages>>' })}>Page X of Y</button>
        <button
          onClick={() => {
            setBates({ ...bates, on: true });
            preset({ fr: '<<bates>>' });
          }}
        >
          Bates (bottom right)
        </button>
        <button onClick={() => preset({ hl: '<<file>>', hr: '<<date>>', fc: '<<page>>' })}>File · date · page</button>
      </div>
      <div className="pv-grid3">
        {field('hl', 'Header left')}
        {field('hc', 'Header centre')}
        {field('hr', 'Header right')}
        {field('fl', 'Footer left')}
        {field('fc', 'Footer centre')}
        {field('fr', 'Footer right')}
      </div>
      <div className="pv-search-row">
        <span className="pv-muted">Insert</span>
        {['<<page>>', '<<pages>>', '<<date>>', '<<file>>', '<<bates>>'].map((tok) => (
          <button key={tok} onClick={() => insert(tok)}>
            {tok}
          </button>
        ))}
      </div>
      <div className="pv-search-row">
        <select aria-label="Font" value={style.family} onChange={(e) => setStyle({ ...style, family: e.target.value as TextStyle['family'] })}>
          <option>Helvetica</option>
          <option>Times</option>
          <option>Courier</option>
        </select>
        <label>
          <input type="checkbox" checked={!!style.bold} onChange={(e) => setStyle({ ...style, bold: e.target.checked })} /> Bold
        </label>
        <label>
          <input type="checkbox" checked={!!style.italic} onChange={(e) => setStyle({ ...style, italic: e.target.checked })} /> Italic
        </label>
        <label>
          Size <input className="pv-search-input pv-tiny" value={style.size} onChange={(e) => setStyle({ ...style, size: Math.max(4, num(e.target.value, 10)) })} />
        </label>
        <input type="color" aria-label="Colour" value={style.color} onChange={(e) => setStyle({ ...style, color: e.target.value })} />
      </div>
      <div className="pv-search-row">
        <label>
          Top <input className="pv-search-input pv-tiny" value={margin.top} onChange={(e) => setMargin({ ...margin, top: e.target.value })} />
        </label>
        <label>
          Bottom <input className="pv-search-input pv-tiny" value={margin.bottom} onChange={(e) => setMargin({ ...margin, bottom: e.target.value })} />
        </label>
        <label>
          Side <input className="pv-search-input pv-tiny" value={margin.side} onChange={(e) => setMargin({ ...margin, side: e.target.value })} />
        </label>
        <label>
          First page number <input className="pv-search-input pv-tiny" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
      </div>
      <fieldset className="pv-fieldset">
        <legend>
          <label>
            <input type="checkbox" checked={bates.on} onChange={(e) => setBates({ ...bates, on: e.target.checked })} /> Bates numbering
          </label>
        </legend>
        <div className="pv-search-row" aria-disabled={!bates.on}>
          <label>
            Prefix <input className="pv-search-input pv-narrow" disabled={!bates.on} value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} />
          </label>
          <label>
            Start <input className="pv-search-input pv-tiny" disabled={!bates.on} value={bates.start} onChange={(e) => setBates({ ...bates, start: e.target.value })} />
          </label>
          <label>
            Digits <input className="pv-search-input pv-tiny" disabled={!bates.on} value={bates.digits} onChange={(e) => setBates({ ...bates, digits: e.target.value })} />
          </label>
          <label>
            Suffix <input className="pv-search-input pv-narrow" disabled={!bates.on} value={bates.suffix} onChange={(e) => setBates({ ...bates, suffix: e.target.value })} />
          </label>
        </div>
        <div className="pv-muted">Bates numbers count across the chosen pages. Use &lt;&lt;bates&gt;&gt; in any slot.</div>
      </fieldset>
      <ScopeInput s={scope} />
      <Footer error={error} running={running} onClose={onClose} action="Add" onAction={() => run(() => tools.onHeaderFooter(spec()))} disabled={empty || !!scope.error} />
    </Modal>
  );
}

// ---------------------------------------------------------------- watermark

export function WatermarkDialog({ tools, pageCount, currentPage, onClose }: Common) {
  const scope = useScope(pageCount, currentPage);
  const [kind, setKind] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [style, setStyle] = useState<TextStyle>({ family: 'Helvetica', bold: true, size: 72, color: '#d32f2f' });
  const [image, setImage] = useState<string | null>(null);
  const [imageScale, setImageScale] = useState(0.5);
  const [opacity, setOpacity] = useState(0.3);
  const [rotation, setRotation] = useState(45);
  const [position, setPosition] = useState<'center' | 'tile'>('center');
  const [layer, setLayer] = useState<'over' | 'behind'>('over');
  const { error, running, run } = useRun(onClose);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => setImage(String(r.result));
    r.readAsDataURL(file);
  };
  const spec = (): WatermarkSpec => ({ pages: scope.pages, kind, text, style, dataUrl: image ?? undefined, imageScale, opacity, rotation, position, layer });

  return (
    <Modal title="Watermark" onClose={onClose} wide>
      <div className="pv-tabs" role="tablist">
        {(['text', 'image'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
            {k === 'text' ? 'Text' : 'Image'}
          </button>
        ))}
      </div>
      {kind === 'text' ? (
        <>
          <input className="pv-search-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Watermark text" aria-label="Watermark text" />
          <div className="pv-search-row">
            <select aria-label="Font" value={style.family} onChange={(e) => setStyle({ ...style, family: e.target.value as TextStyle['family'] })}>
              <option>Helvetica</option>
              <option>Times</option>
              <option>Courier</option>
            </select>
            <label>
              <input type="checkbox" checked={!!style.bold} onChange={(e) => setStyle({ ...style, bold: e.target.checked })} /> Bold
            </label>
            <label>
              Size <input className="pv-search-input pv-tiny" value={style.size} onChange={(e) => setStyle({ ...style, size: Math.max(6, num(e.target.value, 72)) })} />
            </label>
            <input type="color" aria-label="Colour" value={style.color} onChange={(e) => setStyle({ ...style, color: e.target.value })} />
          </div>
        </>
      ) : (
        <div className="pv-search-row">
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => onFile(e.target.files?.[0])} />
          <label>
            Width {Math.round(imageScale * 100)}% of page
            <input type="range" min={0.1} max={1} step={0.05} value={imageScale} onChange={(e) => setImageScale(Number(e.target.value))} />
          </label>
        </div>
      )}
      <div className="pv-search-row">
        <label>
          Opacity {Math.round(opacity * 100)}%
          <input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} />
        </label>
        <label>
          Rotation
          <select value={rotation} onChange={(e) => setRotation(Number(e.target.value))}>
            {[0, 30, 45, 90, 315].map((r) => (
              <option key={r} value={r}>
                {r}°
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="radio" checked={position === 'center'} onChange={() => setPosition('center')} /> Centre
        </label>
        <label>
          <input type="radio" checked={position === 'tile'} onChange={() => setPosition('tile')} /> Tile
        </label>
        <label>
          <input type="radio" checked={layer === 'over'} onChange={() => setLayer('over')} /> Over content
        </label>
        <label>
          <input type="radio" checked={layer === 'behind'} onChange={() => setLayer('behind')} /> Behind
        </label>
      </div>
      <ScopeInput s={scope} />
      <Footer
        error={error}
        running={running}
        onClose={onClose}
        action="Add watermark"
        onAction={() => run(() => tools.onWatermark(spec()))}
        disabled={!!scope.error || (kind === 'image' && !image) || (kind === 'text' && !text.trim())}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------- combine

interface Entry {
  id: number;
  file: File | null; // null = the open document
  ranges: string;
}

export function CombineDialog({ tools, onClose }: Common) {
  const [entries, setEntries] = useState<Entry[]>([{ id: 0, file: null, ranges: '' }]);
  const nextId = useRef(1);
  const picker = useRef<HTMLInputElement>(null);
  const { error, running, run } = useRun(onClose);
  const move = (i: number, d: number) =>
    setEntries((es) => {
      const j = i + d;
      if (j < 0 || j >= es.length) return es;
      const c = [...es];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });
  return (
    <Modal title="Combine files" onClose={onClose} wide>
      <p className="pv-muted">The combined PDF replaces the open document (use Undo to go back). Leave the page range empty to take all pages.</p>
      <ul className="pv-combine-list">
        {entries.map((e, i) => (
          <li key={e.id}>
            <span className="pv-combine-name">{e.file ? e.file.name : `${tools.fileName} (open document)`}</span>
            <input className="pv-search-input pv-narrow" placeholder="pages, e.g. 1-3, 5" value={e.ranges} onChange={(ev) => setEntries((es) => es.map((x) => (x.id === e.id ? { ...x, ranges: ev.target.value } : x)))} aria-label="Page range" />
            <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
              ↑
            </button>
            <button onClick={() => move(i, 1)} disabled={i === entries.length - 1} aria-label="Move down">
              ↓
            </button>
            <button onClick={() => setEntries((es) => es.filter((x) => x.id !== e.id))} disabled={entries.length < 2} aria-label="Remove">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="pv-search-row">
        <button onClick={() => picker.current?.click()}>Add files…</button>
        <input
          ref={picker}
          type="file"
          accept="application/pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            setEntries((es) => [...es, ...files.map((file) => ({ id: nextId.current++, file, ranges: '' }))]);
          }}
        />
        <span className="pv-muted">{entries.length} file{entries.length === 1 ? '' : 's'}</span>
      </div>
      <Footer error={error} running={running} onClose={onClose} action="Combine" onAction={() => run(() => tools.onCombine(entries.map((e) => ({ file: e.file, ranges: e.ranges }))))} disabled={entries.length < 2} />
    </Modal>
  );
}

// ---------------------------------------------------------------- split

export function SplitDialog({ tools, pageCount, onClose }: Common) {
  const [mode, setMode] = useState<SplitSpec['mode']>('every');
  const [n, setN] = useState('1');
  const [ranges, setRanges] = useState('');
  const { error, running, run } = useRun(onClose);
  const spec: SplitSpec = mode === 'every' ? { mode, n: Math.max(1, Math.round(num(n, 1))) } : mode === 'ranges' ? { mode, ranges } : { mode };
  const plan = useMemo(() => {
    try {
      return { groups: planSplit(pageCount, spec, tools.outline), error: null as string | null };
    } catch (e) {
      return { groups: [] as number[][], error: e instanceof Error ? e.message : String(e) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, n, ranges, pageCount, tools.outline]);
  return (
    <Modal title="Split document" onClose={onClose}>
      <label>
        <input type="radio" checked={mode === 'every'} onChange={() => setMode('every')} /> Every{' '}
        <input className="pv-search-input pv-tiny" value={n} onChange={(e) => setN(e.target.value)} disabled={mode !== 'every'} aria-label="Pages per file" /> page(s)
      </label>
      <label>
        <input type="radio" checked={mode === 'ranges'} onChange={() => setMode('ranges')} /> By ranges{' '}
        <input className="pv-search-input pv-narrow" placeholder="1-3, 4-6, 7-" value={ranges} onChange={(e) => setRanges(e.target.value)} disabled={mode !== 'ranges'} aria-label="Ranges" />
      </label>
      <label>
        <input type="radio" checked={mode === 'bookmarks'} onChange={() => setMode('bookmarks')} disabled={!tools.outline.length} /> At each top-level bookmark{!tools.outline.length ? ' (no bookmarks)' : ''}
      </label>
      <div className="pv-muted" aria-live="polite">
        {plan.error ?? `${plan.groups.length} file${plan.groups.length === 1 ? '' : 's'}: ${plan.groups.slice(0, 6).map((g) => (g.length === 1 ? g[0]! + 1 : `${g[0]! + 1}-${g[g.length - 1]! + 1}`)).join(', ')}${plan.groups.length > 6 ? ', …' : ''}`}
      </div>
      <p className="pv-muted">Several files are downloaded as one ZIP archive.</p>
      <Footer error={error} running={running} onClose={onClose} action="Split" onAction={() => run(() => tools.onSplit(spec))} disabled={!!plan.error || !plan.groups.length} />
    </Modal>
  );
}
