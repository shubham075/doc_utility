import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnnotationStore, readAnnotations, stripMarkupAnnotations, writeAnnotations } from '@pdfsuite/annotations';
import type { PdfDocument } from '@pdfsuite/engine';
import { PdfViewer } from '@pdfsuite/viewer';
import { desktop } from './desktop-bridge';
import { getEngine, type EngineId } from './engines';

interface Prepared {
  bytes: Uint8Array;
  /** Copy of the file without markup annotations: the viewer draws those itself from the store. */
  renderBytes: Uint8Array;
  store: AnnotationStore | null;
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

  const load = useCallback((data: Uint8Array, name: string) => {
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
      let renderBytes = bytes;
      let note: string | undefined;
      try {
        const { annotations } = await readAnnotations(bytes);
        store = new AnnotationStore(annotations);
        renderBytes = await stripMarkupAnnotations(bytes);
      } catch (e) {
        note = `Annotations unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (cancelled) return;
      baseRef.current = bytes;
      setDirty(false);
      setPrepared({ bytes, renderBytes, store, note });
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

  // ---- dirty tracking + unload guard
  const store = prepared?.store ?? null;
  useEffect(() => {
    if (!store) return;
    const sync = () => setDirty(store.isDirty);
    sync();
    return store.subscribe(sync);
  }, [store]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const onAuthorChange = useCallback((name: string) => {
    setAuthor(name);
    try {
      localStorage.setItem(AUTHOR_KEY, name);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const save = useCallback(async () => {
    if (!store || !baseRef.current || saving) return;
    setSaving(true);
    try {
      const out = await writeAnnotations(baseRef.current, store.getAll(), store.touchedIds);
      const suggested = fileName.replace(/\.pdf$/i, '') + '.pdf';
      let saved = false;
      const d = desktop();
      if (d) {
        saved = (await d.saveFile(suggested, out)) !== null;
      } else {
        saved = await saveInBrowser(out, suggested);
      }
      if (saved) {
        baseRef.current = out;
        store.markSaved();
        setStatus(`Saved ${suggested} (${(out.length / 1024).toFixed(0)} KB)`);
      }
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [store, fileName, saving]);

  const annotations = useMemo(
    () => (store ? { store, author, onAuthorChange, onSave: save, saving } : undefined),
    [store, author, onAuthorChange, save, saving],
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
          {dirty ? ' •' : ''}
        </span>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        {opened ? (
          <PdfViewer doc={opened.render} textDoc={opened.text} annotations={annotations} />
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
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: BlobPart): Promise<void>; close(): Promise<void> }> }>;
  };
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
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
