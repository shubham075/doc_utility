# ADR 0008 — Content editing (text, images, shapes, links)

Status: accepted

## Decisions
- **Page content is edited as instructions, not pixels.** `@pdfsuite/editor` parses a page's content stream (the Phase 6 parser) into *objects*: text runs (one show instruction), images, form XObjects, vector paths, inline images, each with its position in display space. Edits splice instructions and write one new content stream; everything is saved through pdf-lib (so a signed file loses its signatures — the app warns first).
- **Object ids** are `<kind>:<instruction index>`; they are valid for one version of the page content. The UI re-reads the objects after every edit.
- **Move/resize** wraps the object in `q <matrix> cm … Q`, the matrix being the requested box change expressed in the object's current coordinate system (works for rotated pages and nested `cm`). Text is moved by isolating the run (`ET q cm BT Tm … ET Q BT Tm`) and restoring both text matrices (the advance is replayed with an empty `TJ` shift), so neighbouring runs on the line do not shift. Delete removes the instructions (text keeps its advance).
- **Text editing is run-level** (one `Tj`/`TJ`): the string is re-encoded with the original font. Per font a *codec* maps codes ↔ Unicode (ToUnicode CMaps, encodings + Differences, glyph names). For subset fonts only glyphs already used in the document are assumed present. Other characters are set in a bundled fallback font (Liberation Sans, SIL OFL, embedded as a subset via fontkit, weight/style matched to the original) and the user is told; characters not even in the fallback show as "?" with a warning. Runs whose codes cannot be decoded are not editable (they can still be moved/deleted).
- **Add** text/image/shapes append a new content stream (rotation-aware); standard fonts for Latin-1, fallback font otherwise.
- **Images**: replace (keeps proportions inside the old box), export (JPEG copied unchanged; Flate gray/RGB/indexed + soft mask → PNG), crop (clip; hidden pixels stay in the file — use Sanitize/Redact if they must go).
- **Links**: list/add/update/delete link annotations (URI limited to http/https/mailto/tel/ftp; page destinations as `GoTo /Fit`).
- **UI**: Edit PDF mode with object overlay (hover/select/drag/resize/shift-select, double-click text, Delete key), Add text/image/Rectangle/Ellipse/Line/Arrow/Link tools and contextual buttons. Each edit goes through the existing flush → edit → reload pipeline (undo/redo, unsaved marker, signature warning). The app now swaps documents *in place* (new document opened before the old one is dropped; `resetKey` resets the viewer only for another file) so edits keep zoom, scroll position, edit mode and tool.
- Requires the "modify" permission of encrypted files.

## Verification
- `@pdfsuite/editor` 14 tests: scan geometry, move/resize/delete (images, paths, text), text edit with original and fallback fonts, added content (incl. rotated page), image export/replace/crop with pixel checks, links.
- **Round trips on 29 PDFs** (15 Edge/Chrome documents with subset Type0 fonts, tables, rotation, columns, CJK/Arabic, landscape; 12 pdf-lib documents with standard/embedded fonts, rotated 90/180/270 pages, crop-box offset; the sample and form PDFs): rewriting a page without changes differs by 0.000%; editing a run (character reversal and Title Case, which forces fallback glyphs in subset fonts) changes nothing outside the edited line (< 0.5% required, 0.000% measured) and the new text is extracted correctly by PDF.js. This is fewer than the 50 diverse documents targeted in the plan: grow the set from real company documents (`corpus/`).
- Browser run: edit mode on an Edge PDF; double-click edit with fallback notice; drag-move (exact 40 px); rectangle, new text and link creation; undo; edit mode survives reloads.

## Known limitations / follow-ups
- Only the page's own content stream is scanned: text inside form XObjects (common in some producers) is one movable/deletable object, not editable. No paragraph reflow, no font size/colour change of existing text, no rotation handles, no editing of vector colours, no clipping-path editing, no inline-image export, CMYK/JPX/JBIG2 images cannot be exported.
- Edits to a run do not move following text on the same line. Large changes can overlap neighbours.
- Fallback font covers Latin/Greek/Cyrillic only; others show "?". Glyph availability in non-subset embedded Type0 fonts is conservatively limited to already-used glyphs.
- Scroll preservation after an edit was reasoned and partly tested but could not be fully verified in the hidden headless browser pane — check once in a visible window.
- Reloading the whole PDF per edit is simple and consistent but slow for very large files (move to incremental page rewrite).
