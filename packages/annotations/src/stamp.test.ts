import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';
import { STAMP_ID_PREFIX, baseFields, readAnnotations, stripMarkupAnnotations, writeAnnotations, type Annotation } from './index';

function redPng(): string {
  const c = createCanvas(8, 4);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 8, 4);
  return c.toDataURL('image/png');
}

async function base(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.addPage([300, 400]).setRotation({ type: 'degrees', angle: 90 } as never);
  return doc.save();
}

const stamp = (page: number, id: string): Annotation => ({
  ...baseFields(page, 'Me', '#000000'),
  id: STAMP_ID_PREFIX + id,
  type: 'stamp',
  rect: { x: 100, y: 150, width: 80, height: 40 },
  dataUrl: redPng(),
});

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

async function pixel(e: PdfEngine, bytes: Uint8Array, page: number, x: number, y: number) {
  const doc = await e.open(bytes);
  const p = await doc.getPage(page);
  const b = await p.render({ scale: 1 });
  doc.close();
  const i = (y * b.width + x) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
}

describe('image stamps', () => {
  it('draw upright at the display rect on normal and rotated pages in both engines', async () => {
    const annots = [stamp(0, 'a'), stamp(1, 'b')];
    const out = await writeAnnotations(await base(), annots, new Set(annots.map((a) => a.id)));
    for (const e of engines) {
      for (const page of [0, 1]) {
        const inside = await pixel(e, out, page, 140, 170);
        expect(inside[0]).toBeGreaterThan(200);
        expect(inside[1]).toBeLessThan(60);
        const outside = await pixel(e, out, page, 140, 100);
        expect(outside[1]).toBeGreaterThan(240);
      }
    }
  });

  it('are left as page content on reopen, but removable in the session that created them', async () => {
    const s = stamp(0, 'c');
    const out = await writeAnnotations(await base(), [s], new Set([s.id]));
    // Reopening: not parsed into the model, and not stripped from the render copy.
    expect((await readAnnotations(out)).annotations).toHaveLength(0);
    expect(await stripMarkupAnnotations(out)).toBe(out);
    // Deleting (id still in the session's base) removes the object.
    const removed = await writeAnnotations(out, [], new Set());
    const px = await pixel(engines[0]!, removed, 0, 140, 170);
    expect(px[1]).toBeGreaterThan(240);
  });
});
