import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine, type RenderedBitmap } from '@pdfsuite/engine';
import { exportImages, exportText, imagesToPdf, optimizePdf, sniffImageType, zipFiles, type ImageEncoder, type JpegRecompressor } from './index';

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

const png = (w: number, h: number, color: string) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(c.toBuffer('image/png'));
};

/** Noisy picture: compresses badly, so recompression has something to win. */
const noisyJpeg = (w: number, h: number, quality = 98) => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  let s = 12345;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = s & 255;
    img.data[i + 1] = (s >> 8) & 255;
    img.data[i + 2] = (s >> 16) & 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(c.toBuffer('image/jpeg', quality));
};

const nodeEncoder: ImageEncoder = async (b: RenderedBitmap, format, quality) => {
  const c = createCanvas(b.width, b.height);
  c.getContext('2d').putImageData(new ImageData(b.data, b.width, b.height), 0, 0);
  return new Uint8Array(format === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', Math.round(quality * 100)));
};

const nodeRecompressor: JpegRecompressor = async (jpeg, { maxDimension, quality }) => {
  const img = await loadImage(Buffer.from(jpeg));
  const k = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return { data: new Uint8Array(c.toBuffer('image/jpeg', Math.round(quality * 100))), width: w, height: h };
};

describe('images to PDF', () => {
  it('detects image types by content', () => {
    expect(sniffImageType(png(2, 2, '#000'))).toBe('png');
    expect(sniffImageType(noisyJpeg(8, 8))).toBe('jpeg');
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
  });

  it('makes one page per image, sized to the image or to a paper size', async () => {
    const images = [
      { data: png(400, 200, '#ff0000'), type: 'png' as const },
      { data: noisyJpeg(100, 300), type: 'jpeg' as const },
    ];
    const fit = await PDFDocument.load(await imagesToPdf(images));
    expect(fit.getPageCount()).toBe(2);
    expect(fit.getPage(0).getSize()).toEqual({ width: 300, height: 150 });

    const a4 = await PDFDocument.load(await imagesToPdf(images, { pageSize: 'a4', margin: 20 }));
    const [first, second] = a4.getPages();
    expect(Math.round(first!.getWidth())).toBe(842); // landscape picture -> landscape page
    expect(Math.round(second!.getHeight())).toBe(842); // portrait picture -> portrait page

    // the picture is actually drawn (red page centre) in both engines
    const bytes = await imagesToPdf([images[0]!], { pageSize: 'letter' });
    for (const e of engines) {
      const doc = await e.open(bytes);
      const p = await doc.getPage(0);
      const b = await p.render({ scale: 1 });
      const i = (Math.round(b.height / 2) * b.width + Math.round(b.width / 2)) * 4;
      expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([255, 0, 0]);
      doc.close();
    }
  });

  it('rejects empty input and corrupt images with a useful message', async () => {
    await expect(imagesToPdf([])).rejects.toThrow(/No images/);
    await expect(imagesToPdf([{ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]), type: 'png', name: 'bad.png' }])).rejects.toThrow(/bad\.png/);
  });
});

describe('export', () => {
  async function textDoc() {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 3; i++) d.addPage([300, 200]).drawText(`Hello page ${i}`, { x: 20, y: 100, size: 20, font: f });
    return d.save();
  }

  it('exports text for chosen pages', async () => {
    const bytes = await textDoc();
    for (const e of engines) {
      const doc = await e.open(bytes);
      const seen: number[] = [];
      const t = await exportText(doc, [0, 2], (n) => seen.push(n));
      expect(t).toContain('Hello page 1');
      expect(t).toContain('Hello page 3');
      expect(t).not.toContain('Hello page 2');
      expect(t.split('\f')).toHaveLength(2);
      expect(seen).toEqual([1, 2]);
      doc.close();
    }
  });

  it('exports pages as PNG/JPEG at the requested resolution', async () => {
    const doc = await engines[0]!.open(await textDoc());
    const files = await exportImages(doc, [0, 1], { format: 'png', dpi: 144, quality: 0.9, baseName: 'doc' }, nodeEncoder);
    expect(files.map((f) => f.name)).toEqual(['doc_p001.png', 'doc_p002.png']);
    const img = await loadImage(Buffer.from(files[0]!.data));
    expect([img.width, img.height]).toEqual([600, 400]); // 300x200 pt at 2x
    const jpg = await exportImages(doc, [2], { format: 'jpeg', dpi: 72, quality: 0.8, baseName: 'doc' }, nodeEncoder);
    expect(jpg[0]!.name).toBe('doc_p003.jpg');
    expect(sniffImageType(jpg[0]!.data)).toBe('jpeg');
    expect(zipFiles(files).length).toBeGreaterThan(files[0]!.data.length);
    await expect(exportImages(doc, [0], { format: 'png', dpi: 100000, quality: 1, baseName: 'x' }, nodeEncoder)).rejects.toThrow(/megapixels/);
    doc.close();
  });
});

describe('optimize', () => {
  async function bigImagePdf() {
    const doc = await PDFDocument.create();
    const img = await doc.embedJpg(noisyJpeg(1800, 1200));
    const page = doc.addPage([600, 400]);
    page.drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
    doc.setTitle('Secret title');
    doc.setAuthor('Someone');
    return doc.save();
  }

  it('re-encodes oversized JPEGs and the result still renders', async () => {
    const src = await bigImagePdf();
    const r = await optimizePdf(src, { preset: 'low', recompress: nodeRecompressor });
    expect(r.imagesRecompressed).toBe(1);
    expect(r.after).toBeLessThan(r.before * 0.5);
    const doc = await engines[0]!.open(r.bytes);
    const p = await doc.getPage(0);
    const b = await p.render({ scale: 0.5 });
    expect(b.width).toBe(300);
    let nonWhite = 0;
    for (let i = 0; i < b.data.length; i += 4) if (b.data[i]! < 250) nonWhite++;
    expect(nonWhite).toBeGreaterThan(b.width * b.height * 0.9);
    doc.close();
    // presets are ordered: low <= medium <= high in size
    const med = await optimizePdf(src, { preset: 'medium', recompress: nodeRecompressor });
    const high = await optimizePdf(src, { preset: 'high', recompress: nodeRecompressor });
    expect(r.after).toBeLessThanOrEqual(med.after);
    expect(med.after).toBeLessThanOrEqual(high.after);
  });

  it('leaves small images and unsupported streams alone and never grows the file', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawImage(await doc.embedJpg(noisyJpeg(64, 64, 60)), { x: 0, y: 0, width: 100, height: 100 });
    const src = await doc.save();
    const r = await optimizePdf(src, { preset: 'low', recompress: nodeRecompressor });
    expect(r.after).toBeLessThanOrEqual(r.before);
  });

  it('removes orphaned objects, thumbnails and metadata on request', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    for (let i = 0; i < 20; i++) doc.context.register(doc.context.stream('x'.repeat(5000))); // unreferenced junk
    doc.setTitle('Top secret');
    const page = doc.getPage(0);
    page.node.set(PDFName.of('Thumb'), doc.context.register(doc.context.stream('thumb')));
    const src = await doc.save();
    const r = await optimizePdf(src, { preset: 'high', stripMetadata: true, removeThumbnails: true });
    expect(r.objectsRemoved).toBeGreaterThanOrEqual(20);
    expect(r.after).toBeLessThan(r.before / 3);
    const back = await PDFDocument.load(r.bytes);
    expect(back.getTitle()).toBeUndefined();
    expect(back.getPage(0).node.has(PDFName.of('Thumb'))).toBe(false);
    expect(back.getPageCount()).toBe(1);
  });
});
