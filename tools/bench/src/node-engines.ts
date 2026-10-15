import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';

export async function createNodeEngines(): Promise<PdfEngine[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as string);
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dir = (d: string) => join(root, d) + "/";
  const pdfium = await createPdfiumEngine();
  const pdfjsEngine = await createPdfjsEngine({
    pdfjs,
    createCanvas: (w, h) => createCanvas(w, h) as never,
    documentParams: { standardFontDataUrl: dir("standard_fonts"), cMapUrl: dir("cmaps"), cMapPacked: true, iccUrl: dir("iccs") },
  });
  return [pdfium, pdfjsEngine];
}
