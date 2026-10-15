import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString, type PDFContext, type PDFObject } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';
import { pruneUnreferenced } from '@pdfsuite/convert';

export interface Findings {
  metadata: { infoFields: Record<string, string>; xmp: boolean };
  javascript: { documentLevel: number; openAction: boolean; fieldActions: number; annotationActions: number };
  attachments: string[];
  annotations: { total: number; comments: number; links: number; byType: Record<string, number> };
  externalLinks: number;
  bookmarks: number;
  thumbnails: number;
  privateData: boolean;
  formFields: number;
  hiddenLayers: number;
  /** The file was saved incrementally: older revisions (possibly with deleted text) may still be inside. */
  previousVersions: boolean;
}

export interface SanitizeOptions {
  metadata: boolean;
  javascript: boolean;
  attachments: boolean;
  /** Remove comments/markup annotations (links and form fields are separate options). */
  comments: boolean;
  links: boolean;
  bookmarks: boolean;
  thumbnails: boolean;
  /** Application private data (/PieceInfo). */
  privateData: boolean;
  /** Burn form fields into the page and drop the form. */
  flattenForms: boolean;
}

export const SANITIZE_ALL: SanitizeOptions = { metadata: true, javascript: true, attachments: true, comments: true, links: true, bookmarks: true, thumbnails: true, privateData: true, flattenForms: false };

export interface SanitizeResult {
  bytes: Uint8Array;
  removed: Partial<Record<keyof SanitizeOptions | 'orphanObjects', number>>;
}

const MARKUP = new Set(['Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'Popup', 'Redact', 'Sound', 'Movie']);

const N = (s: string) => PDFName.of(s);
const text = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined;
};
const dict = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : undefined;
};
const arr = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFArray ? o : undefined;
};
const nameOf = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFName ? o.decodeText() : undefined;
};

/** Action dictionary types that execute code or leave the document. */
const isScriptAction = (ctx: PDFContext, a: PDFObject | undefined) => {
  const d = dict(ctx, a);
  const s = d && nameOf(ctx, d.get(N('S')));
  return s === 'JavaScript' || s === 'Launch' || s === 'ImportData' || s === 'SubmitForm' || s === 'GoToE';
};

/** Visit every page annotation dictionary with its page. */
function forEachAnnot(doc: PDFDocument, fn: (annot: PDFDict, ref: PDFRef | undefined, remove: () => void) => void) {
  const ctx = doc.context;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const raw = annots.get(i);
      const d = dict(ctx, raw);
      if (d) fn(d, raw instanceof PDFRef ? raw : undefined, () => annots.remove(i));
    }
  }
}

/** Walk the form field tree (terminal fields and their widgets). */
function forEachField(doc: PDFDocument, fn: (f: PDFDict) => void) {
  const ctx = doc.context;
  const acro = dict(ctx, doc.catalog.get(N('AcroForm')));
  const fields = acro && arr(ctx, acro.get(N('Fields')));
  const walk = (node: PDFObject | undefined, depth: number) => {
    const d = dict(ctx, node);
    if (!d || depth > 32) return;
    fn(d);
    const kids = arr(ctx, d.get(N('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  if (fields) for (let i = 0; i < fields.size(); i++) walk(fields.get(i), 0);
}

function embeddedFileNames(doc: PDFDocument): string[] {
  const ctx = doc.context;
  const out: string[] = [];
  const names = dict(ctx, doc.catalog.get(N('Names')));
  const walk = (node: PDFObject | undefined, depth: number) => {
    const d = dict(ctx, node);
    if (!d || depth > 10) return;
    const list = arr(ctx, d.get(N('Names')));
    if (list) for (let i = 0; i + 1 < list.size(); i += 2) out.push(text(ctx, list.get(i)) ?? '(unnamed)');
    const kids = arr(ctx, d.get(N('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.get(i), depth + 1);
  };
  if (names) walk(names.get(N('EmbeddedFiles')), 0);
  return out;
}

function countOutline(doc: PDFDocument): number {
  const ctx = doc.context;
  const root = dict(ctx, doc.catalog.get(N('Outlines')));
  let n = 0;
  const walk = (node: PDFObject | undefined, depth: number) => {
    let cur = dict(ctx, node);
    for (let g = 0; cur && g < 100000; g++) {
      n++;
      if (depth < 20) walk(cur.get(N('First')), depth + 1);
      cur = dict(ctx, cur.get(N('Next')));
    }
  };
  if (root) walk(root.get(N('First')), 0);
  return n;
}

/** Report what hidden or sensitive information a document carries. */
export async function examineDocument(bytes: Uint8Array): Promise<Findings> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const infoFields: Record<string, string> = {};
  const info = dict(ctx, ctx.trailerInfo.Info);
  if (info) for (const [k, v] of info.entries()) {
    const t = text(ctx, v);
    if (t) infoFields[k.decodeText()] = t;
  }

  const f: Findings = {
    metadata: { infoFields, xmp: !!doc.catalog.get(N('Metadata')) },
    javascript: { documentLevel: 0, openAction: false, fieldActions: 0, annotationActions: 0 },
    attachments: embeddedFileNames(doc),
    annotations: { total: 0, comments: 0, links: 0, byType: {} },
    externalLinks: 0,
    bookmarks: countOutline(doc),
    thumbnails: 0,
    privateData: !!doc.catalog.get(N('PieceInfo')),
    formFields: 0,
    hiddenLayers: 0,
    previousVersions: (new TextDecoder('latin1').decode(bytes).match(/%%EOF/g) ?? []).length > 1,
  };

  const js = dict(ctx, dict(ctx, doc.catalog.get(N('Names')))?.get(N('JavaScript')));
  if (js) {
    const list = arr(ctx, js.get(N('Names')));
    f.javascript.documentLevel = list ? list.size() / 2 : 1;
  }
  const open = ctx.lookup(doc.catalog.get(N('OpenAction')));
  f.javascript.openAction = open instanceof PDFDict && isScriptAction(ctx, open);
  if (dict(ctx, doc.catalog.get(N('AA')))) f.javascript.documentLevel += 1;

  doc.getPages().forEach((p) => {
    if (p.node.get(N('Thumb'))) f.thumbnails++;
    if (p.node.get(N('PieceInfo'))) f.privateData = true;
  });
  forEachAnnot(doc, (a) => {
    const sub = nameOf(ctx, a.get(N('Subtype'))) ?? 'Unknown';
    f.annotations.total++;
    f.annotations.byType[sub] = (f.annotations.byType[sub] ?? 0) + 1;
    if (MARKUP.has(sub)) f.annotations.comments++;
    if (sub === 'Link') {
      f.annotations.links++;
      const act = dict(ctx, a.get(N('A')));
      if (act && ['URI', 'Launch', 'GoToR'].includes(nameOf(ctx, act.get(N('S'))) ?? '')) f.externalLinks++;
    }
    if (sub === 'FileAttachment') f.attachments.push(text(ctx, dict(ctx, a.get(N('FS')))?.get(N('F'))) ?? 'attachment');
    if (isScriptAction(ctx, a.get(N('A'))) || dict(ctx, a.get(N('AA')))) f.javascript.annotationActions++;
  });
  forEachField(doc, (fd) => {
    if (fd.get(N('FT'))) f.formFields++;
    if (dict(ctx, fd.get(N('AA'))) || isScriptAction(ctx, fd.get(N('A')))) f.javascript.fieldActions++;
  });

  // Optional content groups that are switched off by default.
  const oc = dict(ctx, doc.catalog.get(N('OCProperties')));
  const off = oc && arr(ctx, dict(ctx, oc.get(N('D')))?.get(N('OFF')));
  f.hiddenLayers = off ? off.size() : 0;
  return f;
}

/** Remove the selected categories of hidden/sensitive content and drop everything left unreferenced. */
export async function sanitizePdf(bytes: Uint8Array, options: Partial<SanitizeOptions> = SANITIZE_ALL): Promise<SanitizeResult> {
  const o = { ...SANITIZE_ALL, ...options };
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const removed: SanitizeResult['removed'] = {};
  const bump = (k: keyof SanitizeResult['removed'], n = 1) => (removed[k] = (removed[k] ?? 0) + n);

  if (o.flattenForms) {
    const form = doc.getForm();
    bump('flattenForms', form.getFields().length);
    form.flatten({ updateFieldAppearances: false });
  }

  if (o.metadata) {
    const info = ctx.trailerInfo.Info;
    if (info) {
      if (info instanceof PDFRef) ctx.delete(info);
      delete (ctx.trailerInfo as { Info?: PDFObject }).Info;
      bump('metadata');
    }
    if (doc.catalog.get(N('Metadata'))) {
      doc.catalog.delete(N('Metadata'));
      bump('metadata');
    }
    for (const p of doc.getPages()) if (p.node.get(N('Metadata'))) {
      p.node.delete(N('Metadata'));
      bump('metadata');
    }
  }

  if (o.javascript) {
    const names = dict(ctx, doc.catalog.get(N('Names')));
    if (names?.get(N('JavaScript'))) {
      names.delete(N('JavaScript'));
      bump('javascript');
    }
    const open = ctx.lookup(doc.catalog.get(N('OpenAction')));
    if (open instanceof PDFDict && isScriptAction(ctx, open)) {
      doc.catalog.delete(N('OpenAction'));
      bump('javascript');
    }
    if (doc.catalog.get(N('AA'))) {
      doc.catalog.delete(N('AA'));
      bump('javascript');
    }
    for (const p of doc.getPages()) if (p.node.get(N('AA'))) {
      p.node.delete(N('AA'));
      bump('javascript');
    }
    forEachAnnot(doc, (a) => {
      if (isScriptAction(ctx, a.get(N('A')))) {
        a.delete(N('A'));
        bump('javascript');
      }
      if (a.get(N('AA'))) {
        a.delete(N('AA'));
        bump('javascript');
      }
    });
    forEachField(doc, (fd) => {
      if (fd.get(N('AA'))) {
        fd.delete(N('AA'));
        bump('javascript');
      }
      if (isScriptAction(ctx, fd.get(N('A')))) {
        fd.delete(N('A'));
        bump('javascript');
      }
    });
    const acro = dict(ctx, doc.catalog.get(N('AcroForm')));
    if (acro?.get(N('CO'))) {
      acro.delete(N('CO')); // calculation order only matters for the scripts we just removed
      bump('javascript', 0);
    }
  }

  if (o.attachments) {
    const names = dict(ctx, doc.catalog.get(N('Names')));
    if (names?.get(N('EmbeddedFiles'))) {
      names.delete(N('EmbeddedFiles'));
      bump('attachments');
    }
    for (const k of ['AF', 'Collection']) if (doc.catalog.get(N(k))) {
      doc.catalog.delete(N(k));
      bump('attachments');
    }
    forEachAnnot(doc, (a, _r, remove) => {
      if (nameOf(ctx, a.get(N('Subtype'))) === 'FileAttachment') {
        remove();
        bump('attachments');
      }
    });
  }

  if (o.comments || o.links) {
    forEachAnnot(doc, (a, _r, remove) => {
      const sub = nameOf(ctx, a.get(N('Subtype'))) ?? '';
      if (o.comments && MARKUP.has(sub)) {
        remove();
        bump('comments');
      } else if (o.links && sub === 'Link') {
        remove();
        bump('links');
      }
    });
  }

  if (o.bookmarks && doc.catalog.get(N('Outlines'))) {
    doc.catalog.delete(N('Outlines'));
    bump('bookmarks');
  }
  if (o.thumbnails) for (const p of doc.getPages()) if (p.node.get(N('Thumb'))) {
    p.node.delete(N('Thumb'));
    bump('thumbnails');
  }
  if (o.privateData) {
    if (doc.catalog.get(N('PieceInfo'))) {
      doc.catalog.delete(N('PieceInfo'));
      bump('privateData');
    }
    for (const p of doc.getPages()) if (p.node.get(N('PieceInfo'))) {
      p.node.delete(N('PieceInfo'));
      bump('privateData');
    }
  }

  bump('orphanObjects', pruneUnreferenced(doc));
  // A full rewrite also discards earlier incremental revisions.
  return { bytes: await doc.save({ useObjectStreams: false }), removed };
}
