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

  it('renders after text items were read and the page wrapper was closed', async () => {
    const doc = await get().open(pdf);
    const first = await doc.getPage(0);
    await first.getTextItems?.();
    first.close();
    const again = await doc.getPage(0);
    const bmp = await Promise.race([
      again.render({ scale: 1 }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('render hung')), 4000)),
    ]);
    expect(bmp.width).toBe(300);
    doc.close();
  });

  it('reports positioned text items when supported', async () => {
    const doc = await get().open(pdf);
    const page = await doc.getPage(0);
    if (!page.getTextItems) return;
    const items = await page.getTextItems();
    const hello = items.find((i) => i.str.includes('Hello'))!;
    expect(hello.x).toBeCloseTo(20, 0);
    expect(hello.y).toBeCloseTo(400 - 350, 0); // y grows downward from the top
    expect(hello.fontSize).toBeCloseTo(18, 0);
    doc.close();
  });

  it('fails cleanly (no WASM abort) when a page is used after its document was closed', async () => {
    if (id !== 'pdfium') return; // pdf.js has no native memory to corrupt; its behaviour differs
    const doc = await get().open(pdf);
    const page = await doc.getPage(0);
    doc.close();
    await expect(page.render({ scale: 1 })).rejects.toThrow();
    expect(() => page.close()).not.toThrow();
    await expect(doc.getPage(1)).rejects.toThrow();
    doc.close(); // idempotent
  });

  it('extracts text', async () => {
    const doc = await get().open(pdf);
    const text = await (await doc.getPage(2)).getText();
    expect(text).toContain('Hello page 3');
    doc.close();
  });
});
