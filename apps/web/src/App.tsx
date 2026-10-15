import { useCallback, useEffect, useState } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
import { PdfViewer } from '@pdfsuite/viewer';
import { desktop } from './desktop-bridge';
import { getEngine, type EngineId } from './engines';

interface Opened {
  render: PdfDocument;
  text: PdfDocument | null;
}

export function App() {
  const [engineId, setEngineId] = useState<EngineId>('pdfium');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('');
  const [opened, setOpened] = useState<Opened | null>(null);
  const [status, setStatus] = useState('Open a PDF to begin.');

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

  // Files opened via OS association / second app instance (desktop shell).
  useEffect(() => desktop()?.onFileOpened((f) => load(f.bytes, f.name)), [load]);

  // Optional ?pdf=<url> to auto-open a document (handy for dev/testing).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('pdf');
    if (!url) return;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => load(new Uint8Array(b), url))
      .catch((e) => setStatus(`Fetch failed: ${String(e)}`));
  }, [load]);

  // (Re)open whenever the file or engine changes. Text (for text layer + search) always comes from PDF.js.
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    const docs: PdfDocument[] = [];
    (async () => {
      try {
        const t = performance.now();
        const render = await (await getEngine(engineId)).open(bytes);
        docs.push(render);
        let text: PdfDocument | null = render;
        if (engineId !== 'pdfjs') {
          text = await (await getEngine('pdfjs')).open(bytes);
          docs.push(text);
        }
        if (cancelled) return docs.forEach((d) => d.close());
        setOpened({ render, text });
        setStatus(`${render.pageCount} pages · opened in ${(performance.now() - t).toFixed(0)} ms`);
      } catch (e) {
        setStatus(`Failed to open: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      setOpened(null);
      // Close after React has unmounted the viewer that was using them.
      setTimeout(() => docs.forEach((d) => d.close()), 0);
    };
  }, [bytes, engineId]);

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
        <span style={{ marginLeft: 'auto', color: '#555', fontSize: 12 }}>{fileName}</span>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        {opened ? (
          <PdfViewer doc={opened.render} textDoc={opened.text} />
        ) : (
          <p style={{ padding: 16, color: '#555' }}>{status}</p>
        )}
      </main>
      {opened && <footer style={{ padding: '2px 8px', borderTop: '1px solid #ccc', fontSize: 12 }}>{status}</footer>}
    </div>
  );
}
