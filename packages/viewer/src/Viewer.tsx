import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PdfDocument } from '@pdfsuite/engine';
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
}

type SidebarTab = 'pages' | 'search';

export function PdfViewer({ doc, textDoc }: PdfViewerProps) {
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
  }, [goToPage, openSearch, search, sidebar, zoomBy]);

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
      />,
    );
  }

  return (
    <div className="pv-root">
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
      />
      <div className="pv-body">
        {sidebar && (
          <aside className="pv-sidebar">
            {sidebar === 'pages' ? (
              <Thumbnails doc={doc} sizes={sizes} queue={queue} current={current} onSelect={goToPage} />
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

const EMPTY: never[] = [];

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
    </div>
  );
}
