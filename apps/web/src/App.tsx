import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationStore, readAnnotations, stripMarkupAnnotations, writeAnnotations } from '@pdfsuite/annotations';
import type { PdfDocument } from '@pdfsuite/engine';
import { FormStore, readForm, writeForm } from '@pdfsuite/forms';
import {
  addHeaderFooter,
  addWatermark,
  assemble,
  countPages,
  cropPages,
  detectMargins,
  identityPlan,
  isIdentity,
  itemsFromSource,
  makeZip,
  parseRanges,
  planSplit,
  readOutline,
  resetCrop,
  splitPdf,
  type OutlineItem,
  type PlanItem,
} from '@pdfsuite/pages';
import { PdfViewer, type PageTools } from '@pdfsuite/viewer';
import { desktop } from './desktop-bridge';
import { getEngine, type EngineId } from './engines';
import { getScriptRunner } from './scripts';

interface Prepared {
  bytes: Uint8Array;
  /** Copy of the file without markup annotations: the viewer draws those itself from the store. */
  renderBytes: Uint8Array;
  store: AnnotationStore | null;
  forms: FormStore | null;
  outline: OutlineItem[];
  note?: string;
}

interface Opened {
  render: PdfDocument;
  text: PdfDocument | null;
}

const AUTHOR_KEY = 'pdfsuite.author';
const loadAuthor = () => {
  try {
    return localStorage.getItem(AUTHOR_KEY) || 'User';
  } catch {
    return 'User';
  }
};

export function App() {
  const [engineId, setEngineId] = useState<EngineId>('pdfium');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [status, setStatus] = useState('Open a PDF to begin.');
  const [author, setAuthor] = useState(loadAuthor);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  /** Bytes the next save is based on (the original file, then each saved version). */
  const baseRef = useRef<Uint8Array | null>(null);
  /** Page operations rewrite the file: keep snapshots so they can be undone, and track "needs saving". */
  const [history, setHistory] = useState<{ undo: Uint8Array[]; redo: Uint8Array[] }>({ undo: [], redo: [] });
  const [modified, setModified] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const pendingModified = useRef(false);
  const openedRef = useRef<Opened | null>(null);

  const load = useCallback((data: Uint8Array, name: string) => {
    setHistory({ undo: [], redo: [] });
    pendingModified.current = false;
    setBytes(data);
    setFileName(name);
  }, []);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (file) load(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [load],
  );

  const openNative = useCallback(async () => {
    const [f] = (await desktop()?.openFileDialog()) ?? [];
    if (f) load(f.bytes, f.name);
  }, [load]);

  useEffect(() => desktop()?.onFileOpened((f) => load(f.bytes, f.name)), [load]);

  // Optional ?pdf=<url> to auto-open a document (handy for dev/testing).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('pdf');
    if (!url) return;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => load(new Uint8Array(b), url.split('/').pop() || url))
      .catch((e) => setStatus(`Fetch failed: ${String(e)}`));
  }, [load]);

  // ---- prepare: read annotations once per file, build the render copy
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    setPrepared(null);
    setOpened(null);
    (async () => {
      let store: AnnotationStore | null = null;
      let forms: FormStore | null = null;
      let outline: OutlineItem[] = [];
      let renderBytes = bytes;
      let note: string | undefined;
      try {
        const { annotations } = await readAnnotations(bytes);
        store = new AnnotationStore(annotations);
        const model = await readForm(bytes);
        if (model.hasForm && model.fields.length) {
          const hasScripts = model.fields.some((f) => Object.values(f.actions).some(Boolean));
          let runner = null;
          if (hasScripts) {
            try {
              runner = await getScriptRunner();
            } catch (e) {
              note = `Form scripts disabled: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          forms = new FormStore(model, runner);
        }
        renderBytes = await stripMarkupAnnotations(bytes, { formWidgets: !!forms });
        outline = await readOutline(bytes).catch(() => []);
      } catch (e) {
        note = `Annotations/forms unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (cancelled) return;
      baseRef.current = bytes;
      setDirty(false);
      setModified(pendingModified.current);
      pendingModified.current = false;
      setPrepared({ bytes, renderBytes, store, forms, outline, note });
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  // ---- open the documents. Text (for text layer + search) always comes from PDF.js.
  useEffect(() => {
    if (!prepared) return;
    let cancelled = false;
    const docs: PdfDocument[] = [];
    (async () => {
      try {
        const t = performance.now();
        const render = await (await getEngine(engineId)).open(prepared.renderBytes);
        docs.push(render);
        let text: PdfDocument | null = render;
        if (engineId !== 'pdfjs') {
          text = await (await getEngine('pdfjs')).open(prepared.renderBytes);
          docs.push(text);
        }
        if (cancelled) return docs.forEach((d) => d.close());
        setOpened({ render, text });
        setStatus(
          `${render.pageCount} pages · opened in ${(performance.now() - t).toFixed(0)} ms` + (prepared.note ? ` · ${prepared.note}` : ''),
        );
      } catch (e) {
        setStatus(`Failed to open: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      setOpened(null);
      setTimeout(() => docs.forEach((d) => d.close()), 0); // after the viewer has unmounted
    };
  }, [prepared, engineId]);

  useEffect(() => {
    openedRef.current = opened;
  }, [opened]);

  // ---- dirty tracking + unload guard
  const store = prepared?.store ?? null;
  const formStore = prepared?.forms ?? null;
  const [formDirty, setFormDirty] = useState(false);
  useEffect(() => {
    if (!store) return;
    const sync = () => setDirty(store.isDirty);
    sync();
    return store.subscribe(sync);
  }, [store]);
  useEffect(() => {
    setFormDirty(false);
    if (!formStore) return;
    const sync = () => setFormDirty(formStore.isDirty);
    return formStore.subscribe(sync);
  }, [formStore]);
  const anyDirty = dirty || formDirty || modified;
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);

  const onAuthorChange = useCallback((name: string) => {
    setAuthor(name);
    try {
      localStorage.setItem(AUTHOR_KEY, name);
    } catch {
      /* storage unavailable */
    }
  }, []);

  /** Apply pending form values and annotations to `base`; optionally flatten the form. */
  const build = useCallback(
    async (base: Uint8Array, flatten: boolean) => {
      let out = base;
      if (formStore && (formStore.isDirty || flatten)) {
        const { values, display } = formStore.pendingWrite();
        out = await writeForm(out, { values, display, flatten });
      }
      if (store) out = await writeAnnotations(out, store.getAll(), store.touchedIds);
      return out;
    },
    [store, formStore],
  );

  const deliver = useCallback(async (out: Uint8Array, name: string) => {
    const d = desktop();
    return d ? (await d.saveFile(name, out)) !== null : saveInBrowser(out, name);
  }, []);

  const save = useCallback(async () => {
    if (!baseRef.current || saving) return;
    setSaving(true);
    try {
      const out = await build(baseRef.current, false);
      const suggested = fileName.replace(/\.pdf$/i, '') + '.pdf';
      if (await deliver(out, suggested)) {
        baseRef.current = out;
        store?.markSaved();
        formStore?.markSaved();
        setModified(false);
        setStatus(`Saved ${suggested} (${(out.length / 1024).toFixed(0)} KB)`);
      }
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [build, deliver, fileName, saving, store, formStore]);

  /** Save a flattened copy; the open document stays fillable. */
  const flatten = useCallback(async () => {
    if (!baseRef.current || saving) return;
    setSaving(true);
    try {
      const out = await build(baseRef.current, true);
      const name = fileName.replace(/\.pdf$/i, '') + '-flattened.pdf';
      if (await deliver(out, name)) setStatus(`Saved flattened copy ${name}`);
    } catch (e) {
      setStatus(`Flatten failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [build, deliver, fileName, saving]);

  const exportData = useCallback(() => {
    if (!formStore) return;
    const json = JSON.stringify(formStore.exportData(), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName.replace(/\.pdf$/i, '') + '-data.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [formStore, fileName]);

  const formSupport = useMemo(
    () => (formStore ? { store: formStore, onFlatten: flatten, onExport: exportData } : undefined),
    [formStore, flatten, exportData],
  );

  // ---------------------------------------------------------------- page tools
  const baseName = fileName.replace(/\.pdf$/i, '');

  /** Flush pending form/annotation edits into the bytes, run `fn`, and reload the result as the new document. */
  const runEdit = useCallback(
    async (fn: (bytes: Uint8Array) => Promise<Uint8Array>) => {
      if (!baseRef.current) return;
      setPageBusy(true);
      try {
        const flushed = await build(baseRef.current, false);
        const out = await fn(flushed);
        setHistory((h) => ({ undo: [...h.undo.slice(-9), flushed], redo: [] }));
        pendingModified.current = true;
        setBytes(out);
      } catch (e) {
        setStatus(`Page operation failed: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      } finally {
        setPageBusy(false);
      }
    },
    [build],
  );

  const stepHistory = useCallback(
    async (dir: 'undo' | 'redo') => {
      if (!baseRef.current) return;
      const from = dir === 'undo' ? history.undo : history.redo;
      const target = from[from.length - 1];
      if (!target) return;
      setPageBusy(true);
      try {
        const current = await build(baseRef.current, false);
        setHistory(
          dir === 'undo'
            ? { undo: history.undo.slice(0, -1), redo: [...history.redo, current] }
            : { undo: [...history.undo, current], redo: history.redo.slice(0, -1) },
        );
        pendingModified.current = true;
        setBytes(target);
      } finally {
        setPageBusy(false);
      }
    },
    [build, history],
  );

  const pageTools = useMemo<PageTools | undefined>(() => {
    if (!prepared) return undefined;
    return {
      fileName: fileName || 'document.pdf',
      busy: pageBusy || saving,
      outline: prepared.outline,
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
      onUndo: () => void stepHistory('undo'),
      onRedo: () => void stepHistory('redo'),
      onApplyPlan: (items) => runEdit((b) => assemble([b], items)),
      onExtract: async (items) => {
        if (!baseRef.current) return;
        const flushed = await build(baseRef.current, false);
        const out = await assemble([flushed], items);
        if (await deliver(out, `${baseName}-extract.pdf`)) setStatus(`Extracted ${items.length} page(s)`);
      },
      onInsertFile: (plan, afterIndex, file) =>
        runEdit(async (b) => {
          const extra = new Uint8Array(await file.arrayBuffer());
          const current = isIdentity(plan, await countPages(b)) ? b : await assemble([b], plan);
          const n = plan.length;
          const base = identityPlan(n);
          const added = itemsFromSource(1, Array.from({ length: await countPages(extra) }, (_, i) => i));
          return assemble([current, extra], [...base.slice(0, afterIndex + 1), ...added, ...base.slice(afterIndex + 1)]);
        }),
      onCombine: (entries) =>
        runEdit(async (b) => {
          const sources: Uint8Array[] = [];
          const items: PlanItem[] = [];
          for (const e of entries) {
            const bytes = e.file ? new Uint8Array(await e.file.arrayBuffer()) : b;
            const src = sources.length;
            sources.push(bytes);
            const count = await countPages(bytes);
            items.push(...itemsFromSource(src, parseRanges(e.ranges, count)));
          }
          return assemble(sources, items);
        }),
      onSplit: async (spec) => {
        if (!baseRef.current) return;
        const flushed = await build(baseRef.current, false);
        const groups = planSplit(await countPages(flushed), spec, prepared.outline);
        const parts = await splitPdf(flushed, groups, baseName);
        if (parts.length === 1) {
          if (await deliver(parts[0]!.data, parts[0]!.name)) setStatus(`Saved ${parts[0]!.name}`);
        } else if (await deliver(makeZip(parts), `${baseName}-split.zip`)) setStatus(`Saved ${parts.length} files as ${baseName}-split.zip`);
      },
      onCrop: (pages, margins) => runEdit((b) => cropPages(b, pages, margins)),
      onResetCrop: (pages) => runEdit((b) => resetCrop(b, pages)),
      onHeaderFooter: (spec) => runEdit((b) => addHeaderFooter(b, { ...spec, fileName })),
      onWatermark: (spec) => runEdit((b) => addWatermark(b, spec)),
      autoCropMargins: async (page) => {
        const doc = openedRef.current?.render;
        if (!doc) throw new Error('Document is not open');
        const p = await doc.getPage(page);
        try {
          const bmp = await p.render({ scale: 1 });
          return detectMargins(bmp.data, bmp.width, bmp.height, 1);
        } finally {
          p.close();
        }
      },
    };
  }, [prepared, fileName, pageBusy, saving, history, stepHistory, runEdit, build, deliver, baseName]);

  const annotations = useMemo(
    () => (store ? { store, author, onAuthorChange, onSave: save, saving, extraDirty: formDirty } : undefined),
    [store, author, onAuthorChange, save, saving, formDirty],
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>
        <strong>PDF Suite</strong>
        {desktop() ? (
          <button onClick={openNative}>Open…</button>
        ) : (
          <input type="file" accept="application/pdf" onChange={(e) => onFile(e.target.files?.[0])} />
        )}
        <select value={engineId} onChange={(e) => setEngineId(e.target.value as EngineId)} aria-label="Render engine">
          <option value="pdfium">PDFium (WASM)</option>
          <option value="pdfjs">PDF.js</option>
        </select>
        <span style={{ marginLeft: 'auto', color: '#555', fontSize: 12 }}>
          {fileName}
          {anyDirty ? ' •' : ''}
        </span>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        {opened ? (
          <PdfViewer doc={opened.render} textDoc={opened.text} annotations={annotations} forms={formSupport} pages={pageTools} />
        ) : (
          <p style={{ padding: 16, color: '#555' }}>{status}</p>
        )}
      </main>
      {opened && <footer style={{ padding: '2px 8px', borderTop: '1px solid #ccc', fontSize: 12 }}>{status}</footer>}
    </div>
  );
}

/** File System Access API when available, otherwise a download. Returns false if the user cancelled. */
async function saveInBrowser(bytes: Uint8Array, name: string): Promise<boolean> {
  const zip = /\.zip$/i.test(name);
  const mime = zip ? 'application/zip' : 'application/pdf';
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: BlobPart): Promise<void>; close(): Promise<void> }> }>;
  };
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: zip ? 'ZIP archive' : 'PDF', accept: { [mime]: [zip ? '.zip' : '.pdf'] } }] });
      const stream = await handle.createWritable();
      await stream.write(blob);
      await stream.close();
      return true;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return false;
      // fall through to download on other failures (e.g. iframe/permissions)
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
