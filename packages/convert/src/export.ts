import type { PdfDocument, RenderedBitmap } from '@pdfsuite/engine';
import { makeZip, type ZipEntry } from '@pdfsuite/pages';

/** Plain text of the chosen pages (zero-based). Pages are separated by a form feed, like `pdftotext`. */
export async function exportText(doc: PdfDocument, pages: readonly number[], onProgress?: (done: number, total: number) => void): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = await doc.getPage(pages[i]!);
    try {
      parts.push((await p.getText()).replace(/\r\n?/g, '\n').trimEnd());
    } finally {
      p.close();
    }
    onProgress?.(i + 1, pages.length);
  }
  return parts.join('\n\f\n') + '\n';
}

export interface ExportImagesOptions {
  format: 'png' | 'jpeg';
  /** Output resolution; PDF pages are 72 dpi at scale 1. */
  dpi: number;
  /** JPEG quality 0..1. */
  quality: number;
  /** File name prefix. */
  baseName: string;
}

/** Encodes a rendered page; the environment supplies it (canvas in browsers, @napi-rs/canvas in Node). */
export type ImageEncoder = (bitmap: RenderedBitmap, format: 'png' | 'jpeg', quality: number) => Promise<Uint8Array>;

export const MAX_EXPORT_PIXELS = 100_000_000;

/** Render pages to image files. Files are named `<base>_p001.png`. */
export async function exportImages(
  doc: PdfDocument,
  pages: readonly number[],
  opts: ExportImagesOptions,
  encode: ImageEncoder,
  onProgress?: (done: number, total: number) => void,
): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  const pad = String(doc.pageCount).length;
  for (let i = 0; i < pages.length; i++) {
    const index = pages[i]!;
    const page = await doc.getPage(index);
    try {
      const scale = opts.dpi / 72;
      if (page.width * scale * page.height * scale > MAX_EXPORT_PIXELS) throw new Error(`Page ${index + 1} would exceed ${MAX_EXPORT_PIXELS / 1e6} megapixels at ${opts.dpi} dpi`);
      const bmp = await page.render({ scale });
      out.push({ name: `${opts.baseName}_p${String(index + 1).padStart(Math.max(3, pad), '0')}.${opts.format === 'png' ? 'png' : 'jpg'}`, data: await encode(bmp, opts.format, opts.quality) });
    } finally {
      page.close();
    }
    onProgress?.(i + 1, pages.length);
  }
  return out;
}

/** Bundle several files as a ZIP (a single file is returned as is by the caller). */
export const zipFiles = (files: ZipEntry[]) => makeZip(files);
