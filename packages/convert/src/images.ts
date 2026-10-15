import { PDFDocument } from 'pdf-lib';

export interface SourceImage {
  data: Uint8Array;
  type: 'png' | 'jpeg';
  /** Used only for error messages. */
  name?: string;
}

export interface ImagesToPdfOptions {
  /** 'fit' makes each page exactly as large as its image. */
  pageSize: 'fit' | 'a4' | 'letter';
  /** Page margin in points for a4/letter. */
  margin: number;
  /** For a4/letter: 'auto' picks portrait or landscape per image. */
  orientation: 'auto' | 'portrait' | 'landscape';
}

export const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

/** Detect PNG/JPEG by magic bytes (file extensions and MIME types lie). */
export function sniffImageType(data: Uint8Array): 'png' | 'jpeg' | null {
  if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return null;
}

/** One page per image, scaled to fit and centred. Images are embedded unchanged (no re-compression). */
export async function imagesToPdf(images: readonly SourceImage[], opts: Partial<ImagesToPdfOptions> = {}): Promise<Uint8Array> {
  if (!images.length) throw new Error('No images to convert');
  const o: ImagesToPdfOptions = { pageSize: 'fit', margin: 24, orientation: 'auto', ...opts };
  const doc = await PDFDocument.create();
  for (const img of images) {
    let embedded;
    try {
      embedded = img.type === 'png' ? await doc.embedPng(img.data) : await doc.embedJpg(img.data);
    } catch (e) {
      throw new Error(`${img.name ?? 'Image'} could not be read as ${img.type.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { width: iw, height: ih } = embedded;
    if (o.pageSize === 'fit') {
      // Treat pixels as 96 dpi CSS pixels, capped to keep pages a sensible size.
      const k = Math.min(0.75, 1600 / Math.max(iw, ih));
      const page = doc.addPage([iw * k, ih * k]);
      page.drawImage(embedded, { x: 0, y: 0, width: iw * k, height: ih * k });
      continue;
    }
    let [pw, ph]: number[] = [...PAGE_SIZES[o.pageSize]];
    const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && iw > ih);
    if (landscape) [pw, ph] = [ph!, pw!];
    const page = doc.addPage([pw!, ph!]);
    const k = Math.min((pw! - 2 * o.margin) / iw, (ph! - 2 * o.margin) / ih);
    const w = iw * k;
    const h = ih * k;
    page.drawImage(embedded, { x: (pw! - w) / 2, y: (ph! - h) / 2, width: w, height: h });
  }
  return doc.save();
}
