import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { normaliseRotation, type PageGeometry } from './geometry';

/** PDF annotation subtypes this package reads, writes and manages. Everything else is left untouched. */
export const MANAGED_SUBTYPES = new Set([
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Text',
  'FreeText',
  'Ink',
  'Square',
  'Circle',
  'Line',
]);

export class EncryptedDocumentError extends Error {
  constructor() {
    super('Encrypted documents are not supported for annotation editing yet');
  }
}

export async function loadDoc(bytes: Uint8Array): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
  if (doc.isEncrypted) throw new EncryptedDocumentError();
  return doc;
}

export function pageGeometry(page: PDFPage): PageGeometry {
  const box = page.getCropBox();
  return {
    cropX: box.x,
    cropY: box.y,
    cropW: box.width,
    cropH: box.height,
    rotation: normaliseRotation(page.getRotation().angle),
  };
}

// ---- dictionary readers (tolerant: wrong types yield undefined)

export function getName(ctx: PDFContext, d: PDFDict, key: string): string | undefined {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function getText(ctx: PDFContext, d: PDFDict, key: string): string | undefined {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
}

export function getNumber(ctx: PDFContext, d: PDFDict, key: string): number | undefined {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getNumbers(ctx: PDFContext, d: PDFDict, key: string): number[] | undefined {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  if (!(v instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const n = ctx.lookup(v.get(i));
    if (n instanceof PDFNumber) out.push(n.asNumber());
  }
  return out;
}

export function getArray(ctx: PDFContext, d: PDFDict, key: string): PDFArray | undefined {
  const v = ctx.lookup(d.get(PDFName.of(key)));
  return v instanceof PDFArray ? v : undefined;
}

export function getRef(d: PDFDict, key: string): PDFRef | undefined {
  const v = d.get(PDFName.of(key));
  return v instanceof PDFRef ? v : undefined;
}

export const refId = (r: PDFRef) => `ref:${r.objectNumber}-${r.generationNumber}`;

export interface AnnotEntry {
  ref: PDFRef;
  dict: PDFDict;
  pageIndex: number;
  subtype: string;
}

/** Indirect annotation dictionaries of the given pages whose subtype is managed (inline dicts are skipped). */
export function scanManaged(doc: PDFDocument): AnnotEntry[] {
  const ctx = doc.context;
  const out: AnnotEntry[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw: PDFObject | undefined = annots.get(i);
      if (!(raw instanceof PDFRef)) continue;
      const dict = ctx.lookup(raw);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = getName(ctx, dict, 'Subtype');
      if (subtype && MANAGED_SUBTYPES.has(subtype)) out.push({ ref: raw, dict, pageIndex, subtype });
    }
  });
  return out;
}

export function removeFromArray(arr: PDFArray, ref: PDFRef) {
  for (let i = 0; i < arr.size(); i++) {
    const e = arr.get(i);
    if (e instanceof PDFRef && e.objectNumber === ref.objectNumber && e.generationNumber === ref.generationNumber) {
      arr.remove(i);
      return;
    }
  }
}

/** Delete an annotation object and its appearance stream so they are not written back as orphans. */
export function deleteAnnotObject(ctx: PDFContext, ref: PDFRef) {
  const dict = ctx.lookup(ref);
  if (dict instanceof PDFDict) {
    const ap = ctx.lookup(dict.get(PDFName.of('AP')));
    if (ap instanceof PDFDict) {
      const n = ap.get(PDFName.of('N'));
      if (n instanceof PDFRef) ctx.delete(n);
    }
  }
  ctx.delete(ref);
}

export function ensureAnnots(page: PDFPage): PDFArray {
  let arr = page.node.Annots();
  if (!arr) {
    arr = page.doc.context.obj([]);
    page.node.set(PDFName.of('Annots'), arr);
  }
  return arr;
}

/** Remove every managed annotation (render copy for the viewer, which draws them itself). Returns the same array if none. */
export async function stripMarkupAnnotations(bytes: Uint8Array): Promise<Uint8Array> {
  let doc: PDFDocument;
  try {
    doc = await loadDoc(bytes);
  } catch {
    return bytes;
  }
  const entries = scanManaged(doc);
  if (!entries.length) return bytes;
  const pages = doc.getPages();
  for (const e of entries) {
    const arr = pages[e.pageIndex]!.node.Annots();
    if (arr) removeFromArray(arr, e.ref);
    deleteAnnotObject(doc.context, e.ref);
  }
  return doc.save();
}
