# ADR 0005 — Page organization and assembly (Phase 4)

Status: accepted

## Decisions
- **`@pdfsuite/pages`** (pdf-lib, DOM-free). Everything that changes page structure is a function `bytes -> bytes`.
- **Page plan model.** The desired result is an ordered list of `PlanItem { src, page | 'blank', rotate }`. The organizer UI edits it with pure helpers (`rotateItems`, `deleteItems`, `duplicateItems`, `moveItems`, `insertBlank`); `assemble(sources, items)` builds the PDF. Reorder/delete/rotate/merge/insert/extract/split are all this one function.
- **Move, don't copy, where possible.** Pages of the document being edited are *moved* inside the same pdf-lib document (preserving metadata, outlines, forms, page labels); only duplicates, pages from other files and blanks are copied. Inherited page attributes (Resources/MediaBox/CropBox/Rotate) are materialised on the leaf first so re-parenting cannot lose them. AcroForm fields whose widgets were on deleted pages are pruned.
- **Display-space tools.** Crop, header/footer/Bates and watermark take positions in *display space* (after page rotation) and convert with the same geometry as annotations, so text is upright on rotated pages. Crop sets only the CropBox (reversible); blank-margin detection uses a rendered bitmap.
- **Header/footer/Bates** = standard-14 fonts, six slots, tokens `<<page>> <<pages>> <<date>> <<file>> <<bates>>`, first page number, Bates prefix/suffix/start/digits counting across the chosen pages. **Watermark** = text or image, opacity, rotation, centre/tile, over or *behind* content (new content streams are moved to the front of /Contents).
- **Split** = every N pages, explicit ranges, or at top-level bookmarks (`readOutline` resolves explicit and named destinations); several outputs are bundled in a small stored ZIP writer.
- **Document-changing operations reload the document.** The app flushes pending form/annotation edits into the bytes, runs the operation, then re-opens the result (annotations/forms are re-read from the file). Ten snapshots give **Undo/Redo for page operations**; the annotation undo stack restarts after each page operation. The title shows an unsaved marker until Save.
- Viewer: **Organize** grid (select with click/Ctrl/Shift, drag to reorder, rotate, delete, duplicate, insert blank, insert file, extract, undo/redo, apply/cancel), dialogs for Combine, Split, Crop, Header & footer, Watermark, and a **Bookmarks** panel.
- Engine hardening found while testing: using a PDFium page (render/getText/close) after its document was closed aborted the whole WASM module; the adapter now throws a normal error and ignores late `close()`.

## Verification
- 23 tests in `@pdfsuite/pages`: ranges, plan helpers, reorder/delete/rotate/duplicate/blank/merge (text order checked in PDFium **and** PDF.js), inherited attributes, form-field pruning, crop (rotated pages, reset, auto-detect), header/footer/Bates (tokens, rotated pages, unbalanced content streams), watermark (over/behind/opacity/rotation/tile/image), outline reading, split plans and files, ZIP structure + CRC.
- Browser run: organize (rotate, duplicate), apply, header/footer with Bates on a rotated page, diagonal watermark, split to ZIP (3 files), undo/redo, save.

## Known limitations / follow-ups
- Pages copied from *other* PDFs lose their bookmarks and named destinations, and their form fields become static (widgets are not merged into the target AcroForm).
- Deleting pages leaves bookmarks that pointed at them dangling (they show as disabled).
- Header/footer and watermark are permanent page content (no "remove" feature); fonts are the standard 14 (non-Latin text becomes `?`).
- Split "by file size", page labels, page resize/scale, N-up and Bates in *existing* text are not implemented.
- After an operation the viewer returns to page 1; large documents are re-parsed in full each time (no incremental update).
- The combine/insert flows were verified through the unit-tested `assemble`, not through a browser file picker.
