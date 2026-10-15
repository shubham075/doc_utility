# ADR 0003 — Annotations (Phase 2)

Status: accepted

## Decisions
- **Writer = pdf-lib + our own appearance streams** (`@pdfsuite/annotations`). Every annotation is written with an AP stream so other viewers render it identically.
- **Model in display space** (points, top-left origin, after page rotation). Conversion to PDF user space (crop box origin, /Rotate 0/90/180/270) lives in `geometry.ts` and is unit-tested.
- **The viewer draws annotations itself** (SVG overlay) from an observable `AnnotationStore`; the page bitmap comes from a *render copy* of the PDF with managed annotations stripped (`stripMarkupAnnotations`), so nothing is drawn twice and edits are live.
- **Undo/redo**: transactional store, per-transaction before/after snapshots, coalescing for typing, replies removed with their parent in one step.
- **Minimal rewrite on save**: only ids in `store.touchedIds` are re-emitted (same object number, old AP deleted); untouched annotations, links, widgets etc. keep their original objects. Annotations from other tools are editable (`ref:<obj>-<gen>` ids).
- **Comments** = annotation `/Contents`; replies = `Text` annots with `/IRT` + `/RT /R`; review status = Acrobat-style `/StateModel /Review` state annots. Author name is a user setting.

## Supported
Highlight, underline, strikethrough, squiggly (from text selection), sticky note, text box, freehand ink, rectangle, ellipse, line, arrow; select/move/resize, colour/opacity/width/font size, comments panel (filter by type/status/author/text, replies, status), Save (File System Access API / download in browsers, native dialog in Electron).

## Verification
- 19 tests in `@pdfsuite/annotations`: geometry for all rotations, store, read/write round trips of every type, edit/delete/no-duplicate on re-save, annotations from other tools, strip, and **pixel checks of saved files rendered by both PDFium and PDF.js** (including a /Rotate 90 page).
- Manual browser run: all tools, comments panel, reply, move, save -> re-read (9 annots) -> render.

## Known limitations / follow-ups
- pdf-lib rewrites the whole file: **no incremental save, existing digital signatures are invalidated** (revisit in Phase 6 with a signature-safe incremental writer).
- Encrypted PDFs: annotation editing disabled (Phase 6).
- Free-text appearance uses Helvetica/WinAnsi; other characters become `?` in the saved appearance (the in-app overlay shows them). Needs font embedding (Noto) later. Free text on rotated pages uses a rotated text matrix — covered by geometry tests but not visually verified.
- Stamps, file attachments, popups, inline (non-indirect) annotation dicts are left untouched and not editable. XFDF import/export not done.
- Text markup needs a text layer (not available for scanned pages until OCR, Phase 5).
- Render copy requires an extra pdf-lib load/save when the file already has markup annotations; not yet measured on large files.
- Desktop save always shows a Save As dialog and writes non-atomically.
- Not yet tested in the Electron shell.
