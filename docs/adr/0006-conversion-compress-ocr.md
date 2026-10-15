# ADR 0006 — Conversion, export, compress, OCR, scan (Phase 5)

Status: accepted

## Decisions
- **Client first, server where unavoidable.** Everything that can run on the user's device does (offline, no document leaves the machine): images → PDF, export to images/text, compress, OCR. The **API service** (`services/api`, Fastify) exists for what needs native tools — Office → PDF (LibreOffice) and HTML → PDF (Chrome/Edge) — and can also run compress/OCR for large files.
- **`@pdfsuite/convert`**: `imagesToPdf` (PNG/JPEG embedded unchanged; fit/A4/Letter), `exportImages` (page → PNG/JPEG at chosen dpi, 100 Mpx cap, ZIP), `exportText`, `optimizePdf` (drops unreferenced objects, optional metadata/thumbnail removal, re-encodes oversized 8-bit non-CMYK JPEGs through an injected recompressor; presets low/medium/high; never returns a larger file).
- **`@pdfsuite/ocr`**: tesseract.js (WebAssembly, Apache-2.0), fully self-hosted (worker, core variants and `eng` data are copied into `public/ocr`; nothing is fetched from a CDN). Pages are rendered, recognised, and an **invisible (render mode 3) text layer** is added with each word stretched to its measured box and written upright for rotated pages. Verified invisible: pixels identical before/after. Pages that already have text can be skipped; cancellable.
- **API service**: bearer-token auth (required when listening beyond loopback), per-user job quota, bounded concurrency, TTL for results, size limits, extension allow-list, magic-byte check for PDFs, fixed internal file names (client names never reach the file system or the command line), converters run **without a shell**, with timeouts and process-tree kill, output caps and a private LibreOffice profile per job. **HTML is isolated**: a CSP meta tag (no scripts, no network) is injected first and the browser's resolver refuses every host — verified with a real Edge run that a hostile page's `<img>`/`fetch` produce zero requests.
- **Scan**: Windows desktop shows the system WIA scan dialog via PowerShell (output path passed in the environment, never interpolated); in browsers, scans arrive as image files (a phone/scanner app or the camera picker). The Create PDF dialog combines scans, images, PDFs, Office and HTML files.
- All document-changing tools reuse the Phase 4 pipeline (flush → edit → reload, undo/redo, unsaved marker); results are reported in a notice bar since the dialog is gone after the reload.

## Verification
- `@pdfsuite/convert` 8 tests, `@pdfsuite/ocr` 3 tests (searchable text found in PDFium and PDF.js; positions on a rotated page; skip/cancel), `@pdfsuite/api` 20 tests (auth/ownership, quotas, limits, name cleaning, compress and OCR jobs end to end, LibreOffice invocation via a fake at the process boundary, process runner: no-shell, timeout, abort, caps; job queue; real Edge HTML→PDF with the network blocked).
- Browser run: OCR in the browser on a scanned page (text layer appears), HTML → PDF via the service, export text/PNG, compress notice, images → 2-page PDF.

## Known limitations / follow-ups
- **Not exercised here**: LibreOffice conversion with real Office files (not installed on the dev machine — only its command line is tested), the Docker image (no daemon available), and the WIA scan path (no scanner). Linux/macOS scanning (SANE/ImageCapture) is not implemented.
- OCR is English only (additional languages = more `.traineddata.gz` files), no deskew/layout analysis, no "PDF/A with OCR"; compress recompresses JPEG only (no Flate/JPEG2000/JBIG2 image recompression, no font subsetting or linearization yet); export to Word/Excel/PowerPoint is Phase 8.
- In-memory job queue: results are lost on restart and it does not scale beyond one instance (swap for BullMQ/Redis + object storage). No OIDC yet (shared API keys).
- Browser-side compress/OCR run on the main thread's event loop in chunks; move to Workers with the QuickJS runner (hardening phase).
