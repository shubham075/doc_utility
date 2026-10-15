# PDF Suite (Acrobat-class clone) — Feature Analysis & Implementation Plan

Working name: **PDF Suite** (placeholder; no Adobe names, logos, icons or fonts are used).
Targets: cross-platform desktop (Windows first, macOS/Linux later) + web. Scope: full Acrobat Pro parity. Stack: TypeScript + React + PDFium/PDF.js. Use: internal company tool.

---

## 1. Feature analysis

Source: the Acrobat Reader download page (get.adobe.com/reader) is only an installer page; the feature set below is based on Acrobat Reader (free) and Acrobat Pro (paid) as publicly documented. Priority: **P0** = MVP, **P1** = Pro essentials, **P2** = Pro advanced, **P3** = nice-to-have / may drop.

### 1.1 Viewing & navigation (Reader)
| Feature | Priority | Notes |
|---|---|---|
| Open PDF (file dialog, drag-drop, recent files, open-from-URL) | P0 | |
| Multi-document tabs / windows | P0 | |
| Page rendering, zoom (25–6400%), fit page/width/visible | P0 | Tiled, virtualized |
| Scroll modes: single page, continuous, two-page, two-page continuous, cover page | P0 | |
| Rotate view, full screen, presentation mode | P0 | |
| Thumbnails, bookmarks, outline, page labels | P0 | |
| Text search (find, find-all, whole-word/case, search results panel) | P0 | Multi-PDF folder search P2 |
| Text selection, copy, select-all, Snapshot tool (copy region as image) | P0 | |
| Go to page, back/forward history, hyperlinks, named destinations | P0 | |
| Dark/light theme, high-contrast, UI scaling | P0 | |
| Read Out Loud (TTS) | P2 | OS speech API |
| Accessibility view: reflow, tagged-PDF reading order, screen reader support | P1 | |
| Layers (OCG) panel, attachments panel, signatures panel, tags panel | P1 | |
| Document properties (metadata, fonts, security, initial view) | P0 | |
| Split view / compare side-by-side, synchronized scrolling | P1 | |
| Print (scaling, booklet, poster, tile, custom pages, print-to-PDF) | P0 | Desktop native print; web via print CSS/blob |
| Measuring tools (distance, perimeter, area) | P2 | |
| PDF Portfolio / packages (embedded files) | P3 | |
| 3D, rich media, Flash/SWF | P3 | Deprecated by Adobe; skip |

### 1.2 Comment & review (Reader + Pro)
| Feature | Priority |
|---|---|
| Highlight, underline, strikethrough, squiggly, replace/insert text | P0 |
| Sticky note, text box, callout | P0 |
| Freehand pencil, eraser, shapes (line, arrow, rect, ellipse, polygon, cloud, polyline) | P0 |
| Stamps (standard, dynamic, custom, image stamps) | P1 |
| Attach file / audio comment | P2 |
| Comments list: sort/filter, reply threads, status, resolve, summary export | P0 |
| Import/export comments (XFDF/FDF) | P1 |
| Shared reviews (email / shared-folder / internal server) | P1 |
| Comment sync across users via internal server, @mentions | P2 |

### 1.3 Forms, signing
| Feature | Priority |
|---|---|
| Fill AcroForm fields (text, checkbox, radio, dropdown, list, button, date) | P0 |
| Auto-complete, form-field highlighting, tab order, calculated fields, validation | P1 |
| Form JavaScript (Acrobat JS subset: AFNumber_Format, AFDate, calculate, validate) | P1 |
| XFA dynamic forms | P3 — render fallback message only |
| Fill & Sign: typed/drawn/image signatures, initials, date, checkmark, text | P0 |
| Flatten form, save form data, export/import data (FDF/XFDF/CSV/JSON) | P1 |
| Prepare Form: auto-detect fields, add/edit fields, properties, tab order, distribute, alignment | P1 |
| Collect responses / multi-form data consolidation | P2 |
| Request e-signatures (workflow, audit trail, reminders) | P2 — internal service, email/SSO |
| Digital signatures (PKCS#7/PAdES, visible/invisible, timestamp, LTV, validation, certificate trust list) | P1 |
| Certificate-based document certification (MDP permissions) | P2 |

### 1.4 Create / Export / Convert
| Feature | Priority | Engine |
|---|---|---|
| Create from images (JPG/PNG/TIFF), text, blank page | P0 | pdf-lib / sharp |
| Create from Word/Excel/PowerPoint/HTML/RTF | P1 | LibreOffice headless (server) |
| Create from clipboard, screenshot, scanner (WIA/TWAIN/SANE) | P2 | |
| Print-to-PDF virtual printer driver | P3 | |
| Export to images (JPG/PNG/TIFF), text, HTML | P1 | |
| Export to Word/Excel/PowerPoint | P2 | Hardest fidelity problem; layout-analysis + docx generation (see risks) |
| Export selected pages, extract images | P1 | |
| Compress PDF, Optimize (downsample, remove unused objects, subset fonts, linearize) | P1 | qpdf + sharp + pdfium |
| OCR (searchable text, multi-language, auto-deskew) | P1 | Tesseract/OCRmyPDF (server or WASM) |
| PDF/A, PDF/X, PDF/E conversion + Preflight checks | P2 | veraPDF (validate) + conversion pipeline |
| Web capture (URL → PDF) | P2 | Headless Chromium |

### 1.5 Edit & organize
| Feature | Priority |
|---|---|
| Organize pages: reorder (drag), rotate, delete, insert, extract, replace, duplicate | P0 |
| Merge / combine files, split by pages/size/bookmarks | P0 |
| Crop pages, resize, add blank page | P1 |
| Header/footer, page numbers, Bates numbering | P1 |
| Watermark, background (image/color) | P1 |
| Edit text (reflow within text box, font substitution warnings), edit images (replace, crop, rotate), edit links | P2 |
| Add text/images/shapes as new content objects | P1 |
| Edit document metadata, attach files, JavaScript actions | P1 |
| Action Wizard / batch processing (macro of steps over folders) | P2 |
| Compare Files (text + visual diff, change report) | P2 |
| Undo/redo, autosave, recover | P0 |

### 1.6 Protect & compliance
| Feature | Priority |
|---|---|
| Password protect (AES-256), permissions (print, copy, edit) | P1 |
| Certificate-based encryption | P2 |
| Redaction: mark areas/text, search-and-redact patterns (SSN, email, regex), apply = true removal of content | P1 |
| Sanitize document (strip metadata, hidden text, comments, JS, attachments) | P1 |
| Remove hidden info, Examine document | P1 |
| Accessibility checker + fix tools (alt text, tags, reading order, language, auto-tag) | P2 |
| Audit logging for compliance | P2 (internal) |

### 1.7 AI features (Acrobat AI Assistant equivalent)
Document Q&A with citations, summaries, key-point extraction, multi-document chat, "find contract terms", suggested form fields, auto-tag alt text → **P2** via Claude API (model `claude-sonnet-5-5` default; `claude-opus-5-5` for hard extraction), RAG over chunked text.

### 1.8 Platform & integration
Auto-update, crash reporting, telemetry (opt-in, internal), file association, protocol handler, shell "Open with/Convert to PDF" context menu, SSO login, internal cloud storage connector (SharePoint/OneDrive/S3/network share), browser extension (open PDFs in PDF Suite), Microsoft Office add-in "Save as PDF Suite" (P3), Teams/Outlook attachments (P3), i18n (EN first, string externalization from day 1), enterprise policy (MSI + GPO/registry settings).

---

## 2. Architecture

### 2.1 Principles
1. **One engine API, many backends.** The UI talks only to `@pdfsuite/engine` (interface). Implementations: `pdfium-wasm` (web + desktop, default), `pdfium-native` (desktop, optional perf boost), `pdfjs` (fallback / text layer / a11y reference).
2. **One UI codebase.** React app shared by web and desktop; platform differences isolated behind a `Platform` interface (files, print, dialogs, updater, keychain).
3. **Heavy jobs = services.** OCR, Office conversion, PDF→Office, web capture, batch run in a job queue (server for web; same service container locally or bundled sidecar for desktop where possible).
4. **Command pattern for all edits** → undo/redo, autosave, collaboration later.
5. **Licensing-clean.** No AGPL/GPL in distributed binaries (see §6).

### 2.2 Components
```
apps/
  web/              Vite + React SPA (PWA, File System Access API)
  desktop/          Electron shell (main process, IPC, auto-update, native print, scanner)
packages/
  engine/           Engine interface + PDFium WASM binding + pdf-lib structural ops + PDF.js fallback
  viewer/           Page virtualization, tile renderer, text layer, selection, search index
  annotations/      Annotation model <-> PDF annots, XFDF import/export, tools
  forms/            AcroForm model, field editor, JS sandbox (Acrobat JS subset)
  editor/           Content-stream parser/writer, text/image object editing, redaction core
  security/         Encryption, signatures (PAdES), cert store, timestamping, sanitize
  ui/               Design system (Radix/Fluent-style components, theme tokens, icons — original set)
  app-core/         State (Zustand), commands/undo, tabs, settings, i18n, shortcuts, telemetry
  services-client/  Typed client for job service
services/
  api/              Node (Fastify) — auth (OIDC/SSO), storage connectors, review/sign workflows
  worker/           Job workers: ocr, convert-office, export-office, webcapture, compress, preflight, batch
  ai/               Claude API gateway, chunking/embedding, citation mapping
tools/              Test corpus runner, visual-regression, benchmark harness
```

### 2.3 Tech choices
| Concern | Choice | Reason / alternative |
|---|---|---|
| Language | TypeScript (strict) | Worker/service code in TS; PDFium glue in C++→WASM |
| UI | React 18 + Vite, Zustand, Radix primitives, Tailwind or CSS Modules | |
| Desktop shell | **Electron** | Same Chromium everywhere ⇒ identical WASM/Canvas behavior, one language. Tauri is the lighter option if Rust is acceptable (native PDFium via `pdfium-render`); decision gate in Phase 0 |
| Render engine | PDFium (BSD-3 / Apache-2) built to WASM (e.g. EmbedPDF/pdfium-wasm builds or own Emscripten build) | Fast, complete forms + annotation + redaction-friendly APIs |
| Text layer, a11y fallback | PDF.js (Apache-2) | Strong text layer, Reflow reference |
| Structural edits | pdf-lib (MIT) + qpdf (Apache-2, CLI/WASM) | merge/split/linearize/encrypt/repair |
| Content-stream edits | Custom parser on top of PDFium object API + own operator filter | needed for edit/redact |
| Signatures | `@signpdf` / pkijs + node-forge; OS cert store via native addon (Windows CertStore) | PAdES-B-T/LT |
| OCR | Tesseract 5 (Apache-2) via worker; optional OCRmyPDF pipeline | |
| Office→PDF | LibreOffice headless (MPL-2) | fidelity limits vs MS Office; optional MS Graph/Word automation on Windows |
| PDF→Office | Layout analysis (pdfium text/objects) + docx/xlsx/pptx generators (`docx`, `exceljs`, `pptxgenjs`) | custom; see risks |
| Validation | veraPDF (MPL-2 option) for PDF/A; custom checks for accessibility | |
| AI | Anthropic API via `services/ai` | Keys server-side only |
| Storage/Jobs | Postgres + S3-compatible (MinIO) + BullMQ/Redis | |
| Auth | OIDC (Azure AD/Okta) | |
| Packaging | electron-builder (MSI/MSIX/DMG/AppImage), Docker Compose / Helm for services | |
| Testing | Vitest, Playwright, pixel-diff (pixelmatch), corpus tests | |

### 2.4 Core design details
- **Rendering**: page virtualization (only visible ±2 pages mounted), tile-based canvas rendering in Web Workers w/ OffscreenCanvas, LRU bitmap cache, progressive low-res → high-res, device-pixel-ratio aware. Needs COOP/COEP headers for SharedArrayBuffer/threads in web build.
- **Large files**: range-request / chunked loading from disk (desktop: memory-mapped via native module; web: File/Blob slices), lazy page tree parsing, memory budget with eviction (target: 1,000-page / 500 MB file < 600 MB RAM).
- **Document model**: `DocumentSession { engineDoc, commandStack, dirtyState, saveState }`. Edits are commands (`AddAnnotation`, `MovePage`, `ReplaceTextRun`…), each with `do/undo/serialize`. Incremental save by default (preserves existing signatures); "Save As / Optimize" does full rewrite.
- **Annotation interop**: write standard PDF annotations (Highlight, Text, FreeText, Ink, Stamp, etc.) with appearance streams so Acrobat/Foxit/Chrome render them; round-trip tested.
- **Forms JS**: run Acrobat JS subset in a sandboxed QuickJS-WASM; implement `event`, `this.getField`, `AFNumber_*`, `AFDate_*`, `AFSimple_Calculate`, `app.alert`; no network/filesystem.
- **Redaction**: (1) mark phase (annotation), (2) apply phase rewrites content streams — removes text show operators / clips images / splits image XObjects overlapping regions, removes from metadata, bookmarks, form fields, comments, alt text, hidden layers, previous incremental revisions (forces full rewrite). Verified by post-apply text extraction + byte search tests.
- **Text editing**: parse text objects into lines/paragraph "editable blocks" using font metrics; edit with glyph availability check; if embedded font subset lacks glyphs, substitute (warn) or embed fallback; reflow only within block. Start with single-line edit, then paragraph-reflow.
- **Security model (desktop)**: Electron `contextIsolation: true`, no `nodeIntegration`, strict CSP, sandboxed renderer, PDFium/JS in workers, untrusted-PDF fuzzing, signed updates.
- **Telemetry & logging**: opt-in, internal OTLP endpoint; never send document content (AI features send content only when user invokes them and policy allows).

---

## 3. Phased implementation plan

Assumed team: **5–6 engineers** (2 front-end, 1 engine/C++-WASM, 1 backend/services, 1 full-stack, 0.5 QA + 0.5 design). Durations are calendar weeks for that team; scale accordingly.

### Phase 0 — Foundation & decisions (3 wks)
- Monorepo (pnpm + Turborepo), CI (build, lint, test, license scan), coding standards, ADRs.
- Build PDFium → WASM (threads, SIMD), publish `@pdfsuite/engine` skeleton; PDF.js fallback adapter.
- Spike & decide: Electron vs Tauri; native PDFium vs WASM benchmark on 10 reference PDFs.
- Design system tokens, original icon set, app shell (tabs, toolbar, side panels), theme, i18n scaffolding.
- Assemble **test corpus**: pdf.js test PDFs, veraPDF corpus, scanned docs, large docs, forms, signed docs, internal sample docs (with approval).
- **Exit**: open a PDF and render page 1 in both web and desktop shells.

### Phase 1 — Viewer core (6 wks) → *Reader MVP-a*
Open/recent/drag-drop, tabs, virtualized continuous scroll, zoom/fit modes, page modes, rotate, thumbnails, bookmarks, text layer & selection/copy, search (+ results panel), links, full screen/presentation, properties, print (basic), dark mode, keyboard shortcuts, settings, crash handling.
- **Exit**: perf budget met (first page < 1 s on 10 MB file; 60 fps scroll on 200-page doc; search 500-page doc < 3 s).

### Phase 2 — Annotations & comments (5 wks)
Annotation model + appearance streams, highlight/underline/strike/squiggly, notes, text box/callout, ink, shapes, stamps (basic), comments panel with threads/filter/sort, select/move/resize/delete, properties toolbar, undo/redo, incremental save, XFDF import/export, interop test with Acrobat/Foxit/Chrome.
- **Exit**: annotations saved in PDF Suite render identically in 3 other viewers.

### Phase 3 — Forms & Fill & Sign (5 wks) → *Reader MVP-b (= first internal release)*
Fill AcroForm fields, tab order, highlighting, calculations/validation via JS sandbox, flatten, save/import/export data, Fill & Sign (typed/drawn/image signature + initials library stored in OS keychain/profile), basic digital signature **validation** UI.
- **Exit**: pass form corpus (≥ 95% of AFNumber/AFDate/simple-calculate cases).
- **Release 0.1** to pilot group (Reader-equivalent).

### Phase 4 — Page organization & document assembly (4 wks)
Organize-pages view (drag reorder/rotate/delete/insert/extract/replace), merge (multi-file with page ranges), split (pages/size/bookmarks), crop/resize, header/footer/page numbers/Bates, watermark/background, add blank pages, metadata & attachments editing, bookmarks editor, create from images/blank.
- **Exit**: merge/split correctness verified on corpus (no lost bookmarks, links, forms; named dests remapped).

### Phase 5 — Backend services, convert, compress, OCR (6 wks)
Fastify API + auth (OIDC), job queue, storage connectors, worker framework. Features: Office→PDF (LibreOffice), HTML/URL→PDF, export to images/text/HTML, compress/optimize (qpdf + image recompression + font subsetting), OCR (Tesseract, multi-lang, deskew), scan-to-PDF (Windows WIA first), progress UI, cancel, offline-queue behavior on desktop.
- **Exit**: SLAs — 100-page OCR < 5 min; Office→PDF 20-page < 15 s; compress yields ≥ 40% median on image-heavy corpus.

### Phase 6 — Security & compliance (7 wks)
Password encryption (AES-256), permissions; certificate encryption; **digital signing** (PAdES-B-B/B-T/B-LT, visible appearance, timestamp, cert from OS store/PFX/HSM via PKCS#11), signature validation (trust list, revocation OCSP/CRL, LTV), certify document (MDP); **redaction** (mark, search-patterns, apply w/ full removal, verify report); sanitize/remove hidden info; examine document; audit log.
- **Exit**: signatures validate in Acrobat; redaction test-suite proves removed text isn't extractable via 3 independent extractors (pdfium, pdf.js, qpdf+strings).
- Security review / pen test of file handling and services.

### Phase 7 — Content editing (9 wks) — highest-risk phase
Content-stream parser/writer; edit images (replace, resize, crop, delete, export); add text/image/shape objects; edit single-line text, then paragraph reflow w/ font handling (embed fallback, glyph warnings); edit links; reading-order/tags preserved; object selection/inspect; undo/redo for content edits.
- **Exit**: text edit round-trip on 50 diverse PDFs without corrupting layout > agreed tolerance (visual diff < 0.5% outside edited area).
- **Release 0.5** (Pro-essentials).

### Phase 8 — Advanced Pro (10 wks, parallelizable)
- **Prepare Form** (auto field detection via layout heuristics + AI assist, create/edit fields, properties, distribute/align, calculation builder).
- **Compare files** (text diff by block + visual diff overlay + report).
- **Action Wizard / batch** (step DSL: OCR → compress → watermark → save; folder watch; run history).
- **Preflight / PDF/A-1b/2b/3b convert + validate (veraPDF)**, fix-ups.
- **Accessibility**: checker (tags, language, alt text, reading order, table headers), tag tree editor, auto-tag (heuristic + AI), reading-order tool.
- **Export to Word/Excel/PowerPoint** (layout analysis → docx/xlsx/pptx) — fidelity "good, not perfect".
- **E-signature requests** (internal workflow: recipients, order, SSO/OTP, audit trail PDF, reminders, templates).
- **Shared review / comment sync** server (WebSocket), measure tools, layers panel, TTS.
- **Release 0.8**.

### Phase 9 — AI assistant (4 wks, can start after Phase 5)
Server-side chunking + page-anchored citations, doc Q&A, summarize, key terms/clauses extraction, multi-doc chat, "explain this selection", tag/alt-text suggestions, form-field suggestions; admin policy (enable/disable, data residency, redaction-before-send), prompt-injection hardening (PDF content treated as data), evals on internal sample set.
- Model defaults: `claude-sonnet-5-5`; `claude-opus-5-5` for complex extraction; prompt caching for long docs.

### Phase 10 — Hardening, packaging, rollout (4 wks + ongoing)
Perf tuning, memory leak sweeps, fuzzing (corpus mutation + libFuzzer on native parts), accessibility audit of our own UI (WCAG 2.1 AA, screen reader), localization pass, installer (MSI/MSIX + GPO templates), auto-update channel, documentation/training, helpdesk runbooks, staged rollout (pilot → dept → company).

**Totals**: ~63 weeks sequential; with overlap (Phases 5/6/9 parallel to 7/8) ≈ **12–14 months** to full parity with 5–6 engineers. Pilot-usable Reader+ at ~month 6, Pro-essentials at ~month 9.

---

## 4. Milestones & release gates
| Release | Content | Target |
|---|---|---|
| Alpha | Phases 0–1 viewer | Month 2.5 |
| **0.1 Pilot** | + annotations, forms, fill&sign | Month 5 |
| 0.3 | + organize/merge/split + services (convert/OCR/compress) | Month 7.5 |
| **0.5** | + security/redaction/signing + content editing | Month 10 |
| 0.8 | + prepare forms, compare, batch, preflight, a11y, export to Office | Month 13 |
| **1.0** | + AI assistant, hardening, GA rollout | Month 14 |

Release gate (each): corpus pass rate, perf budgets, 0 known data-loss bugs, security checklist, interop checks.

---

## 5. Quality strategy
- **Corpus & regression**: ≥ 2,000 PDFs (valid, malformed, huge, scanned, signed, tagged, XFA, encrypted); render golden images per release; pixel-diff tolerance gate.
- **Interop matrix**: output opened in Acrobat Reader, Chrome, Edge, Foxit, macOS Preview; input from Word/LibreOffice/InDesign/scanners.
- **Automated**: unit (Vitest), integration (Playwright on web + Electron), engine tests in native harness, nightly fuzz, performance benchmarks tracked per commit.
- **Security**: malicious PDF handling (JS disabled by default except forms sandbox), decompression-bomb limits, SSRF guards on web capture, dependency/license scanning, annual pen test.
- **Data safety**: autosave to recovery folder, atomic save (write temp + rename), never overwrite original without backup option.

---

## 6. Licensing & legal checklist (internal tool)
- Do **not** use: Adobe name/logo/icons/UI-pixel assets, Adobe fonts (Myriad, Minion), Adobe trademarks in UI text or file associations. Original branding and icon set.
- **Avoid in distributed builds**: MuPDF/PyMuPDF (AGPL), Ghostscript (AGPL), iText (AGPL). If any is used on internal servers, get Legal sign-off on AGPL network-use clause.
- Safe: PDFium (BSD-3/Apache), PDF.js (Apache), pdf-lib (MIT), qpdf (Apache-2), Tesseract (Apache-2), LibreOffice (MPL-2, as external process), veraPDF (MPL-2 option), pkijs/node-forge (BSD/MIT).
- Fonts: bundle only OFL/Apache fonts (Noto, Liberation, Source Sans) as fallback.
- Run automated license scan (e.g., FOSSA/ScanCode) in CI; maintain SBOM.
- Patents: PDF is ISO 32000 (open); XFA/Acrobat JS API are publicly documented — implement from spec only.
- Data privacy: AI and cloud features require data-classification policy; configurable off-switch.

---

## 7. Key risks & mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Text editing fidelity (fonts, subsets, reflow) | High | Ship single-line editing first; font fallback & warnings; extensive corpus; set expectation vs Acrobat |
| PDF→Word/Excel/PPT quality | High | Time-box; start with Word text/flow + tables; allow optional MS Office/commercial SDK later; mark "best effort" |
| True redaction correctness | High (legal) | Independent verification tests; show "what will be removed" report; security review before release |
| WASM performance / memory in web | Med | Tiling, workers, native PDFium option on desktop, memory budget tests |
| Signature/LTV interop | Med | Test against Acrobat validation; use proven libs; PAdES conformance tests |
| XFA / exotic features | Low-Med | Explicitly out of scope; detect & show clear message / suggest legacy viewer |
| Scope creep from "full parity" | High | MoSCoW per phase, publish a parity matrix, internal-user telemetry to cut unused P3 items |
| Single-point engine expertise (C++/WASM) | Med | Pair, document build, pin PDFium versions, upstream tracking cadence |
| Malicious PDFs | High | Sandboxing, fuzzing, resource limits, JS off by default |

---

## 8. Assumptions (please correct if wrong)
1. Team of 5–6 engineers; one-year-plus runway is acceptable. Otherwise cut scope: ship after Phase 4 (+ OCR/compress from Phase 5) as "Reader+".
2. Windows is the primary desktop target; macOS second; Linux optional.
3. Internal SSO is OIDC (Azure AD/Okta); an internal server environment (Docker/K8s) is available for services and AI gateway.
4. English UI first; i18n-ready.
5. Cloud storage = SharePoint/OneDrive or S3-compatible; network shares via OS.
6. AI features may send document content to the Anthropic API subject to company data policy.
7. Offline desktop use is required for P0/P1 features that don't depend on services.

## 9. Immediate next steps (first 2 weeks)
1. Confirm assumptions (§8) and parity priority order.
2. Phase 0 spikes: PDFium WASM build + render benchmark; Electron vs Tauri decision; license scan of candidate deps.
3. Collect test corpus and agree on sample internal documents.
4. Produce UI wireframes (original design language) for: viewer shell, comments panel, organize pages, form editor, redaction flow.
5. Stand up repo + CI and start Phase 1.
