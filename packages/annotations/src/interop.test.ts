import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine, type RenderedBitmap } from '@pdfsuite/engine';
import {
  baseFields,
  readAnnotations,
  stripMarkupAnnotations,
  writeAnnotations,
  type Annotation,
  type FreeTextAnnotation,
  type MarkupAnnotation,
} from './index';

type RGB = [number, number, number];

async function makeBase(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([300, 400]);
    p.drawText(`Page ${i + 1}`, { x: 10, y: 380, size: 8, font });
    if (i === 1) p.setRotation({ type: 'degrees', angle: 90 } as never);
  }
  // A foreign Link annotation that must survive every operation untouched.
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0] }));
  doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([link]));
  return doc.save();
}

const f = (page: number, color: string, opacity = 1) => baseFields(page, 'Tester', color, opacity);

function sample(): Annotation[] {
  return [
    { ...f(0, '#ffeb3b'), id: 'hl', type: 'highlight', quads: [{ x: 20, y: 50, width: 100, height: 14 }], contents: 'important' },
    { ...f(0, '#ff0000'), id: 'ul', type: 'underline', quads: [{ x: 20, y: 100, width: 100, height: 14 }] },
    { ...f(0, '#ff0000'), id: 'st', type: 'strikeout', quads: [{ x: 20, y: 150, width: 100, height: 14 }] },
    { ...f(0, '#ff0000'), id: 'sq', type: 'squiggly', quads: [{ x: 140, y: 100, width: 100, height: 14 }] },
    { ...f(0, '#00ff00'), id: 'note', type: 'note', x: 200, y: 50, contents: 'a note' },
    {
      ...f(0, '#000000'),
      id: 'ft',
      type: 'freetext',
      rect: { x: 20, y: 200, width: 160, height: 60 },
      fontSize: 14,
      fill: '#ccddff',
      borderWidth: 1,
      contents: 'Hello world from PDF Suite',
    } as FreeTextAnnotation,
    { ...f(0, '#ff0000'), id: 'ink', type: 'ink', strokes: [[{ x: 200, y: 200 }, { x: 225, y: 230 }, { x: 250, y: 260 }]], width: 4 },
    { ...f(0, '#0000ff'), id: 'rect', type: 'square', rect: { x: 200, y: 300, width: 60, height: 40 }, width: 3, fill: null },
    { ...f(0, '#000000'), id: 'ell', type: 'circle', rect: { x: 20, y: 300, width: 80, height: 60 }, width: 2, fill: '#00ff00' },
    { ...f(0, '#ff00ff'), id: 'line', type: 'line', p1: { x: 20, y: 380 }, p2: { x: 120, y: 380 }, width: 3, startStyle: 'none', endStyle: 'arrow' },
    { ...f(1, '#ffeb3b'), id: 'hl-rot', type: 'highlight', quads: [{ x: 50, y: 100, width: 120, height: 14 }] },
    { ...f(0, '#000000'), id: 'rp', type: 'reply', parentId: 'note', contents: 'a reply' },
  ] as Annotation[];
}

let engines: PdfEngine[] = [];
beforeAll(async () => {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  engines = [
    await createPdfiumEngine(),
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  ];
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

async function render(engine: PdfEngine, bytes: Uint8Array, page: number): Promise<RenderedBitmap> {
  const doc = await engine.open(bytes);
  const p = await doc.getPage(page);
  const bmp = await p.render({ scale: 1 });
  doc.close();
  return bmp;
}

const px = (b: RenderedBitmap, x: number, y: number): RGB => {
  const i = (Math.round(y) * b.width + Math.round(x)) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
};
/** True if any pixel in a small neighbourhood is within `tol` of the colour. */
const near = (b: RenderedBitmap, x: number, y: number, c: RGB, tol = 60, r = 1) => {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const p = px(b, x + dx, y + dy);
      if (Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol) return true;
    }
  return false;
};

describe('annotation round trip', () => {
  it('reads back what it wrote (all types, replies, status)', async () => {
    const base = await makeBase();
    const annots = sample();
    annots.find((a) => a.id === 'note')!.status = 'accepted';
    const out = await writeAnnotations(base, annots, new Set(annots.map((a) => a.id)));
    const { annotations } = await readAnnotations(out);

    expect(annotations.map((a) => a.id).sort()).toEqual(annots.map((a) => a.id).sort());
    const get = (id: string) => annotations.find((a) => a.id === id)!;

    const hl = get('hl') as MarkupAnnotation;
    expect(hl.type).toBe('highlight');
    expect(hl.contents).toBe('important');
    expect(hl.author).toBe('Tester');
    expect(hl.color).toBe('#ffeb3b');
    expect(hl.quads[0]!.x).toBeCloseTo(20, 1);
    expect(hl.quads[0]!.y).toBeCloseTo(50, 1);
    expect(hl.quads[0]!.width).toBeCloseTo(100, 1);
    expect(hl.quads[0]!.height).toBeCloseTo(14, 1);

    const rot = get('hl-rot') as MarkupAnnotation;
    expect(rot.page).toBe(1);
    expect(rot.quads[0]!.x).toBeCloseTo(50, 1);
    expect(rot.quads[0]!.y).toBeCloseTo(100, 1);
    expect(rot.quads[0]!.width).toBeCloseTo(120, 1);

    const ft = get('ft') as FreeTextAnnotation;
    expect(ft.contents).toBe('Hello world from PDF Suite');
    expect(ft.fontSize).toBe(14);
    expect(ft.fill).toBe('#ccddff');
    expect(ft.color).toBe('#000000');
    expect(ft.rect.width).toBeCloseTo(160, 1);

    expect(get('ink')).toMatchObject({ type: 'ink', width: 4 });
    expect((get('ink') as never as { strokes: { x: number }[][] }).strokes[0]![2]!.x).toBeCloseTo(250, 1);
    expect(get('line')).toMatchObject({ type: 'line', endStyle: 'arrow', startStyle: 'none', width: 3 });
    expect(get('ell')).toMatchObject({ type: 'circle', fill: '#00ff00' });
    expect(get('rect')).toMatchObject({ type: 'square', fill: null });

    expect(get('note').status).toBe('accepted');
    expect(get('rp')).toMatchObject({ type: 'reply', parentId: 'note', contents: 'a reply' });
  });

  it('keeps unrelated annotations and does not duplicate on re-save', async () => {
    const base = await makeBase();
    const annots = sample();
    const first = await writeAnnotations(base, annots, new Set(annots.map((a) => a.id)));
    const { annotations } = await readAnnotations(first);
    const second = await writeAnnotations(first, annotations, new Set());
    const again = await readAnnotations(second);
    expect(again.annotations).toHaveLength(annotations.length);

    const doc = await PDFDocument.load(second);
    const arr = doc.getPage(0).node.Annots()!;
    const subtypes: string[] = [];
    for (let i = 0; i < arr.size(); i++) subtypes.push((doc.context.lookup(arr.get(i), PDFDict).get(PDFName.of('Subtype')) as PDFName).decodeText());
    expect(subtypes.filter((s) => s === 'Link')).toHaveLength(1);
    expect(arr.size()).toBe(first.length ? (await PDFDocument.load(first)).getPage(0).node.Annots()!.size() : 0);
  });

  it('applies edits and deletions in place', async () => {
    const base = await makeBase();
    const annots = sample();
    const saved = await writeAnnotations(base, annots, new Set(annots.map((a) => a.id)));
    const { annotations } = await readAnnotations(saved);
    const edited = annotations
      .filter((a) => a.id !== 'ul' && a.id !== 'note' && a.id !== 'rp')
      .map((a) => (a.id === 'hl' ? ({ ...a, color: '#00ffff', contents: 'changed' } as Annotation) : a));
    const out = await writeAnnotations(saved, edited, new Set(['hl']));
    const back = await readAnnotations(out);
    const ids = back.annotations.map((a) => a.id);
    expect(ids).not.toContain('ul');
    expect(ids).not.toContain('note');
    expect(ids).not.toContain('rp');
    expect(back.annotations.find((a) => a.id === 'hl')).toMatchObject({ color: '#00ffff', contents: 'changed' });
    expect(back.annotations).toHaveLength(edited.length);
  });

  it('edits annotations authored by other tools in place', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    const ctx = doc.context;
    const ref = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [20, 336, 120, 350], C: [1, 1, 0], QuadPoints: [20, 350, 120, 350, 20, 336, 120, 336] }),
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([ref]));
    const bytes = await doc.save();

    const { annotations } = await readAnnotations(bytes);
    expect(annotations).toHaveLength(1);
    const a = annotations[0]!;
    expect(a.id).toMatch(/^ref:\d+-\d+$/);
    expect(a.color).toBe('#ffff00');
    const out = await writeAnnotations(bytes, [{ ...a, contents: 'edited' } as Annotation], new Set([a.id]));
    const back = await readAnnotations(out);
    expect(back.annotations).toHaveLength(1);
    expect(back.annotations[0]).toMatchObject({ id: a.id, contents: 'edited' });
  });

  it('strips managed annotations for the render copy but keeps links', async () => {
    const base = await makeBase();
    expect(await stripMarkupAnnotations(base)).toBe(base); // nothing to strip -> same bytes
    const annots = sample();
    const saved = await writeAnnotations(base, annots, new Set(annots.map((a) => a.id)));
    const stripped = await stripMarkupAnnotations(saved);
    expect(stripped).not.toBe(saved);
    expect((await readAnnotations(stripped)).annotations).toHaveLength(0);
    const arr = (await PDFDocument.load(stripped)).getPage(0).node.Annots() as PDFArray;
    expect(arr.size()).toBe(1); // the Link
  });
});

describe.each([0, 1])('visual interop (%#)', (engineIndex) => {
  const name = ['PDFium', 'PDF.js'][engineIndex]!;
  it(`${name} draws the saved annotations`, async () => {
    const base = await makeBase();
    const annots = sample();
    const out = await writeAnnotations(base, annots, new Set(annots.map((a) => a.id)));
    const e = engines[engineIndex]!;
    const p0 = await render(e, out, 0);
    expect(p0.width).toBe(300);

    // highlight multiplies yellow over white
    expect(near(p0, 70, 57, [255, 235, 59], 40)).toBe(true);
    // underline / strikeout lines
    expect(near(p0, 70, 113, [255, 0, 0], 140, 1)).toBe(true);
    expect(near(p0, 70, 158, [255, 0, 0], 140, 1)).toBe(true);
    // squiggly has red pixels somewhere in its band
    let squig = false;
    for (let x = 142; x < 238 && !squig; x++) for (let y = 108; y < 114; y++) if (near(p0, x, y, [255, 0, 0], 120, 0)) squig = true;
    expect(squig).toBe(true);
    // note icon fill
    expect(near(p0, 203, 67, [0, 255, 0], 50)).toBe(true);
    // free text: background fill and some dark text pixels
    expect(near(p0, 170, 255, [204, 221, 255], 20)).toBe(true);
    let dark = 0;
    for (let y = 204; y < 256; y++) for (let x = 24; x < 176; x++) if (px(p0, x, y)[0] < 90) dark++;
    expect(dark).toBeGreaterThan(40);
    // ink stroke
    expect(near(p0, 225, 230, [255, 0, 0], 80)).toBe(true);
    // rectangle border (blue) and empty interior
    expect(near(p0, 230, 301.5, [0, 0, 255], 80)).toBe(true);
    expect(near(p0, 230, 320, [255, 255, 255], 10, 0)).toBe(true);
    // filled ellipse centre
    expect(near(p0, 60, 330, [0, 255, 0], 40)).toBe(true);
    // arrow line (magenta) incl. head
    expect(near(p0, 60, 380, [255, 0, 255], 90)).toBe(true);
    expect(near(p0, 114, 380, [255, 0, 255], 90)).toBe(true);

    // rotated page: highlight lands at the same *display* position
    const p1 = await render(e, out, 1);
    expect(p1.width).toBe(400);
    expect(near(p1, 110, 107, [255, 235, 59], 40)).toBe(true);
    expect(near(p1, 110, 60, [255, 255, 255], 10, 0)).toBe(true);
  });
});
