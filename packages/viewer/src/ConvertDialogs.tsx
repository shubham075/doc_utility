import { useRef, useState } from 'react';
import { Footer, Modal, ScopeInput, num, useRun, useScope } from './PageToolDialogs';

export type Progress = (fraction: number, label?: string) => void;

/** Everything the convert/OCR/compress tools need from the host application. */
export interface ConvertTools {
  /** Null when the API service is unreachable. */
  server: { office: boolean; html: boolean; compress: boolean; ocr: boolean } | null;
  /** A scanner can be driven from this app (desktop). */
  canScan: boolean;
  onScan(): Promise<File | null>;
  onCreate(files: File[], opts: { pageSize: 'fit' | 'a4' | 'letter'; mode: 'new' | 'append' }, progress: Progress): Promise<void>;
  onExport(kind: 'images' | 'text', pages: number[], opts: { format: 'png' | 'jpeg'; dpi: number; quality: number }, progress: Progress): Promise<void>;
  onCompress(opts: { preset: 'low' | 'medium' | 'high'; stripMetadata: boolean; removeThumbnails: boolean; where: 'local' | 'server' }, progress: Progress): Promise<{ before: number; after: number }>;
  onOcr(opts: { pages: number[]; dpi: number; skipPagesWithText: boolean; where: 'local' | 'server' }, progress: Progress, signal: AbortSignal): Promise<{ pages: number; words: number }>;
}

export type ConvertDialogKind = 'create' | 'export' | 'compress' | 'ocr';

interface Common {
  tools: ConvertTools;
  pageCount: number;
  currentPage: number;
  onClose(): void;
}

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  if (value === null) return null;
  return (
    <div role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100} className="pv-progress">
      <div style={{ width: `${Math.round(value * 100)}%` }} />
      <span>{label ?? `${Math.round(value * 100)}%`}</span>
    </div>
  );
}

function useProgress() {
  const [p, setP] = useState<{ value: number; label?: string } | null>(null);
  return { p, set: ((value, label) => setP({ value, label })) as Progress, reset: () => setP(null) };
}

const KIND_OF = (f: File): 'image' | 'office' | 'html' | 'pdf' | 'unknown' => {
  const n = f.name.toLowerCase();
  if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|avif)$/.test(n)) return 'image';
  if (/\.(html?|xhtml)$/.test(n) || f.type === 'text/html') return 'html';
  if (/\.(docx?|odt|rtf|txt|xlsx?|ods|csv|pptx?|odp)$/.test(n)) return 'office';
  if (/\.pdf$/.test(n) || f.type === 'application/pdf') return 'pdf';
  return 'unknown';
};

// ---------------------------------------------------------------- create

export function CreateDialog({ tools, onClose }: Common) {
  const [files, setFiles] = useState<File[]>([]);
  const [pageSize, setPageSize] = useState<'fit' | 'a4' | 'letter'>('fit');
  const [mode, setMode] = useState<'new' | 'append'>('new');
  const picker = useRef<HTMLInputElement>(null);
  const prog = useProgress();
  const { error, running, run } = useRun(onClose);

  const unsupported = (f: File) => {
    const k = KIND_OF(f);
    if (k === 'unknown') return 'Unsupported file type';
    if (k === 'office' && !tools.server?.office) return 'Needs the server (LibreOffice)';
    if (k === 'html' && !tools.server?.html) return 'Needs the server (Chrome/Edge)';
    return null;
  };
  const blocked = files.some((f) => unsupported(f));
  const move = (i: number, d: number) =>
    setFiles((fs) => {
      const j = i + d;
      if (j < 0 || j >= fs.length) return fs;
      const c = [...fs];
      [c[i], c[j]] = [c[j]!, c[i]!];
      return c;
    });

  return (
    <Modal title="Create PDF" onClose={onClose} wide>
      <p className="pv-muted">Combine images, Word/Excel/PowerPoint files, HTML pages and PDFs into one PDF. Images are converted in this app; Office and HTML files use the server.</p>
      <ul className="pv-combine-list">
        {files.map((f, i) => (
          <li key={i}>
            <span className="pv-combine-name">{f.name}</span>
            <span className={unsupported(f) ? 'pv-error' : 'pv-muted'}>{unsupported(f) ?? kb(f.size)}</span>
            <button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
              ↑
            </button>
            <button onClick={() => move(i, 1)} disabled={i === files.length - 1} aria-label="Move down">
              ↓
            </button>
            <button onClick={() => setFiles((fs) => fs.filter((_, k) => k !== i))} aria-label="Remove">
              ✕
            </button>
          </li>
        ))}
        {!files.length && <li className="pv-muted">No files yet</li>}
      </ul>
      <div className="pv-search-row">
        <button onClick={() => picker.current?.click()}>Add files…</button>
        {tools.canScan && (
          <button
            onClick={async () => {
              const f = await tools.onScan().catch(() => null);
              if (f) setFiles((fs) => [...fs, f]);
            }}
          >
            Scan…
          </button>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/*,.pdf,.doc,.docx,.odt,.rtf,.txt,.xls,.xlsx,.ods,.csv,.ppt,.pptx,.odp,.html,.htm"
          onChange={(e) => {
            const added = Array.from(e.target.files ?? []);
            e.target.value = '';
            setFiles((fs) => [...fs, ...added]);
          }}
        />
        <span className="pv-spacer" />
        <label>
          Image pages
          <select value={pageSize} onChange={(e) => setPageSize(e.target.value as typeof pageSize)}>
            <option value="fit">Fit to image</option>
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
        </label>
        <label>
          <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> New document
        </label>
        <label>
          <input type="radio" checked={mode === 'append'} onChange={() => setMode('append')} /> Append to this one
        </label>
      </div>
      <ProgressBar value={prog.p?.value ?? null} label={prog.p?.label} />
      <Footer
        error={error}
        running={running}
        onClose={onClose}
        action="Create"
        onAction={() => run(() => tools.onCreate(files, { pageSize, mode }, prog.set))}
        disabled={!files.length || blocked}
      />
    </Modal>
  );
}

// ---------------------------------------------------------------- export

export function ExportDialog({ tools, pageCount, currentPage, onClose }: Common) {
  const scope = useScope(pageCount, currentPage);
  const [kind, setKind] = useState<'images' | 'text'>('images');
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.85);
  const prog = useProgress();
  const { error, running, run } = useRun(onClose);
  return (
    <Modal title="Export" onClose={onClose}>
      <div className="pv-tabs" role="tablist">
        <button role="tab" aria-selected={kind === 'images'} onClick={() => setKind('images')}>
          Images
        </button>
        <button role="tab" aria-selected={kind === 'text'} onClick={() => setKind('text')}>
          Text
        </button>
      </div>
      {kind === 'images' ? (
        <div className="pv-search-row">
          <label>
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}>
              <option value="png">PNG (lossless)</option>
              <option value="jpeg">JPEG</option>
            </select>
          </label>
          <label>
            Resolution
            <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
              {[72, 100, 150, 200, 300, 600].map((d) => (
                <option key={d} value={d}>
                  {d} dpi
                </option>
              ))}
            </select>
          </label>
          {format === 'jpeg' && (
            <label>
              Quality {Math.round(quality * 100)}%
              <input type="range" min={0.3} max={1} step={0.05} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </label>
          )}
        </div>
      ) : (
        <p className="pv-muted">Plain text of the chosen pages as a .txt file (scanned pages need OCR first).</p>
      )}
      <ScopeInput s={scope} />
      <ProgressBar value={prog.p?.value ?? null} label={prog.p?.label} />
      <Footer error={error} running={running} onClose={onClose} action="Export" onAction={() => run(() => tools.onExport(kind, scope.pages, { format, dpi: num(String(dpi), 150), quality }, prog.set))} disabled={!!scope.error} />
    </Modal>
  );
}

// ---------------------------------------------------------------- compress

export function CompressDialog({ tools, onClose }: Common) {
  const [preset, setPreset] = useState<'low' | 'medium' | 'high'>('medium');
  const [strip, setStrip] = useState(false);
  const [thumbs, setThumbs] = useState(true);
  const [where, setWhere] = useState<'local' | 'server'>('local');
  const [result, setResult] = useState<{ before: number; after: number } | null>(null);
  const prog = useProgress();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await tools.onCompress({ preset, stripMetadata: strip, removeThumbnails: thumbs, where }, prog.set));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      prog.reset();
    }
  };

  const options: ['low' | 'medium' | 'high', string, string][] = [
    ['low', 'Smallest file', 'Images reduced to ~1000 px, JPEG quality 50%'],
    ['medium', 'Balanced', 'Images reduced to ~1600 px, JPEG quality 65%'],
    ['high', 'Best quality', 'Images reduced to ~2400 px, JPEG quality 80%'],
  ];
  return (
    <Modal title="Compress PDF" onClose={onClose}>
      {options.map(([k, label, hint]) => (
        <label key={k} className="pv-radio-row">
          <input type="radio" checked={preset === k} onChange={() => setPreset(k)} />
          <span>
            <strong>{label}</strong> <span className="pv-muted">{hint}</span>
          </span>
        </label>
      ))}
      <label>
        <input type="checkbox" checked={thumbs} onChange={(e) => setThumbs(e.target.checked)} /> Remove embedded thumbnails
      </label>
      <label>
        <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Remove document properties (title, author…)
      </label>
      <div className="pv-search-row">
        <span className="pv-muted">Run on</span>
        <label>
          <input type="radio" checked={where === 'local'} onChange={() => setWhere('local')} /> This device
        </label>
        <label>
          <input type="radio" checked={where === 'server'} disabled={!tools.server?.compress} onChange={() => setWhere('server')} /> Server{!tools.server?.compress ? ' (unavailable)' : ''}
        </label>
      </div>
      <ProgressBar value={prog.p?.value ?? null} label={prog.p?.label} />
      {result && (
        <div role="status" className={result.after < result.before ? '' : 'pv-muted'}>
          {result.after < result.before ? `Reduced from ${kb(result.before)} to ${kb(result.after)} (${Math.round((1 - result.after / result.before) * 100)}% smaller). Undo edit restores the original.` : `No further savings possible (${kb(result.before)}).`}
        </div>
      )}
      {error && <div className="pv-error">{error}</div>}
      <div className="pv-search-row">
        <span className="pv-spacer" />
        <button onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>
        <button className="pv-primary" onClick={go} disabled={busy}>
          {busy ? 'Working…' : 'Compress'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- OCR

export function OcrDialog({ tools, pageCount, currentPage, onClose }: Common) {
  const scope = useScope(pageCount, currentPage);
  const [dpi, setDpi] = useState(250);
  const [skip, setSkip] = useState(true);
  const [where, setWhere] = useState<'local' | 'server'>('local');
  const [result, setResult] = useState<{ pages: number; words: number } | null>(null);
  const prog = useProgress();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ac = useRef<AbortController | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    ac.current = new AbortController();
    try {
      setResult(await tools.onOcr({ pages: scope.pages, dpi, skipPagesWithText: skip, where }, prog.set, ac.current.signal));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      prog.reset();
    }
  };
  return (
    <Modal title="Recognize text (OCR)" onClose={() => (busy ? ac.current?.abort() : onClose())}>
      <p className="pv-muted">Adds an invisible text layer to scanned pages so they can be searched, selected and copied. The page image is not changed. English text.</p>
      <ScopeInput s={scope} />
      <div className="pv-search-row">
        <label>
          Scan resolution
          <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
            {[150, 200, 250, 300, 400].map((d) => (
              <option key={d} value={d}>
                {d} dpi
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip pages that already have text
        </label>
      </div>
      <div className="pv-search-row">
        <span className="pv-muted">Run on</span>
        <label>
          <input type="radio" checked={where === 'local'} onChange={() => setWhere('local')} /> This device (offline)
        </label>
        <label>
          <input type="radio" checked={where === 'server'} disabled={!tools.server?.ocr} onChange={() => setWhere('server')} /> Server{!tools.server?.ocr ? ' (unavailable)' : ''}
        </label>
      </div>
      <ProgressBar value={prog.p?.value ?? null} label={prog.p?.label} />
      {result && <div role="status">{result.pages ? `Recognized ${result.words} words on ${result.pages} page(s). Undo edit restores the original.` : 'Nothing to do: every chosen page already has text.'}</div>}
      {error && <div className="pv-error">{error}</div>}
      <div className="pv-search-row">
        <span className="pv-spacer" />
        <button onClick={() => (busy ? ac.current?.abort() : onClose())}>{busy ? 'Cancel OCR' : result ? 'Close' : 'Cancel'}</button>
        <button className="pv-primary" onClick={go} disabled={busy || !!scope.error}>
          {busy ? 'Working…' : 'Recognize text'}
        </button>
      </div>
    </Modal>
  );
}
