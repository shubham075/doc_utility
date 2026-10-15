import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFContext, type PDFDocument, type PDFObject, type PDFPage } from 'pdf-lib';
import { serializeContent, type Matrix, type Op } from '@pdfsuite/security/content';
import { IDENTITY } from '@pdfsuite/security/content';

export const N = (s: string) => PDFName.of(s);

export function decodeStream(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
}

export function matrixOf(ctx: PDFContext, v: PDFObject | undefined): Matrix {
  const a = ctx.lookup(v);
  if (!(a instanceof PDFArray) || a.size() < 6) return IDENTITY;
  return Array.from({ length: 6 }, (_, i) => {
    const n = ctx.lookup(a.get(i));
    return n instanceof PDFNumber ? n.asNumber() : 0;
  }) as Matrix;
}

/** All content streams of a page joined with newlines. */
export function pageContent(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const c = ctx.lookup(contents);
  const streams: PDFStream[] = [];
  if (c instanceof PDFStream) streams.push(c);
  else if (c instanceof PDFArray)
    for (let i = 0; i < c.size(); i++) {
      const s = ctx.lookup(c.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  const parts = streams.map(decodeStream);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

/** A page-private Resources dictionary (with private Font/XObject maps) so edits never leak into shared resources. */
export function ownResources(ctx: PDFContext, page: PDFPage): PDFDict {
  const existing = page.node.Resources();
  const r = existing ? existing.clone(ctx) : ctx.obj({});
  for (const cat of ['Font', 'XObject', 'ExtGState']) {
    const d = ctx.lookup(r.get(N(cat)));
    if (d instanceof PDFDict) r.set(N(cat), d.clone(ctx));
  }
  page.node.set(N('Resources'), r);
  return r;
}

/** Register `ref` under a fresh name `<prefix><n>` in the given resource category and return the name. */
export function addResource(ctx: PDFContext, resources: PDFDict, category: 'Font' | 'XObject' | 'ExtGState', prefix: string, ref: PDFRef): string {
  let d = ctx.lookup(resources.get(N(category)));
  if (!(d instanceof PDFDict)) {
    d = ctx.obj({});
    resources.set(N(category), d);
  }
  const dict = d as PDFDict;
  let i = 1;
  while (dict.has(N(prefix + i))) i++;
  dict.set(N(prefix + i), ref);
  return prefix + i;
}

/** Replace the whole content of a page with the given instructions. */
export function writePageContent(ctx: PDFContext, page: PDFPage, ops: readonly Op[]) {
  const bytes = serializeContent(ops);
  page.node.set(N('Contents'), ctx.register(ctx.flateStream(bytes)));
}

/** Append instructions drawn on top of the existing page content. */
export function appendPageContent(ctx: PDFContext, page: PDFPage, ops: readonly Op[]) {
  const stream = ctx.register(ctx.flateStream(serializeContent([{ op: 'q', operands: [] }, ...ops, { op: 'Q', operands: [] }])));
  const existing = page.node.get(N('Contents'));
  const arr = ctx.lookup(existing);
  if (arr instanceof PDFArray) {
    arr.push(stream);
  } else if (existing) {
    page.node.set(N('Contents'), ctx.obj([existing, stream]));
  } else {
    page.node.set(N('Contents'), stream);
  }
}

export const name = (n: string) => ({ name: n });
export const op = (o: string, ...operands: Op['operands']): Op => ({ op: o, operands });

export const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1]!, 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
