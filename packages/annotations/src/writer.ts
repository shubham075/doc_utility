import { PDFBool, PDFDict, PDFDocument, PDFFont, PDFImage, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts, type PDFContext } from 'pdf-lib';
import { buildAppearance, FONT_RESOURCE_NAME, needsFont, type Appearance } from './appearance';
import { toUser, type PageGeometry } from './geometry';
import type { Annotation, ReviewStatus } from './model';
import { colorOp, hexToRgb, toPdfDate } from './pdfutil';
import {
  deleteAnnotObject,
  ensureAnnots,
  getNumbers,
  getRef,
  getText,
  loadDoc,
  pageGeometry,
  refId,
  removeFromArray,
  scanManaged,
  type AnnotEntry,
} from './pdfio';

const SUBTYPE: Record<string, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
  note: 'Text',
  freetext: 'FreeText',
  ink: 'Ink',
  stamp: 'Stamp',
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
};

const STATE_NAME: Record<ReviewStatus, string> = {
  none: 'None',
  accepted: 'Accepted',
  rejected: 'Rejected',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATE_SUFFIX = ':state';

/**
 * Write the annotation model into the PDF.
 *
 * Only annotations whose id is in `touched` (added or edited) are re-emitted; unchanged annotations that
 * already exist in the file keep their original objects byte-for-byte. Managed annotations that exist in
 * the file but not in `annotations` are deleted. Everything else (links, widgets, ...) is preserved.
 *
 * Note: pdf-lib rewrites the whole file (no incremental update), which invalidates existing digital signatures.
 */
export async function writeAnnotations(
  bytes: Uint8Array,
  annotations: readonly Annotation[],
  touched: ReadonlySet<string>,
): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const geometry = pages.map(pageGeometry);
  const model = new Map(annotations.map((a) => [a.id, a]));

  // ---- index what is already in the file
  const entries = scanManaged(doc, true);
  const idByRef = new Map<string, string>();
  for (const e of entries) idByRef.set(refId(e.ref), getText(ctx, e.dict, 'NM') || refId(e.ref));
  const existing = new Map<string, AnnotEntry>();
  const stateEntries: { entry: AnnotEntry; parentId: string }[] = [];
  for (const e of entries) {
    const id = idByRef.get(refId(e.ref))!;
    const irt = getRef(e.dict, 'IRT');
    if (e.subtype === 'Text' && irt && getText(ctx, e.dict, 'StateModel')) {
      stateEntries.push({ entry: e, parentId: idByRef.get(refId(irt)) ?? '' });
    } else {
      existing.set(id, e);
    }
  }

  const dropEntry = (e: AnnotEntry) => {
    const arr = pages[e.pageIndex]!.node.Annots();
    if (arr) removeFromArray(arr, e.ref);
    deleteAnnotObject(ctx, e.ref);
  };

  // ---- deletions (and stale status records)
  for (const [id, e] of existing) if (!model.has(id)) dropEntry(e);
  for (const s of stateEntries) if (!model.has(s.parentId) || touched.has(s.parentId)) dropEntry(s.entry);

  // ---- additions / edits: parents first so replies can point at them
  let font: PDFFont | undefined;
  const ensureFont = async () => (font ??= await doc.embedFont(StandardFonts.Helvetica));
  const refs = new Map<string, PDFRef>();
  const rects = new Map<string, number[]>();
  for (const [id, e] of existing) {
    if (model.has(id)) {
      refs.set(id, e.ref);
      rects.set(id, getNumbers(ctx, e.dict, 'Rect') ?? [0, 0, 0, 0]);
    }
  }

  const ordered = [...annotations.filter((a) => a.type !== 'reply'), ...annotations.filter((a) => a.type === 'reply')];
  for (const a of ordered) {
    const g = geometry[a.page];
    if (!g) continue;
    const prev = existing.get(a.id);
    if (prev && !touched.has(a.id)) continue;

    let dict: PDFDict;
    if (a.type === 'reply') {
      const parentRef = refs.get(a.parentId);
      if (!parentRef) continue;
      dict = baseDict(ctx, a, 'Text', rects.get(a.parentId) ?? [0, 0, 0, 0]);
      dict.set(PDFName.of('IRT'), parentRef);
      dict.set(PDFName.of('RT'), PDFName.of('R'));
      dict.set(PDFName.of('F'), ctx.obj(4));
    } else {
      const f = needsFont(a) ? await ensureFont() : undefined;
      const ap = buildAppearance(a, g, f);
      const image = ap.image ? await embedDataUrl(doc, ap.image.dataUrl) : undefined;
      dict = baseDict(ctx, a, SUBTYPE[a.type]!, ap.rect);
      addTypeSpecific(ctx, dict, a, g);
      const apRef = ctx.register(appearanceStream(ctx, ap, f, image));
      dict.set(PDFName.of('AP'), ctx.obj({ N: apRef }));
      rects.set(a.id, ap.rect);
    }

    let ref = prev?.ref;
    if (ref) {
      const old = ctx.lookup(ref);
      if (old instanceof PDFDict) {
        const oldAp = ctx.lookup(old.get(PDFName.of('AP')));
        if (oldAp instanceof PDFDict) {
          const n = oldAp.get(PDFName.of('N'));
          if (n instanceof PDFRef) ctx.delete(n);
        }
      }
      ctx.assign(ref, dict);
    } else {
      ref = ctx.register(dict);
      ensureAnnots(doc.getPage(a.page)).push(ref);
    }
    refs.set(a.id, ref);
  }

  // ---- review status records for parents that changed
  for (const a of annotations) {
    if (a.type === 'reply' || a.status === 'none' || !touched.has(a.id)) continue;
    const parentRef = refs.get(a.id);
    if (!parentRef) continue;
    const dict = ctx.obj({}) as PDFDict;
    dict.set(PDFName.of('Type'), PDFName.of('Annot'));
    dict.set(PDFName.of('Subtype'), PDFName.of('Text'));
    dict.set(PDFName.of('Rect'), ctx.obj(rects.get(a.id) ?? [0, 0, 0, 0]));
    dict.set(PDFName.of('NM'), PDFHexString.fromText(a.id + STATE_SUFFIX));
    dict.set(PDFName.of('T'), PDFHexString.fromText(a.author));
    dict.set(PDFName.of('M'), PDFString.of(toPdfDate(a.modifiedAt)));
    dict.set(PDFName.of('IRT'), parentRef);
    dict.set(PDFName.of('RT'), PDFName.of('R'));
    dict.set(PDFName.of('StateModel'), PDFString.of('Review'));
    dict.set(PDFName.of('State'), PDFString.of(STATE_NAME[a.status]));
    dict.set(PDFName.of('F'), ctx.obj(4));
    ensureAnnots(doc.getPage(a.page)).push(ctx.register(dict));
  }

  return doc.save();
}

function baseDict(ctx: PDFContext, a: Annotation, subtype: string, rect: number[]): PDFDict {
  const d = ctx.obj({}) as PDFDict;
  d.set(PDFName.of('Type'), PDFName.of('Annot'));
  d.set(PDFName.of('Subtype'), PDFName.of(subtype));
  d.set(PDFName.of('Rect'), ctx.obj(rect));
  d.set(PDFName.of('NM'), PDFHexString.fromText(a.id));
  d.set(PDFName.of('T'), PDFHexString.fromText(a.author));
  d.set(PDFName.of('Contents'), PDFHexString.fromText(a.contents));
  d.set(PDFName.of('M'), PDFString.of(toPdfDate(a.modifiedAt)));
  d.set(PDFName.of('CreationDate'), PDFString.of(toPdfDate(a.createdAt)));
  d.set(PDFName.of('F'), ctx.obj(4));
  return d;
}

const arrow = (s: string) => (s === 'arrow' ? 'ClosedArrow' : 'None');

function addTypeSpecific(ctx: PDFContext, d: PDFDict, a: Annotation, g: PageGeometry) {
  const set = (k: string, v: unknown) => d.set(PDFName.of(k), v as never);
  const rgb = (hex: string) => ctx.obj(hexToRgb(hex));
  const bs = (w: number) => ctx.obj({ Type: 'Border', W: w, S: 'S' });
  if (a.type !== 'freetext' && a.type !== 'reply') set('C', rgb(a.color));
  if (a.opacity < 1) set('CA', ctx.obj(a.opacity));

  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly': {
      const q: number[] = [];
      for (const r of a.quads) {
        // Acrobat order: top-left, top-right, bottom-left, bottom-right (in display space).
        for (const [x, y] of [
          [r.x, r.y],
          [r.x + r.width, r.y],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y + r.height],
        ] as const) {
          const u = toUser(g, { x, y });
          q.push(u.x, u.y);
        }
      }
      set('QuadPoints', ctx.obj(q));
      break;
    }
    case 'note':
      set('Name', PDFName.of('Comment'));
      set('Open', PDFBool.False);
      set('F', ctx.obj(28)); // print + no-zoom + no-rotate
      break;
    case 'freetext':
      set('DA', PDFString.of(`/${FONT_RESOURCE_NAME} ${a.fontSize} Tf ${colorOp(a.color).replace(' rg', '')} rg`));
      set('Q', ctx.obj(0));
      if (a.fill) set('C', rgb(a.fill));
      set('BS', bs(a.borderWidth));
      if (a.opacity < 1) set('CA', ctx.obj(a.opacity));
      break;
    case 'ink':
      set(
        'InkList',
        ctx.obj(
          a.strokes.map((s) => s.flatMap((p) => {
            const u = toUser(g, p);
            return [u.x, u.y];
          })),
        ),
      );
      set('BS', bs(a.width));
      break;
    case 'square':
    case 'circle':
      if (a.fill) set('IC', rgb(a.fill));
      set('BS', bs(a.width));
      break;
    case 'line': {
      const p1 = toUser(g, a.p1);
      const p2 = toUser(g, a.p2);
      set('L', ctx.obj([p1.x, p1.y, p2.x, p2.y]));
      set('LE', ctx.obj([arrow(a.startStyle), arrow(a.endStyle)]));
      set('BS', bs(a.width));
      if (a.endStyle === 'arrow' && a.startStyle === 'none') set('IT', PDFName.of('LineArrow'));
      break;
    }
  }
}

function appearanceStream(ctx: PDFContext, ap: Appearance, font?: PDFFont, image?: PDFImage) {
  const resources: Record<string, any> = {
    ExtGState: {
      GS: { Type: 'ExtGState', ca: ap.opacity, CA: ap.opacity, BM: ap.blendMultiply ? 'Multiply' : 'Normal' },
    },
  };
  if (font) resources.Font = { [FONT_RESOURCE_NAME]: font.ref };
  if (image) resources.XObject = { Im: image.ref };
  return ctx.flateStream('/GS gs\n' + ap.content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: ap.rect,
    Resources: resources,
  });
}

/** Decode a PNG/JPEG data URL and embed it. */
async function embedDataUrl(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error('Unsupported image data (expected a PNG or JPEG data URL)');
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return m[1]!.toLowerCase() === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}
