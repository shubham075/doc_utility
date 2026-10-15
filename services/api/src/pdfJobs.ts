import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { optimizePdf, type JpegRecompressor, type OptimizePreset } from '@pdfsuite/convert';
import { createPdfiumEngine, type PdfDocument, type PdfEngine } from '@pdfsuite/engine';
import { createTesseractRecognizer, ocrPdf } from '@pdfsuite/ocr';
import type { JobContext, JobResult } from './jobs';

const require = createRequire(import.meta.url);

/** Canvas-based JPEG re-encoder (server side). */
export const nodeRecompressor: JpegRecompressor = async (jpeg, { maxDimension, quality }) => {
  const img = await loadImage(Buffer.from(jpeg));
  const k = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  return { data: new Uint8Array(canvas.toBuffer('image/jpeg', Math.round(quality * 100))), width: w, height: h };
};

let engine: Promise<PdfEngine> | null = null;
const pdfium = () => (engine ??= createPdfiumEngine());

export interface CompressOptions {
  preset: OptimizePreset;
  stripMetadata: boolean;
  removeThumbnails: boolean;
}

export async function compressJob(input: Uint8Array, name: string, o: CompressOptions, ctx: JobContext): Promise<JobResult> {
  const r = await optimizePdf(input, { preset: o.preset, stripMetadata: o.stripMetadata, removeThumbnails: o.removeThumbnails, recompress: nodeRecompressor, onProgress: (d, t) => ctx.progress(d / Math.max(1, t)) });
  return { data: r.bytes, filename: name.replace(/\.pdf$/i, '') + '-optimized.pdf', mime: 'application/pdf' };
}

export interface OcrOptions {
  /** 1-based page numbers; empty = all. */
  pages: number[];
  dpi: number;
  skipPagesWithText: boolean;
}

export async function ocrJob(input: Uint8Array, name: string, o: OcrOptions, ctx: JobContext): Promise<JobResult> {
  const doc: PdfDocument = await (await pdfium()).open(input);
  const recognizer = await createTesseractRecognizer({
    langPath: join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int'),
    cachePath: join(process.env.TMPDIR ?? process.env.TEMP ?? '/tmp', 'pdfsuite-tessdata'),
  });
  try {
    const all = Array.from({ length: doc.pageCount }, (_, i) => i);
    const pages = o.pages.length ? o.pages.map((p) => p - 1).filter((p) => p >= 0 && p < doc.pageCount) : all;
    if (!pages.length) throw new Error('No valid pages selected');
    const r = await ocrPdf(input, doc, recognizer, {
      pages,
      dpi: o.dpi,
      skipPagesWithText: o.skipPagesWithText,
      signal: ctx.signal,
      onProgress: (d, t) => ctx.progress(d / t),
      renderPng: async (d, index, scale) => {
        const p = await d.getPage(index);
        try {
          const b = await p.render({ scale });
          const c = createCanvas(b.width, b.height);
          const cx = c.getContext('2d');
          const id = cx.createImageData(b.width, b.height);
          id.data.set(b.data);
          cx.putImageData(id, 0, 0);
          return new Uint8Array(c.toBuffer('image/png'));
        } finally {
          p.close();
        }
      },
    });
    return { data: r.bytes, filename: name.replace(/\.pdf$/i, '') + '-ocr.pdf', mime: 'application/pdf' };
  } finally {
    await recognizer.terminate();
    doc.close();
  }
}
