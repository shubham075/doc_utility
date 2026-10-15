import type { ImageEncoder, JpegRecompressor, SourceImage } from '@pdfsuite/convert';
import { sniffImageType } from '@pdfsuite/convert';
import type { JpegDecoder } from '@pdfsuite/security';

/** Canvas-based image helpers for browsers (the Node equivalents live in the tests/service). */

const toBlob = (c: HTMLCanvasElement | OffscreenCanvas, type: string, quality?: number): Promise<Blob> =>
  c instanceof OffscreenCanvas ? c.convertToBlob({ type, quality }) : new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image encoding failed'))), type, quality));

export const browserEncoder: ImageEncoder = async (bmp, format, quality) => {
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.putImageData(new ImageData(bmp.data as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height), 0, 0);
  const blob = await toBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', quality);
  return new Uint8Array(await blob.arrayBuffer());
};

export const browserRecompressor: JpegRecompressor = async (jpeg, { maxDimension, quality }) => {
  const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
  const k = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return { data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
};

/** Any browser-decodable image (WebP, GIF, BMP, AVIF...) -> PNG/JPEG bytes the PDF writer accepts. */
export async function toPdfImage(file: File): Promise<SourceImage> {
  const data = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(data);
  if (type) return { data, type, name: file.name };
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name} is not an image this browser can read`);
  });
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await c.convertToBlob({ type: 'image/png' });
  return { data: new Uint8Array(await blob.arrayBuffer()), type: 'png', name: file.name };
}

/** JPEG -> RGB pixels for the redaction engine (blanking part of an image). */
export const browserJpegDecoder: JpegDecoder = async (jpeg) => {
  try {
    const bmp = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { width, height } = bmp;
    bmp.close();
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
      rgb[j++] = rgba[i]!;
      rgb[j++] = rgba[i + 1]!;
      rgb[j++] = rgba[i + 2]!;
    }
    return { width, height, rgb };
  } catch {
    return null; // the image is then removed completely rather than partly blanked
  }
};
