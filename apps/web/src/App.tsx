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
import {
  ALL_PERMISSIONS,
  AuditLog,
  LocalAuditStore,
  PasswordError,
  auditToCsv,
  certificateFromBytes,
  certificateToPem,
  createSelfSignedIdentity,
  decryptPdf,
  encryptPdf,
  examineDocument,
  loadPkcs12,
  nameOf,
  readEncryptionInfo,
  redactPdf,
  sanitizePdf,
  signPdf,
  verifySignatures,
  certificateFromPem,
  type AuditAction,
  type Permissions,
} from '@pdfsuite/security';
import {
  addImage,
  addLink,
  addShape,
  addText,
  cropImage,
  deleteLink,
  deleteObjects,
  editText,
  exportImage,
  listPageLinks,
  listPageObjects,
  moveResizeObjects,
  replaceImage,
  updateLink,
} from '@pdfsuite/editor';
import { Modal, PdfViewer, type ConvertTools, type EditTools, type PageTools, type SecurityTools } from '@pdfsuite/viewer';
import { exportImages, exportText, imagesToPdf, optimizePdf, zipFiles, type SourceImage } from '@pdfsuite/convert';
import { createTesseractRecognizer, ocrPdf } from '@pdfsuite/ocr';
import { browserEncoder, browserJpegDecoder, browserRecompressor, toPdfImage } from './browserImage';
import { getCapabilities, postAudit, runJob, type Capabilities } from './services';
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
  /** The file carries digital signatures that a rewrite would invalidate. */
  signed: boolean;
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

const fontFiles = new Map<string, Promise<Uint8Array>>();
/** Bundled fallback font (Liberation Sans, copied to /fonts by the build) for characters an embedded font lacks. */
const fallbackFont = ({ bold, italic }: { bold: boolean; italic: boolean }) => {
  const file = `LiberationSans-${bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular'}.ttf`;
  let p = fontFiles.get(file);
  if (!p) {
    p = fetch(new URL(`/fonts/${file}`, location.href))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('The fallback font could not be loaded.'))))
      .then((b) => new Uint8Array(b));
    p.catch(() => fontFiles.delete(file));
    fontFiles.set(file, p);
  }
  return p;
};

const TRUST_KEY = 'pdfsuite.trust';
interface Trusted {
  name: string;
  pem: string;
}
const loadTrusted = (): Trusted[] => {
  try {
    return JSON.parse(localStorage.getItem(TRUST_KEY) ?? '[]') as Trusted[];
  } catch {
    return [];
  }
};
const safeStorage = {
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage unavailable: the audit trail then lives only in the server copy */
    }
  },
};
const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
const hasSignature = (b: Uint8Array) => /\/ByteRange\s*\[/.test(new TextDecoder('latin1').decode(b));

interface Protection {
  userPassword: string;
  ownerPassword: string;
  permissions: Permissions;
  /** The owner password is known: restrictions can be changed or lifted. */
  ownerKnown: boolean;
}

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
  /** Result of the last convert/compress/OCR run (the dialog itself is gone once the document reloads). */
  const [notice, setNotice] = useState<string | null>(null);
  const pendingModified = useRef(false);
  const openedRef = useRef<Opened | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [permissions, setPermissions] = useState<Permissions>(ALL_PERMISSIONS);
  const permissionsRef = useRef(permissions);
  const [pwPrompt, setPwPrompt] = useState<{ data: Uint8Array; name: string; error?: string } | null>(null);
  const [trusted, setTrusted] = useState<Trusted[]>(loadTrusted);
  const authorRef = useRef('User');
  const capsRef = useRef<Capabilities | null>(null);

  const auditLog = useMemo(() => {
    const log = new AuditLog(new LocalAuditStore(safeStorage, 'pdfsuite.audit', 2000), () => authorRef.current);
    log.onEntry = (e) => {
      if (capsRef.current) void postAudit({ action: e.action, doc: e.doc, details: e.details });
    };
    return log;
  }, []);
  const audit = useCallback(
    (action: AuditAction, info?: { doc?: { name: string; bytes?: Uint8Array }; details?: Record<string, string | number | boolean> }) => {
      void auditLog.record(action, info).catch(() => undefined);
    },
    [auditLog],
  );

  const loadPlain = useCallback((data: Uint8Array, name: string) => {
    setHistory({ undo: [], redo: [] });
    pendingModified.current = false;
    setEpoch((n) => n + 1);
    setBytes(data);
    setFileName(name);
  }, []);

  /** Opens a file; encrypted files are decrypted in memory (asking for a password if needed). */
  const load = useCallback(
    async (data: Uint8Array, name: string, password = '') => {
      let info = null;
      try {
        info = readEncryptionInfo(data);
      } catch {
        /* not parseable: let the viewer report it */
      }
      if (!info) {
        setProtection(null);
        setPermissions(ALL_PERMISSIONS);
        setPwPrompt(null);
        audit('document.open', { doc: { name, bytes: data } });
        loadPlain(data, name);
        return;
      }
      try {
        const r = await decryptPdf(data, password);
        setPwPrompt(null);
        setProtection({ userPassword: password, ownerPassword: r.ownerAuthenticated && password ? password : randomPassword(), permissions: r.info.permissions, ownerKnown: r.ownerAuthenticated });
        setPermissions(r.ownerAuthenticated ? ALL_PERMISSIONS : r.info.permissions);
        audit('document.decrypt', { doc: { name, bytes: data }, details: { owner: r.ownerAuthenticated } });
        loadPlain(r.bytes, name);
      } catch (e) {
        if (e instanceof PasswordError) setPwPrompt({ data, name, error: password ? 'Incorrect password.' : undefined });
        else setStatus(`Cannot open ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [audit, loadPlain],
  );

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (file) await load(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [load],
  );

  const openNative = useCallback(async () => {
    const [f] = (await desktop()?.openFileDialog()) ?? [];
    if (f) await load(f.bytes, f.name);
  }, [load]);

  useEffect(() => desktop()?.onFileOpened((f) => void load(f.bytes, f.name)), [load]);

  // Optional ?pdf=<url> to auto-open a document (handy for dev/testing).
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('pdf');
    if (!url) return;
    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((b) => load(new Uint8Array(b), url.split('/').pop() || url))
      .catch((e) => setStatus(`Fetch failed: ${String(e)}`));
  }, [load]);

  const engineIdRef = useRef(engineId);
  engineIdRef.current = engineId;
  const preparedRef = useRef<Prepared | null>(null);

  /** Open the render copy (and the PDF.js copy for text) of a prepared document. */
  const openDocs = useCallback(async (p: Prepared, id: EngineId): Promise<Opened> => {
    const render = await (await getEngine(id)).open(p.renderBytes);
    let text: PdfDocument | null = render;
    if (id !== 'pdfjs') {
      try {
        text = await (await getEngine('pdfjs')).open(p.renderBytes);
      } catch (e) {
        render.close();
        throw e;
      }
    }
    return { render, text };
  }, []);
  /** Old documents are closed after the viewer has switched to the new ones. */
  const closeOpened = useCallback((o: Opened | null) => {
    if (!o) return;
    setTimeout(() => {
      o.render.close();
      if (o.text && o.text !== o.render) o.text.close();
    }, 600);
  }, []);

  // ---- prepare: read annotations once per file, build the render copy, open it, then switch the viewer over in one step
  // (the previous document stays on screen meanwhile, so edits keep zoom, scroll position and tool state)
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
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
        const p = permissionsRef.current;
        if (model.hasForm && model.fields.length && (p.fillForms || p.modify || p.annotate)) {
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
      const next: Prepared = { bytes, renderBytes, store, forms, outline, signed: hasSignature(bytes), note };
      let o: Opened | null = null;
      let failure: string | null = null;
      const t = performance.now();
      try {
        o = await openDocs(next, engineIdRef.current);
      } catch (e) {
        failure = `Failed to open: ${String(e)}`;
      }
      if (cancelled) {
        closeOpened(o);
        return;
      }
      const old = openedRef.current;
      baseRef.current = bytes;
      preparedRef.current = next;
      setDirty(false);
      setModified(pendingModified.current);
      pendingModified.current = false;
      setPrepared(next);
      setOpened(o);
      closeOpened(old);
      setStatus(o ? `${o.render.pageCount} pages · opened in ${(performance.now() - t).toFixed(0)} ms` + (note ? ` · ${note}` : '') : failure!);
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, openDocs, closeOpened]);

  // ---- switching the render engine re-opens the current document
  const firstEngine = useRef(true);
  useEffect(() => {
    if (firstEngine.current) {
      firstEngine.current = false;
      return;
    }
    const p = preparedRef.current;
    if (!p) return;
    let cancelled = false;
    openDocs(p, engineId).then(
      (o) => {
        if (cancelled) return closeOpened(o);
        const old = openedRef.current;
        setOpened(o);
        closeOpened(old);
      },
      (e) => setStatus(`Failed to open: ${String(e)}`),
    );
    return () => {
      cancelled = true;
    };
  }, [engineId, openDocs, closeOpened]);
  useEffect(() => () => closeOpened(openedRef.current), [closeOpened]);

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

  useEffect(() => {
    permissionsRef.current = permissions;
  }, [permissions]);
  useEffect(() => {
    authorRef.current = author;
  }, [author]);
  const signedRef = useRef(false);
  signedRef.current = prepared?.signed ?? false;

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
      if (!flatten && !formStore?.isDirty && !store?.isDirty) return base;
      if (formStore && (formStore.isDirty || flatten)) {
        const { values, display } = formStore.pendingWrite();
        out = await writeForm(out, { values, display, flatten });
      }
      if (store) out = await writeAnnotations(out, store.getAll(), store.touchedIds);
      return out;
    },
    [store, formStore],
  );

  const deliver = useCallback(
    async (out: Uint8Array, name: string) => {
      let data = out;
      if (protection && /\.pdf$/i.test(name)) data = await encryptPdf(out, { userPassword: protection.userPassword, ownerPassword: protection.ownerPassword, permissions: protection.permissions });
      const d = desktop();
      return d ? (await d.saveFile(name, data)) !== null : saveInBrowser(data, name);
    },
    [protection],
  );

  const save = useCallback(async () => {
    if (!baseRef.current || saving) return;
    if (signedRef.current && (dirty || formDirty) && !window.confirm('This document is signed. Saving your edits invalidates its signatures. Continue?')) return;
    setSaving(true);
    try {
      const out = await build(baseRef.current, false);
      const suggested = fileName.replace(/\.pdf$/i, '') + '.pdf';
      if (await deliver(out, suggested)) {
        audit('document.save', { doc: { name: suggested, bytes: out }, details: { encrypted: !!protection } });
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
  }, [audit, build, deliver, dirty, formDirty, fileName, protection, saving, store, formStore]);

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
    async (fn: (bytes: Uint8Array) => Promise<Uint8Array>, opts: { keepSignatures?: boolean } = {}) => {
      if (!baseRef.current) return;
      if (signedRef.current && !opts.keepSignatures && !window.confirm('This document is signed. This change invalidates its signatures. Continue?')) return;
      setPageBusy(true);
      try {
        const flushed = await build(baseRef.current, false);
        const out = await fn(flushed);
        if (out === flushed) return; // nothing changed: keep history clean
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

  // ---------------------------------------------------------------- convert / compress / OCR
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => {
    void getCapabilities().then((c) => {
      capsRef.current = c;
      setCaps(c);
    });
  }, []);

  /** Open the current document (with pending edits applied) in a throw-away engine instance. */
  const withFlushedDoc = useCallback(
    async <T,>(fn: (doc: PdfDocument, bytes: Uint8Array) => Promise<T>): Promise<T> => {
      if (!baseRef.current) throw new Error('No document is open');
      const flushed = await build(baseRef.current, false);
      const doc = await (await getEngine('pdfium')).open(flushed);
      try {
        return await fn(doc, flushed);
      } finally {
        doc.close();
      }
    },
    [build],
  );

  const convertTools = useMemo<ConvertTools>(() => {
    const kindOf = (f: File) => {
      const n = f.name.toLowerCase();
      if (f.type.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp|avif)$/.test(n)) return 'image' as const;
      if (/\.pdf$/.test(n) || f.type === 'application/pdf') return 'pdf' as const;
      if (/\.(html?|xhtml)$/.test(n)) return 'html' as const;
      return 'office' as const;
    };
    return {
      server: caps ? { office: caps['office-to-pdf'], html: caps['html-to-pdf'], compress: caps.compress, ocr: caps.ocr } : null,
      canScan: !!desktop()?.scan,
      onScan: async () => {
        const bytes = await desktop()?.scan?.();
        return bytes ? new File([bytes as BlobPart], `scan-${Date.now()}.png`, { type: 'image/png' }) : null;
      },

      onCreate: async (files, opts, progress) => {
        const parts: Uint8Array[] = [];
        let images: SourceImage[] = [];
        const flushImages = async () => {
          if (!images.length) return;
          parts.push(await imagesToPdf(images, { pageSize: opts.pageSize }));
          images = [];
        };
        for (let i = 0; i < files.length; i++) {
          const f = files[i]!;
          progress(i / files.length, f.name);
          const kind = kindOf(f);
          if (kind === 'image') {
            images.push(await toPdfImage(f));
            continue;
          }
          await flushImages();
          const data = new Uint8Array(await f.arrayBuffer());
          if (kind === 'pdf') parts.push(data);
          else parts.push((await runJob(kind === 'html' ? 'html-to-pdf' : 'office-to-pdf', { name: f.name, data }, {}, { onProgress: (p) => progress((i + p) / files.length, f.name) })).data);
        }
        await flushImages();
        progress(1, 'Assembling');
        const counts = await Promise.all(parts.map(countPages));
        const merged =
          parts.length === 1
            ? parts[0]!
            : await assemble(parts, parts.flatMap((_, k) => itemsFromSource(k, Array.from({ length: counts[k]! }, (_, p) => p))));
        if (opts.mode === 'new') {
          if (anyDirty && !window.confirm('Discard the unsaved changes in the current document?')) return;
          load(merged, files[0]!.name.replace(/\.[^.]+$/, '') + '.pdf');
        } else {
          await runEdit(async (b) => {
            const n = await countPages(b);
            const m = await countPages(merged);
            return assemble([b, merged], [...itemsFromSource(0, Array.from({ length: n }, (_, k) => k)), ...itemsFromSource(1, Array.from({ length: m }, (_, k) => k))]);
          });
        }
      },

      onExport: async (kind, pages, opts, progress) => {
        await withFlushedDoc(async (doc) => {
          if (kind === 'text') {
            audit('document.export', { doc: { name: fileName }, details: { kind, pages: pages.length } });
            const text = await exportText(doc, pages, (d, t) => progress(d / t));
            await deliver(new TextEncoder().encode(text), `${baseName}.txt`);
            return;
          }
          audit('document.export', { doc: { name: fileName }, details: { kind, pages: pages.length } });
          const files = await exportImages(doc, pages, { ...opts, baseName }, browserEncoder, (d, t) => progress(d / t, `Page ${d} of ${t}`));
          if (files.length === 1) await deliver(files[0]!.data, files[0]!.name);
          else await deliver(zipFiles(files), `${baseName}-images.zip`);
        });
      },

      onCompress: async (opts, progress) => {
        let sizes = { before: 0, after: 0 };
        await runEdit(async (b) => {
          sizes = { before: b.length, after: b.length };
          let out: Uint8Array;
          if (opts.where === 'server') {
            out = (await runJob('compress', { name: fileName || 'document.pdf', data: b }, { preset: opts.preset, stripMetadata: opts.stripMetadata, removeThumbnails: opts.removeThumbnails }, { onProgress: (p) => progress(p) })).data;
          } else {
            out = (await optimizePdf(b, { preset: opts.preset, stripMetadata: opts.stripMetadata, removeThumbnails: opts.removeThumbnails, recompress: browserRecompressor, onProgress: (d, t) => progress(d / Math.max(1, t), 'Optimizing images') })).bytes;
          }
          sizes.after = Math.min(out.length, b.length);
          return out.length < b.length ? out : b;
        });
        const kbs = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
        setNotice(sizes.after < sizes.before ? `Compressed from ${kbs(sizes.before)} to ${kbs(sizes.after)} (${Math.round((1 - sizes.after / sizes.before) * 100)}% smaller)` : `No further savings possible (${kbs(sizes.before)})`);
        return sizes;
      },

      onOcr: async (opts, progress, signal) => {
        let outcome = { pages: 0, words: 0 };
        await runEdit(async (b) => {
          if (opts.where === 'server') {
            const r = await runJob('ocr', { name: fileName || 'document.pdf', data: b }, { pages: opts.pages.map((p) => p + 1), dpi: opts.dpi, skipPagesWithText: opts.skipPagesWithText }, { onProgress: (p) => progress(p), signal });
            outcome = { pages: opts.pages.length, words: 0 };
            return r.data;
          }
          const doc = await (await getEngine('pdfium')).open(b);
          progress(0, 'Loading OCR engine');
          const recognizer = await createTesseractRecognizer({
            langPath: new URL('/ocr/lang', location.href).href,
            workerPath: new URL('/ocr/worker.min.js', location.href).href,
            corePath: new URL('/ocr/', location.href).href,
          });
          try {
            const r = await ocrPdf(b, doc, recognizer, {
              pages: opts.pages,
              dpi: opts.dpi,
              skipPagesWithText: opts.skipPagesWithText,
              signal,
              onProgress: (d, t, page) => progress(d / t, `Page ${page + 1} (${d} of ${t})`),
              renderPng: async (d, index, scale) => {
                const p = await d.getPage(index);
                try {
                  return await browserEncoder(await p.render({ scale }), 'png', 1);
                } finally {
                  p.close();
                }
              },
            });
            outcome = { pages: r.pagesProcessed, words: r.words };
            return r.pagesProcessed ? r.bytes : b;
          } finally {
            await recognizer.terminate();
            doc.close();
          }
        });
        setNotice(outcome.pages ? `Text recognized on ${outcome.pages} page(s)${outcome.words ? ` (${outcome.words} words)` : ''}` : 'Nothing to recognize: the chosen pages already have text');
        return outcome;
      },
    };
  }, [audit, caps, anyDirty, baseName, build, deliver, fileName, load, runEdit, withFlushedDoc]);

  // ---------------------------------------------------------------- security
  const flushed = useCallback(async () => {
    if (!baseRef.current) throw new Error('No document is open');
    return build(baseRef.current, false);
  }, [build]);

  const securityTools = useMemo<SecurityTools | undefined>(() => {
    if (!prepared) return undefined;
    const n = (v: number) => v;
    return {
      busy: pageBusy || saving,
      permissions,
      protection: protection ? { hasUserPassword: !!protection.userPassword, ownerKnown: protection.ownerKnown } : null,
      signed: prepared.signed,
      trusted: trusted.map((t) => t.name),

      onProtect: async (r) => {
        if (protection && !protection.ownerKnown) throw new Error('This document was opened with the open password only. Reopen it with its permissions password to change the protection.');
        if (signedRef.current && !window.confirm('This document is signed. Protecting it invalidates the signatures. Continue?')) throw new Error('Cancelled');
        setProtection({ userPassword: r.userPassword, ownerPassword: r.ownerPassword, permissions: r.permissions, ownerKnown: true });
        setModified(true);
        audit('document.encrypt', { doc: { name: fileName }, details: { openPassword: !!r.userPassword } });
        setNotice('Password protection (AES-256) will be applied when you save.');
      },
      onRemoveProtection: async () => {
        if (!protection?.ownerKnown) throw new Error('Only the permissions password can remove the protection.');
        setProtection(null);
        setModified(true);
        audit('document.decrypt', { doc: { name: fileName }, details: { removedProtection: true } });
        setNotice('Protection will be removed when you save.');
      },

      examine: async () => examineDocument(await flushed()),
      onSanitize: async (opts) => {
        let removed = {} as Awaited<ReturnType<typeof sanitizePdf>>['removed'];
        await runEdit(async (b) => {
          const r = await sanitizePdf(b, opts);
          removed = r.removed;
          return r.bytes;
        });
        const total = Object.values(removed).reduce<number>((a, v) => a + n(v ?? 0), 0);
        audit('document.sanitize', { doc: { name: fileName }, details: { removed: total } });
        setNotice(total ? `Sanitized: removed ${total} item(s). Save to keep the result.` : 'Nothing to remove.');
        return removed;
      },

      onApplyRedactions: async (marks) => {
        let report!: Awaited<ReturnType<typeof redactPdf>>['report'];
        await runEdit(async (b) => {
          const r = await redactPdf(b, marks, { decodeJpeg: browserJpegDecoder });
          report = r.report;
          return r.bytes;
        });
        audit('document.redact', { doc: { name: fileName }, details: { pages: report.pages, glyphs: report.glyphsRemoved, images: report.imagesRedacted + report.imagesRemoved + report.inlineImagesRemoved, shapes: report.pathsRemoved } });
        setNotice(`Redaction applied: ${report.glyphsRemoved} characters, ${report.imagesRedacted + report.imagesRemoved + report.inlineImagesRemoved} images and ${report.pathsRemoved} shapes permanently removed. Save to keep the result.`);
        return report;
      },

      onSign: async (r) => {
        if (protection) throw new Error('Remove the password protection before signing (signing and encrypting cannot be combined here).');
        const identity = r.identity.kind === 'pfx' ? loadPkcs12(new Uint8Array(await r.identity.file.arrayBuffer()), r.identity.password) : createSelfSignedIdentity({ commonName: r.identity.commonName });
        await runEdit((b) => signPdf(b, { identity, reason: r.reason || undefined, location: r.location || undefined, visible: r.visible }), { keepSignatures: true });
        const signer = nameOf(identity.certificate.subject.attributes);
        audit('document.sign', { doc: { name: fileName }, details: { signer, visible: !!r.visible } });
        setNotice(`Signed as ${signer}. Save to keep the signed copy; any later change invalidates the signature.`);
      },
      verify: async () => {
        if (!baseRef.current) return [];
        return verifySignatures(baseRef.current, { trustedRoots: trusted.map((t) => certificateFromPem(t.pem)) });
      },
      onAddTrust: async (file) => {
        const cert = certificateFromBytes(new Uint8Array(await file.arrayBuffer()));
        const next = [...trusted, { name: nameOf(cert.subject.attributes), pem: certificateToPem(cert) }];
        setTrusted(next);
        safeStorage.setItem(TRUST_KEY, JSON.stringify(next));
      },
      onRemoveTrust: (i) => {
        const next = trusted.filter((_, k) => k !== i);
        setTrusted(next);
        safeStorage.setItem(TRUST_KEY, JSON.stringify(next));
      },

      auditEntries: () => auditLog.entries(),
      auditVerify: () => auditLog.verify(),
      onAuditExport: async () => {
        await deliver(new TextEncoder().encode(auditToCsv(await auditLog.entries())), 'pdfsuite-audit-log.csv');
      },
    };
  }, [prepared, pageBusy, saving, permissions, protection, trusted, fileName, audit, auditLog, deliver, flushed, runEdit]);

  // ---------------------------------------------------------------- content editing
  const editTools = useMemo<EditTools | undefined>(() => {
    if (!prepared || !permissions.modify) return undefined;
    const bytes = prepared.bytes;
    const name = baseName || 'document';
    return {
      busy: pageBusy || saving,
      listObjects: (page) => listPageObjects(bytes, page),
      listLinks: (page) => listPageLinks(bytes, page),
      onMove: (page, changes) => runEdit((b) => moveResizeObjects(b, page, changes)),
      onDelete: (page, ids) => runEdit((b) => deleteObjects(b, page, ids)),
      onEditText: async (page, id, text) => {
        let warnings: string[] = [];
        await runEdit(async (b) => {
          const r = await editText(b, page, id, text, { fallbackFont });
          warnings = r.warnings;
          return r.bytes;
        });
        return warnings;
      },
      onAddText: async (page, spec) => {
        let warnings: string[] = [];
        await runEdit(async (b) => {
          const r = await addText(b, page, spec, { fallbackFont });
          warnings = r.warnings;
          return r.bytes;
        });
        return warnings;
      },
      onAddImage: (page, rect, file) => runEdit(async (b) => (await addImage(b, page, rect, await toPdfImage(file))).bytes),
      onAddShape: (page, spec) => runEdit(async (b) => (await addShape(b, page, spec)).bytes),
      onReplaceImage: (page, id, file) => runEdit(async (b) => replaceImage(b, page, id, await toPdfImage(file), 'contain')),
      onCropImage: (page, id, area) => runEdit((b) => cropImage(b, page, id, area)),
      onExportImage: async (page, id) => {
        const r = await exportImage(await flushed(), page, id);
        if (await deliver(r.data, `${name}-page${page + 1}-image.${r.extension}`)) setStatus('Image exported');
      },
      onAddLink: (page, rect, target) => runEdit((b) => addLink(b, page, rect, target)),
      onUpdateLink: (page, index, target) => runEdit((b) => updateLink(b, page, index, { target })),
      onDeleteLink: (page, index) => runEdit((b) => deleteLink(b, page, index)),
    };
  }, [prepared, permissions.modify, pageBusy, saving, baseName, runEdit, flushed, deliver]);

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
          {protection ? '🔒 ' : ''}
          {fileName}
          {anyDirty ? ' •' : ''}
        </span>
      </header>
      <main style={{ flex: 1, minHeight: 0 }}>
        {opened ? (
          <PdfViewer
            doc={opened.render}
            textDoc={opened.text}
            annotations={annotations}
            forms={formSupport}
            pages={permissions.assemble || permissions.modify ? pageTools : undefined}
            convert={permissions.copy ? convertTools : undefined}
            security={securityTools}
            edit={editTools}
            resetKey={epoch}
          />
        ) : (
          <p style={{ padding: 16, color: '#555' }}>{status}</p>
        )}
      </main>
      {pwPrompt && <PasswordPrompt name={pwPrompt.name} error={pwPrompt.error} onSubmit={(pw) => void load(pwPrompt.data, pwPrompt.name, pw)} onCancel={() => setPwPrompt(null)} />}
      {notice && (
        <div role="status" style={{ padding: '4px 8px', background: '#e8f5e9', color: '#1b5e20', fontSize: 12, display: 'flex', gap: 8 }}>
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss" style={{ marginLeft: 'auto' }}>✕</button>
        </div>
      )}
      {opened && <footer style={{ padding: '2px 8px', borderTop: '1px solid #ccc', fontSize: 12 }}>{status}</footer>}
    </div>
  );
}

function PasswordPrompt({ name, error, onSubmit, onCancel }: { name: string; error?: string; onSubmit(pw: string): void; onCancel(): void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title="Password required" onClose={onCancel}>
      <p>{name} is password protected.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(pw);
        }}
      >
        <input className="pv-search-input" type="password" autoFocus autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="Document password" />
        {error && <div className="pv-error">{error}</div>}
        <div className="pv-search-row">
          <span className="pv-spacer" />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="pv-primary">
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** File System Access API when available, otherwise a download. Returns false if the user cancelled. */
async function saveInBrowser(bytes: Uint8Array, name: string): Promise<boolean> {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? 'pdf').toLowerCase();
  const mime = ({ zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', json: 'application/json' } as Record<string, string>)[ext] ?? 'application/pdf';
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(b: BlobPart): Promise<void>; close(): Promise<void> }> }>;
  };
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase() + ' file', accept: { [mime]: ['.' + ext] } }] });
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
