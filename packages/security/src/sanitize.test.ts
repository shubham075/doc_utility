import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import type { PdfEngine } from '@pdfsuite/engine';
import { SANITIZE_ALL, examineDocument, sanitizePdf } from './sanitize';
import { makeEngines, pageTexts } from './testutil';

let engines: PdfEngine[] = [];
beforeAll(async () => {
  engines = await makeEngines();
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

const raw = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
/** True if the text appears literally or hex-encoded (as pdf-lib writes non-ASCII-safe strings) in the file. */
const has = (b: Uint8Array, s: string) => {
  const r = raw(b);
  const hex8 = Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
  const hex16 = 'FEFF' + Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
  const up = r.toUpperCase();
  return r.includes(s) || up.includes(hex8) || up.includes(hex16);
};

/** A document that carries one of everything sensitive, each tagged with a unique marker string. */
async function dirtyDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const page = doc.addPage([300, 300]);
  page.drawText('Visible body text', { x: 20, y: 200, size: 14, font });
  doc.setAuthor('MARKER_AUTHOR');
  doc.setTitle('MARKER_TITLE');
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream('<x:xmpmeta>MARKER_XMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));

  const js = (src: string) => ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of(src) });
  doc.catalog.set(PDFName.of('OpenAction'), js('app.alert("MARKER_OPEN")'));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: ctx.obj({ Names: [PDFString.of('boot'), js('MARKER_DOCJS()')] }), EmbeddedFiles: ctx.obj({ Names: [PDFString.of('MARKER_attached.txt'), ctx.obj({ Type: 'Filespec', F: PDFString.of('MARKER_attached.txt') })] }) }));

  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], A: ctx.obj({ S: PDFName.of('URI'), URI: PDFString.of('https://marker.example/') }) }));
  const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 250, 40, 270], Contents: PDFHexString.fromText('MARKER_COMMENT') }));
  const attach = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [50, 250, 70, 270], FS: ctx.obj({ Type: 'Filespec', F: PDFString.of('MARKER_annot_file.bin') }) }));
  page.node.set(PDFName.of('Annots'), ctx.obj([link, note, attach]));
  page.node.set(PDFName.of('Thumb'), ctx.register(ctx.stream('MARKER_THUMB')));
  page.node.set(PDFName.of('PieceInfo'), ctx.obj({ App: ctx.obj({ Private: PDFString.of('MARKER_PRIVATE') }) }));

  const field = doc.getForm().createTextField('name');
  field.addToPage(page, { x: 20, y: 100, width: 120, height: 20, font });
  field.setText('MARKER_FIELD_VALUE');
  field.acroField.dict.set(PDFName.of('AA'), ctx.obj({ K: js('MARKER_FIELDJS()') }));

  const outline = ctx.register(ctx.obj({ Title: PDFHexString.fromText('MARKER_BOOKMARK'), Dest: [page.ref, PDFName.of('Fit')] }));
  const root = ctx.register(ctx.obj({ Type: 'Outlines', First: outline, Last: outline, Count: 1 }));
  (ctx.lookup(outline) as import('pdf-lib').PDFDict).set(PDFName.of('Parent'), root);
  doc.catalog.set(PDFName.of('Outlines'), root);
  // an unreferenced object left behind by earlier edits
  ctx.register(ctx.stream('MARKER_ORPHAN'));
  return doc.save({ useObjectStreams: false });
}

describe('examineDocument', () => {
  it('reports everything sensitive in the file', async () => {
    const f = await examineDocument(await dirtyDoc());
    expect(f.metadata.infoFields).toMatchObject({ Author: 'MARKER_AUTHOR', Title: 'MARKER_TITLE' });
    expect(f.metadata.xmp).toBe(true);
    expect(f.javascript).toMatchObject({ documentLevel: 1, openAction: true, fieldActions: 1 });
    expect(f.attachments.sort()).toEqual(['MARKER_annot_file.bin', 'MARKER_attached.txt']);
    expect(f.annotations).toMatchObject({ total: 4, comments: 1, links: 1 }); // + the form widget
    expect(f.annotations.byType).toMatchObject({ Link: 1, Text: 1, FileAttachment: 1, Widget: 1 });
    expect(f.externalLinks).toBe(1);
    expect(f.bookmarks).toBe(1);
    expect(f.thumbnails).toBe(1);
    expect(f.privateData).toBe(true);
    expect(f.formFields).toBe(1);
  });

  it('flags files that were saved incrementally', async () => {
    const base = await dirtyDoc();
    const appended = new Uint8Array([...base, ...new TextEncoder().encode('\n%%EOF\n')]);
    expect((await examineDocument(base)).previousVersions).toBe(false);
    expect((await examineDocument(appended)).previousVersions).toBe(true);
  });
});

describe('sanitizePdf', () => {
  it('removes every category, leaves no trace of the markers and keeps the page readable', async () => {
    const src = await dirtyDoc();
    for (const m of ['MARKER_AUTHOR', 'MARKER_XMP', 'MARKER_OPEN', 'MARKER_DOCJS', 'MARKER_attached', 'MARKER_COMMENT', 'MARKER_annot_file', 'MARKER_THUMB', 'MARKER_PRIVATE', 'MARKER_FIELDJS', 'MARKER_BOOKMARK', 'MARKER_ORPHAN', 'marker.example']) {
      expect(has(src, m), m).toBe(true);
    }
    const { bytes, removed } = await sanitizePdf(src);
    for (const m of ['MARKER_AUTHOR', 'MARKER_TITLE', 'MARKER_XMP', 'MARKER_OPEN', 'MARKER_DOCJS', 'MARKER_attached', 'MARKER_COMMENT', 'MARKER_annot_file', 'MARKER_THUMB', 'MARKER_PRIVATE', 'MARKER_FIELDJS', 'MARKER_BOOKMARK', 'MARKER_ORPHAN', 'marker.example']) {
      expect(has(bytes, m), m).toBe(false);
    }
    expect(removed).toMatchObject({ metadata: expect.any(Number), javascript: expect.any(Number), attachments: expect.any(Number), comments: 1, links: 1, bookmarks: 1, thumbnails: 1, privateData: 1 });
    expect(removed.orphanObjects).toBeGreaterThan(0);
    const after = await examineDocument(bytes);
    expect(after.metadata).toEqual({ infoFields: {}, xmp: false });
    expect(after.javascript).toEqual({ documentLevel: 0, openAction: false, fieldActions: 0, annotationActions: 0 });
    expect(after.attachments).toEqual([]);
    expect(after.annotations.byType).toEqual({ Widget: 1 }); // the form field stays unless flattened
    expect(after.bookmarks + after.thumbnails).toBe(0);
    for (const e of engines) expect((await pageTexts(e, bytes))[0]).toContain('Visible body text');
  });

  it('honours the selected options only', async () => {
    const { bytes } = await sanitizePdf(await dirtyDoc(), { ...Object.fromEntries(Object.keys(SANITIZE_ALL).map((k) => [k, false])), metadata: true } as never);
    const f = await examineDocument(bytes);
    expect(f.metadata.infoFields).toEqual({});
    expect(f.javascript.documentLevel).toBe(1);
    expect(f.attachments.length).toBe(2);
    expect(f.bookmarks).toBe(1);
  });

  it('flattens form fields into the page when asked', async () => {
    const { bytes } = await sanitizePdf(await dirtyDoc(), { flattenForms: true });
    expect((await examineDocument(bytes)).formFields).toBe(0);
    expect((await pageTexts(engines[0]!, bytes))[0]).toContain('MARKER_FIELD_VALUE'); // value now lives in page content
  });
});
