import type { PdfDocument } from '@pdfsuite/engine';
import type { Recognizer } from './recognizer';
import { addInvisibleText, type PageOcr } from './textLayer';

export interface OcrPdfOptions {
  /** Zero-based pages to process. */
  pages: readonly number[];
  /** Render resolution; 200-300 dpi is the sweet spot for Tesseract. */
  dpi?: number;
  /** Skip pages that already contain a text layer. */
  skipPagesWithText?: boolean;
  /** Render a page (of the document handed to ocrPdf) to PNG at `scale` pixels per point. */
  renderPng(doc: PdfDocument, page: number, scale: number): Promise<Uint8Array>;
  onProgress?(done: number, total: number, page: number): void;
  signal?: AbortSignal;
}

export interface OcrPdfResult {
  bytes: Uint8Array;
  pagesProcessed: number;
  pagesSkipped: number;
  words: number;
}

/**
 * Make scanned pages searchable: render, recognise, add an invisible text layer.
 * `doc` must be an open engine document of `bytes`.
 */
export async function ocrPdf(bytes: Uint8Array, doc: PdfDocument, recognizer: Recognizer, opts: OcrPdfOptions): Promise<OcrPdfResult> {
  const scale = (opts.dpi ?? 250) / 72;
  const results: PageOcr[] = [];
  let skipped = 0;
  for (let i = 0; i < opts.pages.length; i++) {
    if (opts.signal?.aborted) throw new Error('OCR cancelled');
    const index = opts.pages[i]!;
    if (opts.skipPagesWithText) {
      const p = await doc.getPage(index);
      const text = (await p.getText()).trim();
      p.close();
      if (text.length > 20) {
        skipped++;
        opts.onProgress?.(i + 1, opts.pages.length, index);
        continue;
      }
    }
    const png = await opts.renderPng(doc, index, scale);
    results.push({ page: index, scale, words: await recognizer.recognize(png) });
    opts.onProgress?.(i + 1, opts.pages.length, index);
  }
  if (!results.length) return { bytes, pagesProcessed: 0, pagesSkipped: skipped, words: 0 };
  const out = await addInvisibleText(bytes, results);
  return { bytes: out.bytes, pagesProcessed: results.length, pagesSkipped: skipped, words: out.words };
}
