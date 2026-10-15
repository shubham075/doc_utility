import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';

export interface RecompressedImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Re-encode a JPEG at lower resolution/quality. The environment provides it (browser canvas or
 * @napi-rs/canvas); return null to leave the image alone.
 */
export type JpegRecompressor = (jpeg: Uint8Array, opts: { maxDimension: number; quality: number }) => Promise<RecompressedImage | null>;

export type OptimizePreset = 'low' | 'medium' | 'high';

/** `low` = smallest file, `high` = best image quality. */
export const PRESETS: Record<OptimizePreset, { maxDimension: number; quality: number }> = {
  low: { maxDimension: 1000, quality: 0.5 },
  medium: { maxDimension: 1600, quality: 0.65 },
  high: { maxDimension: 2400, quality: 0.8 },
};

export interface OptimizeOptions {
  preset: OptimizePreset;
  recompress?: JpegRecompressor;
  /** Drop document info and XMP metadata. */
  stripMetadata?: boolean;
  /** Drop embedded page thumbnails (viewers regenerate them). */
  removeThumbnails?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface OptimizeResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  imagesRecompressed: number;
  objectsRemoved: number;
}

const name = (ctx: PDFDocument['context'], d: PDFDict, key: string) => {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFName ? v.decodeText() : undefined;
};
const num = (ctx: PDFDocument['context'], d: PDFDict, key: string) => {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};

/** Remove objects not reachable from the trailer (orphans left behind by earlier edits). Returns the count. */
export function pruneUnreferenced(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const root = ctx.trailerInfo.Root;
  const info = ctx.trailerInfo.Info;
  if (root) stack.push(root);
  if (info) stack.push(info);
  const encrypt = ctx.trailerInfo.Encrypt;
  if (encrypt) stack.push(encrypt);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const target = ctx.lookup(o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const v of o.values()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of [...ctx.enumerateIndirectObjects()]) {
    if (!seen.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/** Shrink a PDF: drop orphan objects, optionally strip metadata/thumbnails, and re-encode oversized JPEG images. */
export async function optimizePdf(bytes: Uint8Array, opts: OptimizeOptions): Promise<OptimizeResult> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const { maxDimension, quality } = PRESETS[opts.preset];
  let imagesRecompressed = 0;

  if (opts.removeThumbnails) for (const p of doc.getPages()) p.node.delete(PDFName.of('Thumb'));
  if (opts.stripMetadata) {
    doc.catalog.delete(PDFName.of('Metadata'));
    const info = ctx.trailerInfo.Info;
    if (info instanceof PDFRef) ctx.delete(info);
    delete (ctx.trailerInfo as { Info?: PDFObject }).Info;
  }

  if (opts.recompress) {
    const images: [PDFRef, PDFRawStream][] = [];
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const d = obj.dict;
      if (name(ctx, d, 'Subtype') !== 'Image') continue;
      const filter = ctx.lookup(d.get(PDFName.of('Filter')));
      const single = filter instanceof PDFArray && filter.size() === 1 ? ctx.lookup(filter.get(0)) : filter;
      if (!(single instanceof PDFName) || single.decodeText() !== 'DCTDecode') continue;
      const cs = ctx.lookup(d.get(PDFName.of('ColorSpace')));
      if (cs instanceof PDFName && cs.decodeText() === 'DeviceCMYK') continue; // CMYK JPEGs are not safely re-encodable by canvas
      if ((num(ctx, d, 'BitsPerComponent') ?? 8) !== 8) continue;
      if (d.get(PDFName.of('Decode'))) continue;
      images.push([ref, obj]);
    }
    let done = 0;
    for (const [ref, stream] of images) {
      const original = stream.getContents();
      const r = await opts.recompress(original, { maxDimension, quality }).catch(() => null);
      if (r && r.data.length < original.length * 0.9) {
        const dict = stream.dict.clone(ctx);
        dict.set(PDFName.of('Width'), PDFNumber.of(r.width));
        dict.set(PDFName.of('Height'), PDFNumber.of(r.height));
        ctx.assign(ref, PDFRawStream.of(dict, r.data));
        imagesRecompressed++;
      }
      opts.onProgress?.(++done, images.length);
    }
  }

  const objectsRemoved = pruneUnreferenced(doc);
  const out = await doc.save({ useObjectStreams: true });
  // Never return something larger than the input.
  if (out.length >= bytes.length && imagesRecompressed === 0 && objectsRemoved === 0 && !opts.stripMetadata && !opts.removeThumbnails) {
    return { bytes, before: bytes.length, after: bytes.length, imagesRecompressed, objectsRemoved };
  }
  return { bytes: out.length < bytes.length ? out : bytes, before: bytes.length, after: Math.min(out.length, bytes.length), imagesRecompressed, objectsRemoved };
}
