import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFContext, type PDFDocument, type PDFObject } from 'pdf-lib';
import { loadDoc, pageGeometry, rectFromUser, rectToUser, type Rect } from '@pdfsuite/annotations';
import { N } from './util';

export type LinkTarget = { uri: string } | { page: number };

export interface LinkInfo {
  /** Position among the page's link annotations. */
  index: number;
  rect: Rect;
  /** What the link does; `other` = named destination, JavaScript, launch... (kept as is, only movable/deletable). */
  kind: 'uri' | 'page' | 'other';
  uri?: string;
  /** Zero-based target page. */
  page?: number;
}

const text = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
};

function linkAnnots(doc: PDFDocument, pageIndex: number) {
  const page = doc.getPages()[pageIndex];
  if (!page) throw new Error(`No page ${pageIndex + 1}`);
  const ctx = doc.context;
  const annots = page.node.Annots();
  const out: { arr: PDFArray; at: number; dict: PDFDict }[] = [];
  if (annots)
    for (let i = 0; i < annots.size(); i++) {
      const d = ctx.lookup(annots.get(i));
      if (d instanceof PDFDict && (ctx.lookup(d.get(N('Subtype'))) as PDFName | undefined)?.decodeText?.() === 'Link') out.push({ arr: annots, at: i, dict: d });
    }
  return { page, ctx, links: out };
}

function pageIndexOf(doc: PDFDocument, dest: PDFObject | undefined): number | undefined {
  const ctx = doc.context;
  const d = ctx.lookup(dest);
  if (!(d instanceof PDFArray) || !d.size()) return undefined;
  const first = d.get(0);
  if (!(first instanceof PDFRef)) return undefined;
  const i = doc.getPages().findIndex((p) => p.ref === first || (p.ref.objectNumber === first.objectNumber && p.ref.generationNumber === first.generationNumber));
  return i >= 0 ? i : undefined;
}

function describe(doc: PDFDocument, dict: PDFDict) {
  const ctx = doc.context;
  const action = ctx.lookup(dict.get(N('A')));
  if (action instanceof PDFDict) {
    const s = (ctx.lookup(action.get(N('S'))) as PDFName | undefined)?.decodeText?.();
    if (s === 'URI') return { kind: 'uri' as const, uri: text(ctx, action.get(N('URI'))) ?? '' };
    if (s === 'GoTo') {
      const p = pageIndexOf(doc, action.get(N('D')));
      return p === undefined ? { kind: 'other' as const } : { kind: 'page' as const, page: p };
    }
    return { kind: 'other' as const };
  }
  const p = pageIndexOf(doc, dict.get(N('Dest')));
  return p === undefined ? { kind: 'other' as const } : { kind: 'page' as const, page: p };
}

export async function listLinks(bytes: Uint8Array, pageIndex: number, doc?: PDFDocument): Promise<LinkInfo[]> {
  doc ??= await loadDoc(bytes);
  const { page, ctx, links } = linkAnnots(doc, pageIndex);
  const g = pageGeometry(page);
  const out: LinkInfo[] = [];
  links.forEach(({ dict }, index) => {
    const r = ctx.lookup(dict.get(N('Rect')));
    if (!(r instanceof PDFArray) || r.size() < 4) return;
    const v = [0, 1, 2, 3].map((k) => (ctx.lookup(r.get(k)) as PDFNumber).asNumber()) as [number, number, number, number];
    out.push({ index, rect: rectFromUser(g, [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]), ...describe(doc, dict) });
  });
  return out;
}

function applyTarget(doc: PDFDocument, dict: PDFDict, target: LinkTarget) {
  const ctx = doc.context;
  dict.delete(N('Dest'));
  if ('uri' in target) {
    const uri = target.uri.trim();
    if (!/^(https?:|mailto:|tel:|ftp:)/i.test(uri)) throw new Error('Links must start with http://, https://, mailto: or tel:.');
    dict.set(N('A'), ctx.obj({ S: 'URI', URI: PDFString.of(uri) }));
  } else {
    const page = doc.getPages()[target.page];
    if (!page) throw new Error(`No page ${target.page + 1}`);
    dict.set(N('A'), ctx.obj({ S: 'GoTo', D: [page.ref, 'Fit'] }));
  }
}

export async function addLink(bytes: Uint8Array, pageIndex: number, rect: Rect, target: LinkTarget): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const { page, ctx } = linkAnnots(doc, pageIndex);
  const g = pageGeometry(page);
  const dict = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rectToUser(g, rect), Border: [0, 0, 0], F: 4 });
  applyTarget(doc, dict, target);
  const ref = ctx.register(dict);
  const annots = page.node.Annots();
  if (annots) annots.push(ref);
  else page.node.set(N('Annots'), ctx.obj([ref]));
  return doc.save({ useObjectStreams: false });
}

export async function updateLink(bytes: Uint8Array, pageIndex: number, index: number, change: { rect?: Rect; target?: LinkTarget }): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const { page, ctx, links } = linkAnnots(doc, pageIndex);
  const l = links[index];
  if (!l) throw new Error('That link no longer exists.');
  if (change.rect) l.dict.set(N('Rect'), ctx.obj(rectToUser(pageGeometry(page), change.rect)));
  if (change.target) applyTarget(doc, l.dict, change.target);
  return doc.save({ useObjectStreams: false });
}

export async function deleteLink(bytes: Uint8Array, pageIndex: number, index: number): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const { links } = linkAnnots(doc, pageIndex);
  const l = links[index];
  if (!l) throw new Error('That link no longer exists.');
  l.arr.remove(l.at);
  return doc.save({ useObjectStreams: false });
}
