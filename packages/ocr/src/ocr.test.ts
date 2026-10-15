import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';
import { createTesseractRecognizer, ocrPdf, type Recognizer } from './index';

const require = createRequire(import.meta.url);
let engines: PdfEngine[] = [];
let recognizer: Recognizer;

beforeAll(async () => {
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  engines = [
    await createPdfiumEngine(),
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  ];
  recognizer = await createTesseractRecognizer({
    langPath: join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'),
    cachePath: join(dirname(require.resolve('tesseract.js/package.json')), '.cache-test'),
  });
}, 60_000);
afterAll(async () => {
  await recognizer?.terminate();
  for (const e of engines) await e.dispose();
});

/** A scan: text rasterised into an image, no text layer. */
async function scannedPdf(lines: string[]): Promise<Uint8Array> {
  const c = createCanvas(1200, 800);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 1200, 800);
  x.fillStyle = '#000';
  x.font = '64px Arial';
  lines.forEach((l, i) => x.fillText(l, 80, 180 + i * 140));
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(new Uint8Array(c.toBuffer('image/png')));
  const page = doc.addPage([600, 400]);
  page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
  return doc.save();
}

const pdfium = () => engines[0]!;
const renderPng = async (doc: import('@pdfsuite/engine').PdfDocument, index: number, scale: number) => {
  const p = await doc.getPage(index);
  try {
    const b = await p.render({ scale });
    const c = createCanvas(b.width, b.height);
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(b.width, b.height);
    id.data.set(b.data);
    ctx.putImageData(id, 0, 0);
    return new Uint8Array(c.toBuffer('image/png'));
  } finally {
    p.close();
  }
};

async function text(e: PdfEngine, bytes: Uint8Array, page = 0) {
  const d = await e.open(bytes);
  const p = await d.getPage(page);
  const t = (await p.getText()).replace(/\s+/g, ' ').trim();
  d.close();
  return t;
}

describe('OCR', () => {
  it('makes a scanned page searchable without changing how it looks', async () => {
    const src = await scannedPdf(['Invoice 2026', 'Total due 4500']);
    expect(await text(pdfium(), src)).toBe('');
    const doc = await pdfium().open(src);
    const progress: number[] = [];
    const r = await ocrPdf(src, doc, recognizer, { pages: [0], dpi: 150, renderPng, onProgress: (n) => progress.push(n) });
    doc.close();
    expect(r.pagesProcessed).toBe(1);
    expect(r.words).toBeGreaterThanOrEqual(4);
    expect(progress).toEqual([1]);
    for (const e of engines) {
      const t = await text(e, r.bytes);
      expect(t).toContain('Invoice');
      expect(t).toContain('2026');
      expect(t).toContain('4500');
    }
    // invisible: pixels identical to the original scan
    const render = async (bytes: Uint8Array) => {
      const d = await pdfium().open(bytes);
      const p = await d.getPage(0);
      const b = await p.render({ scale: 1 });
      d.close();
      return b.data;
    };
    const [before, after] = [await render(src), await render(r.bytes)];
    let diff = 0;
    for (let i = 0; i < before.length; i++) if (Math.abs(before[i]! - after[i]!) > 8) diff++;
    expect(diff).toBe(0);
  }, 60_000);

  it('places words where they appear, including on a rotated page', async () => {
    // Display is portrait (400x600) and upright; the image sits rotated inside a /Rotate 90 page.
    const c = createCanvas(800, 1200);
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, 800, 1200);
    x.fillStyle = '#000';
    x.font = '64px Arial';
    x.fillText('Invoice 2026', 80, 180);
    const d0 = await PDFDocument.create();
    const img = await d0.embedPng(new Uint8Array(c.toBuffer('image/png')));
    const page = d0.addPage([600, 400]);
    page.drawImage(img, { x: 600, y: 0, width: 400, height: 600, rotate: degrees(90) });
    page.setRotation(degrees(90));
    const src = await d0.save();

    const doc = await pdfium().open(src);
    const r = await ocrPdf(src, doc, recognizer, { pages: [0], dpi: 200, renderPng });
    doc.close();
    expect(r.words).toBeGreaterThanOrEqual(1);
    const d = await engines[1]!.open(r.bytes);
    const p = await d.getPage(0);
    const items = (await p.getTextItems?.()) ?? [];
    const w = items.find((i) => i.str.includes('Invoice'))!;
    expect(w).toBeTruthy();
    // Image text starts at (80,180)/2 = (40,90) pt; baseline of the recognised word is a little above y=90.
    expect(w.x).toBeGreaterThan(30);
    expect(w.x).toBeLessThan(55);
    expect(w.y).toBeGreaterThan(70);
    expect(w.y).toBeLessThan(100);
    expect(Math.abs(w.angle)).toBeLessThan(0.05); // upright on screen
    expect(w.width).toBeGreaterThan(40);
    d.close();
  }, 60_000);

  it('skips pages that already have text and honours cancellation', async () => {
    const withText = await PDFDocument.create();
    const font = await withText.embedFont(StandardFonts.Helvetica);
    withText.addPage([600, 400]).drawText('This page already has a real text layer on it', { x: 20, y: 200, size: 18, font });
    const bytes = await withText.save();
    const doc = await pdfium().open(bytes);
    const r = await ocrPdf(bytes, doc, recognizer, { pages: [0], skipPagesWithText: true, renderPng });
    expect(r).toMatchObject({ pagesProcessed: 0, pagesSkipped: 1, words: 0 });
    expect(r.bytes).toBe(bytes);
    const ac = new AbortController();
    ac.abort();
    await expect(ocrPdf(bytes, doc, recognizer, { pages: [0], renderPng, signal: ac.signal })).rejects.toThrow(/cancelled/);
    doc.close();
  }, 60_000);
});
