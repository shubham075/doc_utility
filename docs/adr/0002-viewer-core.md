# ADR 0002 — Viewer core (Phase 1)

Status: accepted

## Design
- `@pdfsuite/viewer` is a source-only package (no build step; Vite/vitest consume TS directly).
- Pure, unit-tested logic: `layout.ts` (page stack, visible range, fit modes, scroll anchors), `search.ts` (regex search over text runs, match rectangles).
- Virtualization: only pages within one viewport of the visible range are mounted; thumbnails are virtualized separately.
- Rendering: serial priority `RenderQueue` (pages by distance from the current page, thumbnails after). Zoom changes stretch the old bitmap via CSS and re-render after 120 ms. Bitmap size capped at 40 Mpx.
- Text layer + search always use **PDF.js** (`PdfPage.getTextItems`), because `@hyzyla/pdfium` exposes no character boxes. With the PDFium render engine the file is therefore opened twice (render doc + text doc).
- Scroll anchoring: scroll position is stored as (page, fraction) and restored after any layout change (zoom, resize, late page sizes).

## Findings
- pdf.js `page.cleanup()` makes later `render()` calls on the same cached page proxy hang; adapter `close()` no-ops (regression test added).
- pdf.js rendering uses `requestAnimationFrame`, so it stalls in hidden/occluded windows; PDFium path is unaffected.
- `scrollbar-gutter: stable` avoids a fit-width feedback loop between scrollbar appearance and zoom.
- StrictMode re-runs effects, so `RenderQueue.dispose()` must leave the queue reusable.

## Not in Phase 1 (deferred)
Two-page/cover scroll modes, rotate view, presentation mode, bookmarks/outline, page labels, text-layer for scanned docs (needs OCR, Phase 5), moving rendering to a Worker, whole-document memory eviction for 1,000+ page files, perf budget measurement on a real corpus.
