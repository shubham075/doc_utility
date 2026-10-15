# ADR 0001 — PDF engine spike (Phase 0)

Status: accepted (provisional, revisit after Phase 1 perf gate)

## Setup
`@pdfsuite/engine` defines `PdfEngine/PdfDocument/PdfPage`; adapters for PDFium-WASM (`@hyzyla/pdfium`, MIT) and PDF.js (`pdfjs-dist`, Apache-2.0).
Benchmark: `pnpm bench` (Node 24, Windows 11, scale 1.5, 20 pages, synthetic 50-page text PDF).

## Results (synthetic-50p.pdf, one run — indicative only)
| Metric | PDFium | PDF.js |
|---|---|---|
| open | 7 ms | ~710 ms (includes first-use font/worker setup) |
| first page render | ~60 ms | ~115 ms |
| avg page render | ~14 ms | ~74 ms |
| avg text extraction | ~2 ms | ~9 ms |
| RSS after run | ~376 MB | ~475 MB |

Both engines render the page correctly in Node (@napi-rs/canvas) and in the browser (verified in Vite dev app).

## Decision
- PDFium (WASM) = default render engine; PDF.js = fallback + text layer/a11y reference.
- Desktop shell: **Electron** (not yet scaffolded) — same Chromium as web, single language. Re-evaluate Tauri only if installer size/RAM become blockers.
- `@hyzyla/pdfium` exposes render/text/object APIs but not annotations/forms editing; Phase 2/3 will need a richer PDFium binding (e.g. EmbedPDF's build or our own Emscripten build). Tracked as a risk.

## Open items
- Real-world corpus (scanned, huge, encrypted, forms) benchmark; synthetic file is not representative.
- Threaded WASM + SharedArrayBuffer (COOP/COEP headers already set in Vite config).
- Move rendering to a Worker + OffscreenCanvas (Phase 1).
