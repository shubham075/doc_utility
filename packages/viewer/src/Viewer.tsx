import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
import {
  STAMP_ID_PREFIX,
  annotationBounds,
  baseFields,
  newId,
  mergeLineRects,
  type Annotation,
  type AnnotationStore,
  type MarkupType,
  type Rect,
} from '@pdfsuite/annotations';
import { AnnotationLayer } from './AnnotationLayer';
import { AnnotationToolbar } from './AnnotationToolbar';
import { CommentsPanel } from './CommentsPanel';
import { DRAW_TOOLS, MARKUP_TOOLS, STICKY_TOOLS, TOOL_DEFAULTS, type StampArm, type Tool, type ToolStyle } from './annotationTools';
import { useAnnotations, useStoreFlags } from './useAnnotationStore';
import type { FormStore } from '@pdfsuite/forms';
import { FormLayer, type WidgetRef } from './FormLayer';
import { FillSignToolbar, FormToolbar } from './FormToolbars';
import { SignatureDialog } from './SignatureDialog';
import { PageOrganizer } from './PageOrganizer';
import { CombineDialog, CropDialog, HeaderFooterDialog, SplitDialog, WatermarkDialog, type DialogKind, type PageTools } from './PageToolDialogs';
import { OutlinePanel, PageToolbar } from './PageToolbar';
import { SecurityToolbar } from './SecurityToolbar';
import { AuditDialog, ProtectDialog, RedactDialog, SanitizeDialog, SignDialog, SignaturesDialog, type SecurityDialogKind, type SecurityTools } from './SecurityDialogs';
import { CompressDialog, CreateDialog, ExportDialog, OcrDialog, type ConvertDialogKind, type ConvertTools } from './ConvertDialogs';
import { loadSignature, type SavedSignature, type SignatureKind } from './signatures';
import {
  anchorAt,
  clampZoom,
  computeLayout,
  currentPage as pageAt,
  resolveZoom,
  scrollTopFor,
  stepZoom,
  visibleRange,
  type ScrollAnchor,
  type Size,
  type ZoomMode,
} from './layout';
import { PageView } from './PageView';
import { RenderQueue } from './renderQueue';
import { SearchPanel } from './SearchPanel';
import { TextCache } from './textCache';
import { Thumbnails } from './Thumbnails';
import { useSearch } from './useSearch';
import './viewer.css';

const GAP = 12;
const PADDING = 16;

export interface PdfViewerProps {
  /** Document used for drawing pages. */
  doc: PdfDocument;
  /** Document used for text layer and search (needs `getTextItems`). May be the same object as `doc`. */
  textDoc: PdfDocument | null;
  /** Enables the annotation toolbar, overlay and comments panel. */
  annotations?: AnnotationSupport;
  /** Enables live AcroForm filling. */
  forms?: FormSupport;
  /** Enables organize/combine/split/crop/header-footer/watermark. */
  pages?: PageTools;
  /** Enables create/export/compress/OCR. */
  convert?: ConvertTools;
  /** Enables protect/sanitize/redact/sign/audit, and enforces the document's permissions. */
  security?: SecurityTools;
}

export interface FormSupport {
  store: FormStore;
  onFlatten(): void;
  onExport(): void;
}

export interface AnnotationSupport {
  store: AnnotationStore;
  author: string;
  onAuthorChange(name: string): void;
  onSave(): void;
  saving: boolean;
  /** Unsaved changes outside the annotation store (e.g. form values). */
  extraDirty?: boolean;
}

type SidebarTab = 'pages' | 'search' | 'comments' | 'bookmarks';

export function PdfViewer({ doc, textDoc, annotations: ann, forms, pages: pageTools, convert, security }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [zoomMode, setZoomMode] = useState<ZoomMode>({ kind: 'fit-width' });
  const [scrollTop, setScrollTop] = useState(0);
  const [sidebar, setSidebar] = useState<SidebarTab | null>('pages');
  const [lastPage, setLastPage] = useState(0);

  const queue = useMemo(() => new RenderQueue(), [doc]);
  useEffect(() => () => queue.dispose(), [queue]);
  const textCache = useMemo(() => (textDoc ? new TextCache(textDoc) : null), [textDoc]);
  const search = useSearch(textCache);

  // ---- annotations
  const store = ann?.store;
  const allAnnotations = useAnnotations(store);
  const flags = useStoreFlags(store);
  const [tool, setToolState] = useState<Tool>('select');
  const [toolStyles, setToolStyles] = useState<Record<Tool, ToolStyle>>(TOOL_DEFAULTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const author = ann?.author ?? '';
  const selected = selectedId ? allAnnotations.find((a) => a.id === selectedId) : undefined;
  const byPage = useMemo(() => {
    const m = new Map<number, Annotation[]>();
    for (const a of allAnnotations) {
      if (a.type === 'reply') continue;
      const l = m.get(a.page);
      if (l) l.push(a);
      else m.set(a.page, [a]);
    }
    return m;
  }, [allAnnotations]);
  // ---- page tools
  const [organizing, setOrganizing] = useState(false);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const bookmarkCount = pageTools?.outline.length ?? 0;
  const [convertDialog, setConvertDialog] = useState<ConvertDialogKind | null>(null);
  const [secDialog, setSecDialog] = useState<SecurityDialogKind | null>(null);
  const canAnnotate = !security || security.permissions.annotate || security.permissions.modify;
  const redactMarks = useMemo(() => allAnnotations.filter((a) => a.type === 'redact'), [allAnnotations]);

  // ---- forms + Fill & Sign
  const formStore = forms?.store;
  const [formHighlight, setFormHighlight] = useState(true);
  const [formFocus, setFormFocus] = useState<WidgetRef | null>(null);
  const [formAlerts, setFormAlerts] = useState<string[]>([]);
  const [sigDialog, setSigDialog] = useState<{ kind: SignatureKind; target?: { page: number; rect: Rect } } | null>(null);
  const [stampArm, setStampArm] = useState<StampArm | null>(null);
  const [armedKind, setArmedKind] = useState<SignatureKind | null>(null);
  const [savedSigs, setSavedSigs] = useState<Record<SignatureKind, SavedSignature | null>>(() => ({
    signature: loadSignature('signature'),
    initials: loadSignature('initials'),
  }));
  const fieldsByPage = useMemo(() => {
    const m = new Map<number, import('@pdfsuite/forms').FormField[]>();
    for (const f of formStore?.model.fields ?? []) {
      for (const pg of new Set(f.widgets.map((w) => w.page))) {
        const l = m.get(pg);
        if (l) l.push(f);
        else m.set(pg, [f]);
      }
    }
    return m;
  }, [formStore]);
  useStoreFlagsForm(formStore);
  const commentCount = useMemo(() => allAnnotations.filter((a) => a.type !== 'reply').length, [allAnnotations]);
  // Drop the selection if the annotation disappears (delete / undo).
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    if (t !== 'select') {
      setSelectedId(null);
      setEditingId(null);
    }
  }, []);
  const toolStyle = toolStyles[tool];
  const activeStyle: ToolStyle = selected
    ? {
        color: selected.color,
        opacity: selected.opacity,
        width: 'width' in selected ? selected.width : toolStyle.width,
        fontSize: selected.type === 'freetext' ? selected.fontSize : toolStyle.fontSize,
      }
    : toolStyle;
  const applyStyle = useCallback(
    (patch: Partial<ToolStyle>) => {
      if (selected && store) {
        const next: Record<string, unknown> = {};
        if (patch.color !== undefined) next.color = patch.color;
        if (patch.opacity !== undefined) next.opacity = patch.opacity;
        if (patch.width !== undefined && 'width' in selected) next.width = patch.width;
        if (patch.fontSize !== undefined && selected.type === 'freetext') next.fontSize = patch.fontSize;
        store.update(selected.id, next as Partial<Annotation>, { coalesceKey: `style:${selected.id}` });
      } else {
        setToolStyles((s) => ({ ...s, [tool]: { ...s[tool], ...patch } }));
      }
    },
    [selected, store, tool],
  );
  const onCreated = useCallback((a: Annotation) => {
    setSelectedId(a.id);
    if (a.type === 'note') {
      setSidebar('comments');
      // Wait until the pointer interaction has finished; otherwise the browser moves focus back to the page.
      setTimeout(() => setFocusId(a.id), 80);
      setTimeout(() => setFocusId(null), 600);
    }
  }, []);
  const selectFromPanel = useCallback((id: string) => {
    setSelectedId(id);
    setToolState('select');
    const a = store?.get(id);
    const l = layoutRef.current;
    const el = scrollRef.current;
    if (a && el && l.tops[a.page] !== undefined) {
      const top = l.tops[a.page]!;
      el.scrollTo({ top: Math.max(0, top + annotationBounds(a).y * zoomRef.current - 80) });
    }
  }, [store]);

  // ---- page sizes: first page immediately, the rest in the background
  useEffect(() => {
    let cancelled = false;
    setSizes([]);
    setScrollTop(0);
    scrollRef.current?.scrollTo({ top: 0 });
    anchorRef.current = null;
    (async () => {
      const n = doc.pageCount;
      if (!n) return;
      const sizeOf = async (i: number): Promise<Size> => {
        const p = await doc.getPage(i);
        const s = { width: p.width, height: p.height };
        p.close();
        return s;
      };
      const arr: Size[] = new Array(n).fill(await sizeOf(0));
      if (cancelled) return;
      setSizes(arr.slice());
      for (let start = 1; start < n; start += 100) {
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        let changed = false;
        for (let i = start; i < Math.min(n, start + 100); i++) {
          const s = await sizeOf(i);
          if (s.width !== arr[i]!.width || s.height !== arr[i]!.height) changed = true;
          arr[i] = s;
        }
        if (changed) setSizes(arr.slice());
      }
    })().catch((e) => console.warn('page size scan failed', e));
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // ---- viewport size
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setViewport({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---- zoom + layout
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const maxPageWidth = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.width), 1), [sizes]);
  const zoom = useMemo(() => {
    if (!sizes.length || !viewport.width) return 1;
    return resolveZoom(zoomMode, viewport, maxPageWidth, sizes[Math.min(lastPage, sizes.length - 1)]!, PADDING);
  }, [zoomMode, viewport, maxPageWidth, sizes, lastPage]);
  const layout = useMemo(() => computeLayout(sizes, zoom, GAP, PADDING), [sizes, zoom]);
  // Sub-pixel overshoot (fit-width) must not trigger a horizontal scrollbar.
  const needed = layout.maxWidth + 2 * PADDING;
  const contentWidth = needed - viewport.width < 1 ? viewport.width : needed;

  // Keep the same part of the document in view when the layout changes (zoom, resize, late page sizes).
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    const prev = layoutRef.current;
    layoutRef.current = layout;
    const el = scrollRef.current;
    const a = anchorRef.current;
    if (!el || !a || prev === layout) return;
    const target = scrollTopFor(layout, a);
    if (Math.abs(target - el.scrollTop) > 0.5) el.scrollTop = target;
  }, [layout]);

  // ---- scrolling
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTop(el.scrollTop);
        anchorRef.current = anchorAt(layoutRef.current, el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const current = layout.tops.length ? pageAt(layout, scrollTop, viewport.height) : 0;
  useEffect(() => setLastPage(current), [current]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const distanceRef = useRef((i: number) => Math.abs(i - currentRef.current));

  const goToPage = useCallback((i: number) => {
    const l = layoutRef.current;
    const top = l.tops[Math.max(0, Math.min(i, l.tops.length - 1))];
    if (top !== undefined) scrollRef.current?.scrollTo({ top: Math.max(0, top - GAP) });
  }, []);

  // ---- zoom controls
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomBy = useCallback((dir: 1 | -1) => setZoomMode({ kind: 'custom', value: stepZoom(zoomRef.current, dir) }), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoomMode({ kind: 'custom', value: clampZoom(zoomRef.current * Math.exp(-e.deltaY / 400)) });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ---- search navigation
  const activeMatch = search.results[search.active] ?? null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!activeMatch || !el) return;
    const l = layoutRef.current;
    const top = l.tops[activeMatch.page];
    const rect = activeMatch.rects[0];
    if (top === undefined || !rect) return;
    const y = top + rect.y * zoomRef.current;
    const x = (el.clientWidth - l.widths[activeMatch.page]!) / 2 + rect.x * zoomRef.current;
    const visibleY = y > el.scrollTop + 40 && y < el.scrollTop + el.clientHeight - 80;
    const visibleX = x > el.scrollLeft && x < el.scrollLeft + el.clientWidth - 40;
    if (!visibleY) el.scrollTo({ top: Math.max(0, y - el.clientHeight / 3) });
    if (!visibleX && el.scrollWidth > el.clientWidth) el.scrollTo({ left: Math.max(0, x - el.clientWidth / 3) });
  }, [activeMatch]);

  const openSearch = useCallback(() => {
    setSidebar('search');
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  }, []);

  const armStamp = useCallback((kind: SignatureKind, sig: SavedSignature) => {
    setStampArm({ dataUrl: sig.dataUrl, aspect: sig.aspect, width: kind === 'signature' ? 150 : 60 });
    setArmedKind(kind);
    setToolState('stamp');
    setSelectedId(null);
  }, []);
  /** Fill & Sign button: place the saved image, or create one first. */
  const onSign = useCallback(
    (kind: SignatureKind) => {
      const saved = savedSigs[kind];
      if (saved) armStamp(kind, saved);
      else setSigDialog({ kind });
    },
    [savedSigs, armStamp],
  );
  /** Click on an unsigned signature field: put the signature straight into it. */
  const onSignField = useCallback(
    (page: number, rect: Rect) => {
      const saved = savedSigs.signature;
      if (saved) placeInRect(saved, page, rect);
      else setSigDialog({ kind: 'signature', target: { page, rect } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedSigs, store, author],
  );
  function placeInRect(sig: SavedSignature, page: number, rect: Rect) {
    if (!store) return;
    const pad = 3;
    const maxW = rect.width - 2 * pad;
    const maxH = rect.height - 2 * pad;
    const w = Math.min(maxW, maxH * sig.aspect);
    const h = w / sig.aspect;
    const a = {
      ...baseFields(page, author, '#000000', 1),
      id: STAMP_ID_PREFIX + newId(),
      type: 'stamp' as const,
      dataUrl: sig.dataUrl,
      rect: { x: rect.x + (rect.width - w) / 2, y: rect.y + (rect.height - h) / 2, width: w, height: h },
    };
    store.add(a);
    setSelectedId(a.id);
  }
  const onSigDone = useCallback(
    (sig: SavedSignature | null) => {
      const d = sigDialog;
      setSigDialog(null);
      if (!sig || !d) return;
      setSavedSigs((s) => ({ ...s, [d.kind]: sig }));
      if (d.target) placeInRect(sig, d.target.page, d.target.rect);
      else armStamp(d.kind, sig);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sigDialog, armStamp, store, author],
  );
  const onFormTab = useCallback(
    (from: WidgetRef, back: boolean) => {
      const order = formStore?.model.tabOrder ?? [];
      if (!order.length || !formStore) return;
      const i = order.findIndex((t) => t.field === from.field && t.widget === from.widget);
      // Skip widgets that cannot take focus (read-only, buttons, signature fields).
      let next = from;
      let f = formStore.model.fields.find((x) => x.name === from.field);
      for (let step = 1; step <= order.length; step++) {
        const cand = order[(((i < 0 ? 0 : i) + (back ? -step : step)) % order.length + order.length) % order.length]!;
        const cf = formStore.model.fields.find((x) => x.name === cand.field);
        if (cf && !cf.readOnly && cf.type !== 'pushbutton' && cf.type !== 'signature') {
          next = cand;
          f = cf;
          break;
        }
      }
      const w = f?.widgets[next.widget];
      const el = scrollRef.current;
      if (w && el) {
        const top = layoutRef.current.tops[w.page];
        if (top !== undefined) {
          const y = top + w.rect.y * zoomRef.current;
          if (y < el.scrollTop + 20 || y > el.scrollTop + el.clientHeight - 60) el.scrollTo({ top: Math.max(0, y - el.clientHeight / 3) });
        }
      }
      setFormFocus(next);
    },
    [formStore],
  );
  const onToolDone = useCallback(() => {
    setToolState((t) => (STICKY_TOOLS.includes(t) ? t : 'select'));
  }, []);

  // ---- text markup tools: turn the current text selection into highlight/underline/... annotations
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !store || !MARKUP_TOOLS.includes(tool)) return;
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const style = toolStyles[tool];
      const created: Annotation[] = [];
      for (const pageEl of el.querySelectorAll<HTMLElement>('.pv-page')) {
        const idx = Number(pageEl.dataset.page);
        const size = sizesRef.current[idx];
        if (!size) continue;
        const pr = pageEl.getBoundingClientRect();
        const k = pr.width / size.width;
        const rects: Rect[] = [];
        for (const span of pageEl.querySelectorAll<HTMLElement>('.pv-text')) {
          if (!range.intersectsNode(span)) continue;
          const tn = span.firstChild;
          if (!tn || tn.nodeType !== Node.TEXT_NODE) continue;
          const len = (tn.textContent ?? '').length;
          const sub = document.createRange();
          const start = range.startContainer === tn ? range.startOffset : range.startContainer === span ? (range.startOffset > 0 ? len : 0) : 0;
          const end = range.endContainer === tn ? range.endOffset : range.endContainer === span ? (range.endOffset > 0 ? len : 0) : len;
          if (end <= start) continue;
          sub.setStart(tn, start);
          sub.setEnd(tn, end);
          for (const cr of sub.getClientRects()) {
            rects.push({ x: (cr.left - pr.left) / k, y: (cr.top - pr.top) / k, width: cr.width / k, height: cr.height / k });
          }
        }
        const quads = mergeLineRects(rects);
        if (quads.length) {
          const base = baseFields(idx, author, style.color, style.opacity);
          created.push((tool === 'redact' ? { ...base, color: '#ff0000', opacity: 1, type: 'redact', quads, overlayColor: '#000000' } : { ...base, type: tool as MarkupType, quads }) as Annotation);
        }
      }
      if (!created.length) return;
      store.transact('Add markup', () => created.forEach((a) => store.add(a)));
      sel.removeAllRanges();
      setSelectedId(created[0]!.id);
    };
    el.addEventListener('mouseup', onUp);
    return () => el.removeEventListener('mouseup', onUp);
  }, [tool, store, toolStyles, author]);

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomBy(1);
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomBy(-1);
      } else if (mod && e.key === '0') {
        e.preventDefault();
        setZoomMode({ kind: 'fit-page' });
      } else if (mod && e.key === '1') {
        e.preventDefault();
        setZoomMode({ kind: 'actual' });
      } else if (mod && e.key === '2') {
        e.preventDefault();
        setZoomMode({ kind: 'fit-width' });
      } else if (store && mod && e.key.toLowerCase() === 'z' && !isTextField(e.target)) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (store && mod && e.key.toLowerCase() === 'y' && !isTextField(e.target)) {
        e.preventDefault();
        store.redo();
      } else if (mod && e.key.toLowerCase() === 's' && ann) {
        e.preventDefault();
        ann.onSave();
      } else if (store && (e.key === 'Delete' || e.key === 'Backspace') && selectedId && !isTextField(e.target)) {
        e.preventDefault();
        store.remove(selectedId);
      } else if (e.key === 'Escape' && !isTextField(e.target) && (tool !== 'select' || selectedId)) {
        setToolState('select');
        setSelectedId(null);
      } else if (e.key === 'F3') {
        e.preventDefault();
        if (e.shiftKey) search.prev();
        else search.next();
      } else if (e.key === 'Escape' && sidebar === 'search' && document.activeElement === searchInputRef.current) {
        scrollRef.current?.focus();
      } else if (!mod && (e.target as HTMLElement)?.tagName !== 'INPUT') {
        const el = scrollRef.current;
        if (!el) return;
        if (e.key === 'Home') {
          e.preventDefault();
          goToPage(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          goToPage(layoutRef.current.tops.length - 1);
        } else if (e.key === 'ArrowRight' && e.altKey) {
          e.preventDefault();
          goToPage(currentRef.current + 1);
        } else if (e.key === 'ArrowLeft' && e.altKey) {
          e.preventDefault();
          goToPage(currentRef.current - 1);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goToPage, openSearch, search, sidebar, zoomBy, store, ann, selectedId, tool]);

  // ---- render
  const range = visibleRange(layout, scrollTop, viewport.height, viewport.height);
  const pages = [];
  for (let i = range.first; i <= range.last; i++) {
    pages.push(
      <PageView
        key={i}
        index={i}
        size={sizes[i]!}
        zoom={zoom}
        left={(contentWidth - layout.widths[i]!) / 2}
        top={layout.tops[i]!}
        doc={doc}
        queue={queue}
        textCache={textCache}
        distanceRef={distanceRef}
        matches={search.byPage.get(i) ?? EMPTY}
        activeMatch={activeMatch?.page === i ? activeMatch : null}
        overlay={
          <>
            {formStore && fieldsByPage.has(i) && (
              <FormLayer
                page={i}
                size={sizes[i]!}
                zoom={zoom}
                store={formStore}
                fields={fieldsByPage.get(i)!}
                highlight={formHighlight}
                focusTarget={formFocus}
                onFocused={() => setFormFocus(null)}
                onTab={onFormTab}
                onAlerts={setFormAlerts}
                onSign={onSignField}
              />
            )}
          {store ? (
            <AnnotationLayer
              page={i}
              size={sizes[i]!}
              zoom={zoom}
              annotations={byPage.get(i) ?? EMPTY_ANN}
              tool={tool}
              style={toolStyle}
              stamp={stampArm}
              author={author}
              selectedId={selectedId}
              editingId={editingId}
              store={store}
              onSelect={setSelectedId}
              onEdit={setEditingId}
              onCreated={onCreated}
              onToolDone={onToolDone}
            />
          ) : null}
          </>
        }
      />,
    );
  }

  return (
    <div className={`pv-root pv-tool-${tool}${DRAW_TOOLS.includes(tool) ? ' pv-tool-draw' : ''}${security && !security.permissions.copy ? ' pv-nocopy' : ''}`}>
      <Toolbar
        sidebar={sidebar}
        onSidebar={(t) => setSidebar((s) => (s === t ? null : t))}
        page={current}
        pageCount={doc.pageCount}
        onGoto={goToPage}
        zoom={zoom}
        zoomMode={zoomMode}
        onZoomMode={setZoomMode}
        onZoomBy={zoomBy}
        onFind={openSearch}
        commentCount={ann ? commentCount : undefined}
        hasBookmarks={bookmarkCount > 0}
      />
      {pageTools && (
        <PageToolbar
          organizing={organizing}
          onOrganize={() => setOrganizing((v) => !v)}
          onDialog={setDialog}
          canUndo={pageTools.canUndo}
          canRedo={pageTools.canRedo}
          onUndo={pageTools.onUndo}
          onRedo={pageTools.onRedo}
          busy={pageTools.busy}
        />
      )}
      {convert && (
        <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Convert">
          <strong className="pv-muted">Convert</strong>
          <button onClick={() => setConvertDialog('create')} title="Create a PDF from images, Office files, HTML or a scanner">
            Create PDF
          </button>
          <button onClick={() => setConvertDialog('export')} title="Export pages as images or text">
            Export
          </button>
          <button onClick={() => setConvertDialog('compress')} title="Reduce the file size">
            Compress
          </button>
          <button onClick={() => setConvertDialog('ocr')} title="Make scanned pages searchable">
            Recognize text
          </button>
          <span className="pv-spacer" />
          <span className="pv-muted" title={convert.server ? 'API service connected' : 'API service not reachable: Office/HTML conversion is unavailable'}>
            {convert.server ? '● server' : '○ offline'}
          </span>
        </div>
      )}
      {security && (
        <SecurityToolbar tools={security} tool={tool} onTool={setTool} markCount={redactMarks.length} onDialog={setSecDialog} canMark={!!store && canAnnotate} />
      )}
      {ann && store && canAnnotate && (
        <AnnotationToolbar
          tool={tool}
          onTool={setTool}
          style={activeStyle}
          onStyle={applyStyle}
          selected={selected && selected.type !== 'reply' ? selected : undefined}
          canUndo={flags.canUndo}
          canRedo={flags.canRedo}
          dirty={flags.dirty || !!ann.extraDirty}
          saving={ann.saving}
          onUndo={() => store.undo()}
          onRedo={() => store.redo()}
          onDelete={() => selectedId && store.remove(selectedId)}
          onSave={ann.onSave}
        />
      )}
      {ann && store && canAnnotate && (
        <FillSignToolbar tool={tool} onTool={setTool} has={{ signature: !!savedSigs.signature, initials: !!savedSigs.initials }} armed={armedKind} onSign={onSign} onEdit={(kind) => setSigDialog({ kind })} />
      )}
      {forms && formStore && formStore.hasFields && (
        <FormToolbar
          fieldCount={formStore.model.fields.length}
          highlight={formHighlight}
          onHighlight={setFormHighlight}
          onReset={() => setFormAlerts(formStore.reset().alerts)}
          onExport={forms.onExport}
          onFlatten={forms.onFlatten}
          dirty={formStore.isDirty}
        />
      )}
      {formAlerts.length > 0 && (
        <div className="pv-toast" role="alert">
          <div>{formAlerts.map((a, i) => <p key={i}>{a}</p>)}</div>
          <button onClick={() => setFormAlerts([])} aria-label="Dismiss">✕</button>
        </div>
      )}
      {sigDialog && <SignatureDialog kind={sigDialog.kind} onDone={onSigDone} />}
      {convert && convertDialog && (
        <>
          {convertDialog === 'create' && <CreateDialog tools={convert} pageCount={doc.pageCount} currentPage={current} onClose={() => setConvertDialog(null)} />}
          {convertDialog === 'export' && <ExportDialog tools={convert} pageCount={doc.pageCount} currentPage={current} onClose={() => setConvertDialog(null)} />}
          {convertDialog === 'compress' && <CompressDialog tools={convert} pageCount={doc.pageCount} currentPage={current} onClose={() => setConvertDialog(null)} />}
          {convertDialog === 'ocr' && <OcrDialog tools={convert} pageCount={doc.pageCount} currentPage={current} onClose={() => setConvertDialog(null)} />}
        </>
      )}
      {security && secDialog && (
        <>
          {secDialog === 'protect' && <ProtectDialog tools={security} onClose={() => setSecDialog(null)} />}
          {secDialog === 'sanitize' && <SanitizeDialog tools={security} onClose={() => setSecDialog(null)} />}
          {secDialog === 'redact' && (
            <RedactDialog
              tools={security}
              textSource={textCache}
              markCount={redactMarks.length}
              onMark={(page, rects) => store?.add({ ...baseFields(page, author, '#ff0000', 1), type: 'redact', quads: rects, overlayColor: '#000000' })}
              collectMarks={() => {
                const by = new Map<number, Rect[]>();
                for (const a of redactMarks) if (a.type === 'redact') by.set(a.page, [...(by.get(a.page) ?? []), ...a.quads]);
                return [...by].map(([page, rects]) => ({ page, rects }));
              }}
              onClose={() => setSecDialog(null)}
            />
          )}
          {secDialog === 'sign' && <SignDialog tools={security} pageCount={doc.pageCount} currentPage={current} pageSizes={sizes} onClose={() => setSecDialog(null)} />}
          {secDialog === 'signatures' && <SignaturesDialog tools={security} onClose={() => setSecDialog(null)} />}
          {secDialog === 'audit' && <AuditDialog tools={security} onClose={() => setSecDialog(null)} />}
        </>
      )}
      {pageTools && dialog && (
        <>
          {dialog === 'combine' && <CombineDialog tools={pageTools} pageCount={doc.pageCount} currentPage={current} onClose={() => setDialog(null)} />}
          {dialog === 'split' && <SplitDialog tools={pageTools} pageCount={doc.pageCount} currentPage={current} onClose={() => setDialog(null)} />}
          {dialog === 'crop' && <CropDialog tools={pageTools} pageCount={doc.pageCount} currentPage={current} onClose={() => setDialog(null)} />}
          {dialog === 'headerFooter' && <HeaderFooterDialog tools={pageTools} pageCount={doc.pageCount} currentPage={current} onClose={() => setDialog(null)} />}
          {dialog === 'watermark' && <WatermarkDialog tools={pageTools} pageCount={doc.pageCount} currentPage={current} onClose={() => setDialog(null)} />}
        </>
      )}
      {organizing && pageTools ? (
        <PageOrganizer
          doc={doc}
          sizes={sizes}
          queue={queue}
          busy={pageTools.busy}
          onApply={(items) => void pageTools.onApplyPlan(items).then(() => setOrganizing(false))}
          onCancel={() => setOrganizing(false)}
          onExtract={(items) => void pageTools.onExtract(items)}
          onInsertFile={(plan, after, file) => void pageTools.onInsertFile(plan, after, file).then(() => setOrganizing(false))}
        />
      ) : null}
      <div className="pv-body" hidden={organizing}>
        {sidebar && (
          <aside className={sidebar === 'search' || sidebar === 'comments' || sidebar === 'bookmarks' ? 'pv-sidebar pv-sidebar-wide' : 'pv-sidebar'}>
            {sidebar === 'pages' ? (
              <Thumbnails doc={doc} sizes={sizes} queue={queue} current={current} onSelect={goToPage} />
            ) : sidebar === 'bookmarks' && pageTools ? (
              <OutlinePanel items={pageTools.outline} onGoto={goToPage} />
            ) : sidebar === 'comments' && ann && store ? (
              <CommentsPanel
                store={store}
                annotations={allAnnotations}
                selectedId={selectedId}
                onSelect={selectFromPanel}
                author={ann.author}
                onAuthorChange={ann.onAuthorChange}
                focusId={focusId}
              />
            ) : (
              <SearchPanel ref={searchInputRef} search={search} pageCount={doc.pageCount} textAvailable={!!textCache} />
            )}
          </aside>
        )}
        <div className="pv-scroll" ref={scrollRef} tabIndex={0} role="document" aria-label="PDF pages">
          <div className="pv-content" style={{ width: contentWidth, height: layout.total }}>
            {pages}
          </div>
        </div>
      </div>
    </div>
  );
}

const isTextField = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

const EMPTY: never[] = [];
const EMPTY_ANN: Annotation[] = [];

function Toolbar(props: {
  sidebar: SidebarTab | null;
  onSidebar(t: SidebarTab): void;
  page: number;
  pageCount: number;
  onGoto(i: number): void;
  zoom: number;
  zoomMode: ZoomMode;
  onZoomMode(m: ZoomMode): void;
  onZoomBy(d: 1 | -1): void;
  onFind(): void;
  commentCount?: number;
  hasBookmarks?: boolean;
}) {
  const { page, pageCount, zoom, zoomMode } = props;
  const [text, setText] = useState(String(page + 1));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(page + 1));
  }, [page, editing]);

  const modeValue = zoomMode.kind === 'custom' ? `custom:${Math.round(zoom * 100)}` : zoomMode.kind;
  const presets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
  const customPct = Math.round(zoom * 100);
  const hasPreset = presets.some((p) => Math.round(p * 100) === customPct);

  return (
    <div className="pv-toolbar" role="toolbar" aria-label="Viewer toolbar">
      <button
        aria-pressed={props.sidebar === 'pages'}
        onClick={() => props.onSidebar('pages')}
        title="Page thumbnails"
      >
        ☰ Pages
      </button>
      <span className="pv-sep" />
      <button onClick={() => props.onGoto(page - 1)} disabled={page <= 0} aria-label="Previous page">
        ◀
      </button>
      <input
        className="pv-page-input"
        value={text}
        aria-label="Page number"
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseInt(text, 10);
            if (n >= 1) props.onGoto(Math.min(n, pageCount) - 1);
            e.currentTarget.blur();
          }
        }}
      />
      <span className="pv-muted">/ {pageCount}</span>
      <button onClick={() => props.onGoto(page + 1)} disabled={page + 1 >= pageCount} aria-label="Next page">
        ▶
      </button>
      <span className="pv-sep" />
      <button onClick={() => props.onZoomBy(-1)} aria-label="Zoom out" title="Zoom out (Ctrl+-)">
        −
      </button>
      <select
        value={modeValue}
        aria-label="Zoom"
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('custom:')) return;
          if (v === 'fit-width' || v === 'fit-page' || v === 'actual') props.onZoomMode({ kind: v });
          else props.onZoomMode({ kind: 'custom', value: Number(v) });
        }}
      >
        <option value="fit-width">Fit width</option>
        <option value="fit-page">Fit page</option>
        <option value="actual">Actual size</option>
        {zoomMode.kind === 'custom' && !hasPreset && <option value={`custom:${customPct}`}>{customPct}%</option>}
        {zoomMode.kind !== 'custom' && <option value={`custom:${customPct}`} hidden>{customPct}%</option>}
        {presets.map((p) => (
          <option key={p} value={p}>
            {Math.round(p * 100)}%
          </option>
        ))}
      </select>
      <span className="pv-muted pv-zoom-label">{customPct}%</span>
      <button onClick={() => props.onZoomBy(1)} aria-label="Zoom in" title="Zoom in (Ctrl++)">
        +
      </button>
      <span className="pv-sep" />
      <button onClick={props.onFind} aria-pressed={props.sidebar === 'search'} title="Find (Ctrl+F)">
        🔍 Find
      </button>
      {props.hasBookmarks && (
        <button aria-pressed={props.sidebar === 'bookmarks'} onClick={() => props.onSidebar('bookmarks')} title="Bookmarks">
          🔖 Bookmarks
        </button>
      )}
      {props.commentCount !== undefined && (
        <button aria-pressed={props.sidebar === 'comments'} onClick={() => props.onSidebar('comments')} title="Comments panel">
          💬 Comments{props.commentCount ? ` (${props.commentCount})` : ''}
        </button>
      )}
    </div>
  );
}

function useStoreFlagsForm(store: FormStore | undefined) {
  useSyncExternalStore(
    store ? store.subscribe : (() => () => undefined),
    store ? store.getVersion : () => 0,
    store ? store.getVersion : () => 0,
  );
}
