import { useCallback, useEffect, useRef, useState } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
import { getEngine, type EngineId } from './engines';
import { desktop } from './desktop-bridge';

export function App() {
  const [engineId, setEngineId] = useState<EngineId>('pdfium');
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [fileName, setFileName] = useState('');
  const [opened, setOpened] = useState<{ doc: PdfDocument; engineId: EngineId } | null>(null);
  const doc = opened?.doc ?? null;
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1.25);
  const [status, setStatus] = useState('Open a PDF to begin.');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBytes(new Uint8Array(await file.arrayBuffer()));
    setFileName(file.name);
    setPage(0);
  }, []);

  // Desktop shell: files opened via OS association / second instance.
  useEffect(() => {
    return desktop()?.onFileOpened((f) => {
      setBytes(f.bytes);
      setFileName(f.name);
      setPage(0);
    });
  }, []);

  const openNative = useCallback(async () => {
    const [f] = (await desktop()?.openFileDialog()) ?? [];
    if (!f) return;
    setBytes(f.bytes);
    setFileName(f.name);
    setPage(0);
  }, []);

  // Optional ?pdf=<url> to auto-open a document (handy for dev/testing).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get("pdf");
    if (!url) return;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => {
        setBytes(new Uint8Array(b));
        setFileName(url);
      })
      .catch((e) => setStatus(`Fetch failed: ${String(e)}`));
  }, []);

  // (Re)open the document when file or engine changes.
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let current: PdfDocument | null = null;
    (async () => {
      try {
        const t = performance.now();
        current = await (await getEngine(engineId)).open(bytes);
        if (cancelled) return current.close();
        setOpened({ doc: current, engineId });
        setStatus(`Opened in ${(performance.now() - t).toFixed(0)} ms`);
      } catch (e) {
        setStatus(`Failed to open: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      current?.close();
      setOpened(null);
    };
  }, [bytes, engineId]);

  // Render the current page.
  useEffect(() => {
    if (!opened) return;
    const { doc, engineId } = opened;
    let cancelled = false;
    (async () => {
      const t = performance.now();
      const p = await doc.getPage(page);
      const bmp = await p.render({ scale: zoom * (window.devicePixelRatio || 1) });
      p.close();
      if (cancelled || !canvasRef.current) return;
      const c = canvasRef.current;
      c.width = bmp.width;
      c.height = bmp.height;
      c.style.width = `${bmp.width / (window.devicePixelRatio || 1)}px`;
      c.getContext('2d')!.putImageData(new ImageData(bmp.data as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height), 0, 0);
      setStatus(`${engineId}: page ${page + 1}/${doc.pageCount} rendered in ${(performance.now() - t).toFixed(0)} ms`);
    })().catch((e) => setStatus(`Render failed: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [opened, page, zoom]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 8, borderBottom: '1px solid #ccc' }}>
        <strong>PDF Suite</strong>
        {desktop() ? (
          <button onClick={openNative}>Open…</button>
        ) : (
          <input type="file" accept="application/pdf" onChange={(e) => onFile(e.target.files?.[0])} />
        )}
        <select value={engineId} onChange={(e) => setEngineId(e.target.value as EngineId)}>
          <option value="pdfium">PDFium (WASM)</option>
          <option value="pdfjs">PDF.js</option>
        </select>
        <button disabled={!doc || page === 0} onClick={() => setPage((p) => p - 1)}>◀</button>
        <span>{doc ? `${page + 1} / ${doc.pageCount}` : '–'}</span>
        <button disabled={!doc || page + 1 >= doc.pageCount} onClick={() => setPage((p) => p + 1)}>▶</button>
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(6, z + 0.25))}>+</button>
        <span style={{ marginLeft: 'auto', color: '#555' }}>{fileName}</span>
      </header>
      <main style={{ flex: 1, overflow: 'auto', background: '#e5e5e5', padding: 16, textAlign: 'center' }}>
        <canvas ref={canvasRef} style={{ background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,.3)' }} />
      </main>
      <footer style={{ padding: '4px 8px', borderTop: '1px solid #ccc', fontSize: 12 }}>{status}</footer>
    </div>
  );
}
