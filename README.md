# PDF Suite

Internal Acrobat-class PDF viewer/editor. See `PDF_SUITE_IMPLEMENTATION_PLAN.md` for the roadmap and `docs/adr/` for decisions.

## Layout
- `apps/desktop` — Electron shell (sandboxed renderer, `app://` protocol with CSP + COOP/COEP, native open/save, file association)
- `packages/pages` — page plan/assemble (reorder, rotate, delete, insert, merge), split + ZIP, crop, header/footer/Bates, watermark, bookmarks reader
- `packages/forms` — AcroForm reader/writer, QuickJS-sandboxed Acrobat JS (format/validate/calculate), flatten
- `packages/annotations` — annotation model, undo/redo store, PDF reader/writer (appearance streams), interop tests
- `packages/viewer` — React viewer: virtualized continuous scroll, zoom/fit, thumbnails, text layer, search, annotation tools, comments panel, form filling, Fill & Sign, page organizer and tools
- `packages/engine` — engine-agnostic PDF API + PDFium-WASM and PDF.js adapters
- `apps/web` — Vite + React shell (`pnpm dev:web`, optional `?pdf=/sample.pdf`)
- `tools/bench` — Node benchmark harness (`pnpm bench`, `pnpm --filter @pdfsuite/bench gen-sample 50`)
- `corpus/` — drop test PDFs here (git-ignored)

## Commands
```
pnpm install
pnpm typecheck && pnpm build && pnpm test
pnpm dev:web          # browser
pnpm dev:desktop      # Electron + Vite HMR
pnpm start:desktop    # build everything, run Electron on the built web app
pnpm bench
```
Requires Node >= 22 and pnpm.
