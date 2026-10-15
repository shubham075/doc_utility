import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream } from 'pdf-lib';
import { rectToUser, type Rect } from '@pdfsuite/annotations';
import { apply, invert, mmul, type Op } from '@pdfsuite/security/content';
import { commit, moveResizeObjects, openForEdit } from './edit';
import { scanPage } from './scan';
import { N, addResource, decodeStream, name, op, ownResources } from './util';

export interface RasterImage {
  data: Uint8Array;
  type: 'png' | 'jpeg';
}

// ------------------------------------------------------------------ export

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal PNG writer (8-bit gray, RGB or RGBA). */
export async function encodePng(width: number, height: number, comps: 1 | 3 | 4, samples: Uint8Array): Promise<Uint8Array> {
  const stride = width * comps;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(samples.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = comps === 1 ? 0 : comps === 3 ? 2 : 6;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface ExportedImage {
  data: Uint8Array;
  extension: 'jpg' | 'png';
}

/** The picture behind an image object as a standalone file (JPEG data is copied unchanged; others become PNG). */
export async function exportImage(bytes: Uint8Array, pageIndex: number, id: string): Promise<ExportedImage> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const int = scan.internal.get(id);
  if (!int?.xobject) throw new Error('That is not an image.');
  const ctx = scan.ctx;
  const res = scan.page.node.Resources();
  const xo = res && ctx.lookup(res.get(N('XObject')));
  const s = xo instanceof PDFDict ? ctx.lookup(xo.get(N(int.xobject))) : undefined;
  if (!(s instanceof PDFStream) || !(s instanceof PDFRawStream)) throw new Error('Image data not found.');
  const get = (k: string) => ctx.lookup(s.dict.get(N(k)));
  const filter = get('Filter');
  const filters = filter instanceof PDFName ? [filter.decodeText()] : filter instanceof PDFArray ? Array.from({ length: filter.size() }, (_, i) => (ctx.lookup(filter.get(i)) as PDFName).decodeText()) : [];
  if (filters.length === 1 && filters[0] === 'DCTDecode') return { data: s.getContents(), extension: 'jpg' };
  if (filters.some((f) => f === 'JPXDecode' || f === 'CCITTFaxDecode' || f === 'JBIG2Decode')) throw new Error(`Images stored as ${filters[filters.length - 1]} cannot be exported.`);

  const w = (get('Width') as PDFNumber).asNumber();
  const h = (get('Height') as PDFNumber).asNumber();
  const bpc = (get('BitsPerComponent') as PDFNumber | undefined)?.asNumber() ?? 8;
  if (bpc !== 8) throw new Error('Only 8-bit images can be exported.');
  const samples = decodeStream(s);

  let cs = get('ColorSpace');
  let palette: Uint8Array | null = null;
  let compsIn = 0;
  let paletteComps = 3;
  const csName = (v: unknown) => (v instanceof PDFName ? v.decodeText() : '');
  if (cs instanceof PDFArray && csName(ctx.lookup(cs.get(0))) === 'Indexed') {
    const base = ctx.lookup(cs.get(1));
    paletteComps = csName(base) === 'DeviceGray' ? 1 : csName(base) === 'DeviceCMYK' ? 4 : 3;
    const lookup = ctx.lookup(cs.get(3));
    palette = lookup instanceof PDFStream ? decodeStream(lookup) : (lookup as unknown as { asBytes?(): Uint8Array })?.asBytes?.() ?? null;
    if (!palette || paletteComps === 4) throw new Error('This palette image type cannot be exported.');
    compsIn = 1;
  } else if (cs instanceof PDFArray && csName(ctx.lookup(cs.get(0))) === 'ICCBased') {
    const prof = ctx.lookup(cs.get(1));
    compsIn = prof instanceof PDFStream ? (ctx.lookup(prof.dict.get(N('N'))) as PDFNumber).asNumber() : 0;
  } else compsIn = { DeviceGray: 1, CalGray: 1, DeviceRGB: 3, CalRGB: 3, DeviceCMYK: 4 }[csName(cs)] ?? 0;
  if (compsIn === 4 || !compsIn) throw new Error('CMYK and special colour spaces cannot be exported.');
  cs = undefined;
  if (samples.length < w * h * compsIn) throw new Error('Image data is incomplete.');

  let rgb: Uint8Array;
  let outComps: 1 | 3 | 4 = compsIn === 1 && !palette ? 1 : 3;
  if (palette) {
    rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const p = samples[i]! * paletteComps;
      rgb[i * 3] = palette[p] ?? 0;
      rgb[i * 3 + 1] = palette[paletteComps === 1 ? p : p + 1] ?? 0;
      rgb[i * 3 + 2] = palette[paletteComps === 1 ? p : p + 2] ?? 0;
    }
  } else rgb = samples.subarray(0, w * h * compsIn);

  const sm = get('SMask');
  if (sm instanceof PDFStream) {
    const mw = (ctx.lookup(sm.dict.get(N('Width'))) as PDFNumber).asNumber();
    const mh = (ctx.lookup(sm.dict.get(N('Height'))) as PDFNumber).asNumber();
    const alpha = decodeStream(sm);
    if (mw === w && mh === h && alpha.length >= w * h) {
      const c = outComps === 1 ? 3 : 3;
      const out = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        if (outComps === 1) out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = rgb[i]!;
        else {
          out[i * 4] = rgb[i * c]!;
          out[i * 4 + 1] = rgb[i * c + 1]!;
          out[i * 4 + 2] = rgb[i * c + 2]!;
        }
        out[i * 4 + 3] = alpha[i]!;
      }
      return { data: await encodePng(w, h, 4, out), extension: 'png' };
    }
  }
  return { data: await encodePng(w, h, outComps, rgb), extension: 'png' };
}

// ------------------------------------------------------------------ replace / crop

/** Show a different picture in place of an image object. `contain` keeps the new picture's proportions inside the old box. */
export async function replaceImage(bytes: Uint8Array, pageIndex: number, id: string, image: RasterImage, fit: 'stretch' | 'contain' = 'contain'): Promise<Uint8Array> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const int = scan.internal.get(id);
  const obj = scan.objects.find((o) => o.id === id);
  if (!int?.xobject || !obj || obj.kind !== 'image') throw new Error('That is not an image.');
  const pdfImage = image.type === 'png' ? await doc.embedPng(image.data) : await doc.embedJpg(image.data);
  const resources = ownResources(scan.ctx, scan.page);
  const nn = addResource(scan.ctx, resources, 'XObject', 'ImEdit', pdfImage.ref);
  const ops = scan.ops.slice();
  ops[int.start] = op('Do', name(nn));
  const out = await commit(doc, scan, ops);
  if (fit === 'stretch') return out;
  const k = Math.min(obj.bbox.width / pdfImage.width, obj.bbox.height / pdfImage.height);
  const w = pdfImage.width * k;
  const h = pdfImage.height * k;
  const box: Rect = { x: obj.bbox.x + (obj.bbox.width - w) / 2, y: obj.bbox.y + (obj.bbox.height - h) / 2, width: w, height: h };
  return moveResizeObjects(out, pageIndex, [{ id, bbox: box }]);
}

/** Hide everything of an image outside `area` (display space) by clipping. The hidden pixels stay in the file. */
export async function cropImage(bytes: Uint8Array, pageIndex: number, id: string, area: Rect): Promise<Uint8Array> {
  const doc = await openForEdit(bytes);
  const scan = await scanPage(doc, pageIndex);
  const int = scan.internal.get(id);
  const obj = scan.objects.find((o) => o.id === id);
  if (!int || !obj || (obj.kind !== 'image' && obj.kind !== 'form' && obj.kind !== 'inline-image')) throw new Error('That object cannot be cropped.');
  const x1 = Math.max(obj.bbox.x, area.x);
  const y1 = Math.max(obj.bbox.y, area.y);
  const x2 = Math.min(obj.bbox.x + obj.bbox.width, area.x + area.width);
  const y2 = Math.min(obj.bbox.y + obj.bbox.height, area.y + area.height);
  if (x2 - x1 < 1 || y2 - y1 < 1) throw new Error('The crop area does not overlap the image.');
  const [ux1, uy1, ux2, uy2] = rectToUser(scan.geometry, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  const inv = invert(int.ctm);
  if (!inv) throw new Error('The image has a degenerate placement.');
  const pts = [apply(inv, ux1, uy1), apply(inv, ux2, uy1), apply(inv, ux2, uy2), apply(inv, ux1, uy2)];
  const clip: Op[] = [op('m', pts[0]![0], pts[0]![1]), op('l', pts[1]![0], pts[1]![1]), op('l', pts[2]![0], pts[2]![1]), op('l', pts[3]![0], pts[3]![1]), op('h'), op('W'), op('n')];
  void mmul;
  const ops = scan.ops.slice();
  ops.splice(int.start, int.end - int.start, op('q'), ...clip, ...scan.ops.slice(int.start, int.end), op('Q'));
  return commit(doc, scan, ops);
}
