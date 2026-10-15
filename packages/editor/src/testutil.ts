import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';

const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

export async function makeEngines(): Promise<{ pdfium: PdfEngine; pdfjs: PdfEngine }> {
  return {
    pdfium: await createPdfiumEngine(),
    pdfjs: await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  };
}

export async function pageText(engine: PdfEngine, bytes: Uint8Array, page = 0): Promise<string> {
  const doc = await engine.open(bytes);
  const p = await doc.getPage(page);
  const t = (await p.getText()).replace(/\s+/g, ' ').trim();
  p.close();
  doc.close();
  return t;
}

export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export async function render(engine: PdfEngine, bytes: Uint8Array, page = 0, scale = 1): Promise<Bitmap> {
  const doc = await engine.open(bytes);
  const p = await doc.getPage(page);
  const bmp = await p.render({ scale });
  p.close();
  doc.close();
  return { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data) };
}

/** Fraction of pixels (outside the `ignore` boxes, in bitmap pixels) whose colour differs noticeably. */
export function diffFraction(a: Bitmap, b: Bitmap, ignore: { x: number; y: number; width: number; height: number }[] = []): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let diff = 0;
  let total = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (ignore.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
      total++;
      const i = (y * a.width + x) * 4;
      const d = Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
      if (d > 48) diff++;
    }
  }
  return total ? diff / total : 0;
}

export const fallbackFont = async ({ bold, italic }: { bold: boolean; italic: boolean }) =>
  new Uint8Array(readFileSync(join(root, 'standard_fonts', `LiberationSans-${bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular'}.ttf`)));
