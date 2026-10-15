import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine, type RenderedBitmap } from '@pdfsuite/engine';

/** n pages; page i says "<label> <i+1>" and has the given size. */
export async function makeDoc(n: number, opts: { label?: string; size?: [number, number]; rotate?: Record<number, number> } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [w, h] = opts.size ?? [300, 400];
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([w, h]);
    p.drawText(`${opts.label ?? 'Page'} ${i + 1}`, { x: 100, y: h / 2, size: 24, font });
    const r = opts.rotate?.[i];
    if (r) p.setRotation(degrees(r));
  }
  return doc.save();
}

export async function makeEngines(): Promise<PdfEngine[]> {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return [
    await createPdfiumEngine(),
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  ];
}

export async function pageTexts(engine: PdfEngine, bytes: Uint8Array): Promise<string[]> {
  const doc = await engine.open(bytes);
  const out: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const p = await doc.getPage(i);
    out.push((await p.getText()).replace(/\s+/g, ' ').trim());
    p.close();
  }
  doc.close();
  return out;
}

export async function renderPage(engine: PdfEngine, bytes: Uint8Array, page = 0, scale = 1): Promise<RenderedBitmap> {
  const doc = await engine.open(bytes);
  const p = await doc.getPage(page);
  const b = await p.render({ scale });
  doc.close();
  return b;
}

export const rgbAt = (b: RenderedBitmap, x: number, y: number): [number, number, number] => {
  const i = (Math.round(y) * b.width + Math.round(x)) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
};

/** Count pixels in a box that are darker than `max` on the red channel. */
export const darkCount = (b: RenderedBitmap, x: number, y: number, w: number, h: number, max = 128): number => {
  let n = 0;
  for (let j = Math.max(0, Math.floor(y)); j < Math.min(b.height, y + h); j++)
    for (let i = Math.max(0, Math.floor(x)); i < Math.min(b.width, x + w); i++) if (b.data[(j * b.width + i) * 4]! < max) n++;
  return n;
};

export const pngDataUrl = (w: number, h: number, color: string): string => {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return c.toDataURL('image/png');
};
