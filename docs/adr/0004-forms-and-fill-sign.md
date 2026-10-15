# ADR 0004 — Forms and Fill & Sign (Phase 3)

Status: accepted

## Decisions
- **`@pdfsuite/forms`** reads the AcroForm with pdf-lib into a display-space model (fields, widgets, options, flags, MK colours, /AA scripts, /CO order, document-level JS, `/Tabs` tab order) and writes values back, regenerating appearance streams **only for changed fields** (the display text of formatted fields, e.g. "$1,234.00", is drawn while the raw value stays in /V). `flatten` burns appearances into the page.
- **The viewer draws fillable widgets itself** (`FormLayer`, real inputs: text, multiline, password, checkbox, radio, dropdown, list). The render copy strips fillable widgets (Tx/Ch/Btn, not push buttons or signature fields) together with managed annotations, so nothing is drawn twice.
- **JavaScript runs in QuickJS (WebAssembly)**, one fresh context per script: no DOM/network/file access, 400 ms CPU deadline, 32 MB memory cap. Inputs go in as one JSON literal, outputs (field patch, `event.value`, `event.rc`, alerts) come back as one JSON string — no host callbacks. A JS prelude implements the Acrobat subset: `event`, `this.getField` (value, valueAsString, readonly, …), `app.alert`, `util.printf/printd/scand`, `AFNumber_*`, `AFPercent_*`, `AFDate_*`, `AFTime_*`, `AFSpecial_*`, `AFSimple_Calculate` (SUM/AVG/PRD/MIN/MAX), `AFRange_Validate`, `AFMergeChange`.
- **Commit pipeline** (`FormEngine`): keystroke → validate → store → calculate in /CO order → format. A rejected keystroke/validate keeps the old value and shows the alert. Fields are edited raw and shown formatted when unfocused.
- **Tab order** follows `/Tabs` (R/C/S) per page; Tab/Shift+Tab skip read-only fields and scroll to widgets on other pages.
- **Fill & Sign**: text, today's date, ✓ ✗ ● — marks (all ordinary editable annotations), and **signature / initials** created by drawing, typing (script font rendered to PNG, so no PDF font is needed) or uploading an image (optional white-to-transparent). Saved in `localStorage`; placed as a new `stamp` annotation (PNG/JPEG embedded as an image XObject, upright on rotated pages). Clicking an unsigned signature field places the signature into the field box.
- Stamps written by us carry the NM prefix `ps-stamp:`: managed (deletable/replaceable) within the session, but left as page content when a saved file is reopened (the image is not parsed back).
- Save pipeline: form values (`writeForm`) then annotations (`writeAnnotations`); "Flatten & save" produces a copy and leaves the open document fillable; "Export data" downloads field values as JSON.

## Verification
- `@pdfsuite/forms`: 20 tests — script runtime (formats, validation, calc helpers, dates, util.printf, sandbox has no host APIs, runaway/memory/syntax errors), reader (types, values, display-space geometry incl. rotated page, calc and tab order, radio /Opt mapping), engine (validate/calculate/format/reject/reset), writer (round trip, PDFium + PDF.js draw the values, flatten).
- `@pdfsuite/annotations`: stamps render at the right place on normal and rotated pages in PDFium and PDF.js.
- Browser run: typing with Tab order, date/phone/currency/percent formatting, live calculation, range-validation alert, radio/checkbox, drawn signature + check + date placement, Save (values + annotations + stamp pixels verified), Flatten (0 fields remain).

## Known limitations / follow-ups
- **Script DoS**: a hostile script that allocates in a tight loop can block the main thread for several seconds before the memory cap trips (QuickJS GC thrash; measured ~3–5 s). Move the runner to a Web Worker (Phase 10 hardening).
- No XFA (AcroForm fallback only), no per-keystroke script events (scripts run on commit), no rich text, comb fields render as plain inputs, editable combos are plain selects, fields hidden by script `display` are not hidden, no FDF/XFDF import/export (JSON export only), push-button actions and signature-field *digital* signing are Phase 6.
- Typed signatures depend on a script font being installed on the signer's machine at creation time (the result is a PNG, so viewers are unaffected).
- Text values the standard font cannot encode become `?` in the saved appearance (same limitation as free text).
- Unsigned signature field click-to-place was not exercised end to end (pdf-lib cannot create signature fields for a fixture).
- Saving still rewrites the whole file with pdf-lib: existing digital signatures are invalidated.
