import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from './index.js';

let pdf: Uint8Array;
const engines: PdfEngine[] = [];

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([300, 400]).drawText(`Hello page ${i}`, { x: 20, y: 350, size: 18, font });
  pdf = await doc.save();

  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  engines.push(await createPdfiumEngine());
  engines.push(
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  );
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

describe.each(['pdfium', 'pdfjs'] as const)('%s engine', (id) => {
  const get = () => engines.find((e) => e.id === id)!;

  it('opens a document and reports page count and size', async () => {
    const doc = await get().open(pdf);
    expect(doc.pageCount).toBe(3);
    const page = await doc.getPage(0);
    expect(page.width).toBeCloseTo(300);
    expect(page.height).toBeCloseTo(400);
    doc.close();
  });

  it('renders RGBA pixels with some non-white content', async () => {
    const doc = await get().open(pdf);
    const page = await doc.getPage(1);
    const bmp = await page.render({ scale: 2 });
    expect(bmp.width).toBe(600);
    expect(bmp.height).toBe(800);
    expect(bmp.data.length).toBe(600 * 800 * 4);
    let dark = 0;
    for (let i = 0; i < bmp.data.length; i += 4) if (bmp.data[i]! < 128) dark++;
    expect(dark).toBeGreaterThan(100);
    doc.close();
  });

  it('extracts text', async () => {
    const doc = await get().open(pdf);
    const text = await (await doc.getPage(2)).getText();
    expect(text).toContain('Hello page 3');
    doc.close();
  });
});
