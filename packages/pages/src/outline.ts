import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, type PDFContext, type PDFObject } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';

export interface OutlineItem {
  title: string;
  /** Zero-based target page, or null if the destination could not be resolved. */
  page: number | null;
  children: OutlineItem[];
}

const text = (ctx: PDFContext, v: PDFObject | undefined): string | undefined => {
  const o = ctx.lookup(v);
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined;
};

/** Read the bookmark tree (explicit and named destinations, GoTo actions). */
export async function readOutline(bytes: Uint8Array): Promise<OutlineItem[]> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const root = ctx.lookup(doc.catalog.get(PDFName.of('Outlines')));
  if (!(root instanceof PDFDict)) return [];

  const pageIndex = new Map<string, number>();
  doc.getPages().forEach((p, i) => pageIndex.set(p.ref.toString(), i));

  // Named destinations: catalog /Dests dictionary and /Names /Dests name tree.
  const named = new Map<string, PDFObject>();
  const dests = ctx.lookup(doc.catalog.get(PDFName.of('Dests')));
  if (dests instanceof PDFDict) for (const [k, v] of dests.entries()) named.set(k.decodeText(), v);
  const names = ctx.lookup(doc.catalog.get(PDFName.of('Names')));
  if (names instanceof PDFDict) {
    const walk = (node: PDFObject | undefined, depth: number) => {
      const d = ctx.lookup(node);
      if (!(d instanceof PDFDict) || depth > 10) return;
      const list = ctx.lookup(d.get(PDFName.of('Names')));
      if (list instanceof PDFArray) for (let i = 0; i + 1 < list.size(); i += 2) {
        const k = text(ctx, list.get(i));
        if (k !== undefined) named.set(k, list.get(i + 1)!);
      }
      const kids = ctx.lookup(d.get(PDFName.of('Kids')));
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
    };
    walk(names.get(PDFName.of('Dests')), 0);
  }

  const resolve = (dest: PDFObject | undefined, depth = 0): number | null => {
    const d = ctx.lookup(dest);
    if (depth > 4 || d === undefined) return null;
    if (d instanceof PDFArray) {
      const first = d.get(0);
      return first instanceof PDFRef ? (pageIndex.get(first.toString()) ?? null) : null;
    }
    if (d instanceof PDFDict) return resolve(d.get(PDFName.of('D')), depth + 1); // { /D [..] } form
    const key = text(ctx, dest);
    return key !== undefined && named.has(key) ? resolve(named.get(key), depth + 1) : null;
  };

  const walkItems = (first: PDFObject | undefined, depth: number): OutlineItem[] => {
    const out: OutlineItem[] = [];
    let cur = ctx.lookup(first);
    for (let guard = 0; cur instanceof PDFDict && guard < 10000; guard++) {
      let page = resolve(cur.get(PDFName.of('Dest')));
      if (page === null) {
        const action = ctx.lookup(cur.get(PDFName.of('A')));
        if (action instanceof PDFDict && text(ctx, action.get(PDFName.of('S'))) === 'GoTo') page = resolve(action.get(PDFName.of('D')));
      }
      out.push({
        title: text(ctx, cur.get(PDFName.of('Title'))) ?? '',
        page,
        children: depth < 12 ? walkItems(cur.get(PDFName.of('First')), depth + 1) : [],
      });
      cur = ctx.lookup(cur.get(PDFName.of('Next')));
    }
    return out;
  };
  return walkItems(root.get(PDFName.of('First')), 0);
}
