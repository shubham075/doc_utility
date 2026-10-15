import { PDFArray, PDFDict, PDFDocument, PDFName, PDFPage, PDFRef, degrees } from 'pdf-lib';
import { loadDoc } from '@pdfsuite/annotations';
import { normaliseTurn, type PlanItem } from './plan';

/** Copy inheritable page attributes onto the leaf so the page survives being re-parented in the page tree. */
function materializeInherited(page: PDFPage) {
  const node = page.node;
  for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
    const name = PDFName.of(key);
    if (node.has(name)) continue;
    const inherited = node.ascend((n) => n.get(name));
    if (inherited !== undefined) node.set(name, inherited);
  }
}

/**
 * Build a PDF from a page plan.
 *
 * Pages of `sources[0]` that appear once are *moved* inside that same document, so its form, outlines,
 * metadata, page labels etc. are preserved. Duplicates, pages from other sources and blank pages are
 * created/copied. Limitations of copying with pdf-lib: bookmarks and named destinations of other
 * sources are not carried over, and their AcroForm fields are not merged (widgets keep their look but
 * are no longer fillable).
 */
export async function assemble(sources: readonly Uint8Array[], items: readonly PlanItem[]): Promise<Uint8Array> {
  if (!sources.length) throw new Error('assemble needs at least one source document');
  if (!items.length) throw new Error('A PDF needs at least one page');
  const doc = await loadDoc(sources[0]!);
  const originals = doc.getPages();
  for (const p of originals) materializeInherited(p);

  const others = new Map<number, PDFDocument>();
  const otherDoc = async (src: number) => {
    let d = others.get(src);
    if (!d) {
      const bytes = sources[src];
      if (!bytes) throw new Error(`Unknown source document ${src}`);
      d = await loadDoc(bytes);
      others.set(src, d);
    }
    return d;
  };

  const used = new Set<number>();
  const finalPages: PDFPage[] = [];
  for (const it of items) {
    let page: PDFPage;
    if (it.page === 'blank') {
      const size = it.blank ?? { width: 612, height: 792 };
      page = PDFPage.create(doc);
      page.setSize(size.width, size.height);
    } else if (it.src === 0) {
      const orig = originals[it.page];
      if (!orig) throw new Error(`Page ${it.page + 1} does not exist`);
      if (!used.has(it.page)) {
        used.add(it.page);
        page = orig;
      } else {
        page = (await doc.copyPages(doc, [it.page]))[0]!; // duplicate of a page already placed
      }
    } else {
      const src = await otherDoc(it.src);
      if (it.page >= src.getPageCount()) throw new Error(`Page ${it.page + 1} does not exist in source ${it.src}`);
      page = (await doc.copyPages(src, [it.page]))[0]!;
    }
    if (it.rotate) page.setRotation(degrees(normaliseTurn(page.getRotation().angle + it.rotate)));
    finalPages.push(page);
  }

  // Replace the page list: remove everything, then insert the plan in order.
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
  finalPages.forEach((p, i) => doc.insertPage(i, p));
  pruneOrphanFields(doc);
  return doc.save();
}

/** Remove AcroForm fields/widgets whose widget annotations are no longer on any page (deleted pages). */
function pruneOrphanFields(doc: PDFDocument) {
  const ctx = doc.context;
  const acro = ctx.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if (!(acro instanceof PDFDict)) return;
  const live = new Set<string>();
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i);
      if (r instanceof PDFRef) live.add(r.toString());
    }
  }
  /** Returns true if the field should be kept. */
  const keep = (ref: PDFRef | undefined, node: PDFDict, depth: number): boolean => {
    const kids = ctx.lookup(node.get(PDFName.of('Kids')));
    if (kids instanceof PDFArray && depth < 32) {
      for (let i = kids.size() - 1; i >= 0; i--) {
        const k = kids.get(i);
        const kd = ctx.lookup(k);
        if (!(kd instanceof PDFDict) || !keep(k instanceof PDFRef ? k : undefined, kd, depth + 1)) kids.remove(i);
      }
      return kids.size() > 0;
    }
    return ref === undefined ? true : live.has(ref.toString()); // terminal widget/field
  };
  const fields = ctx.lookup(acro.get(PDFName.of('Fields')));
  if (!(fields instanceof PDFArray)) return;
  for (let i = fields.size() - 1; i >= 0; i--) {
    const f = fields.get(i);
    const fd = ctx.lookup(f);
    if (!(fd instanceof PDFDict) || !keep(f instanceof PDFRef ? f : undefined, fd, 0)) fields.remove(i);
  }
}
