import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import type { PdfEngine } from '@pdfsuite/engine';
import {
  addHeaderFooter,
  addWatermark,
  assemble,
  cropPages,
  crc32,
  deleteItems,
  detectMargins,
  duplicateItems,
  formatRanges,
  identityPlan,
  insertBlank,
  isIdentity,
  itemsFromSource,
  makeZip,
  moveItems,
  parseRanges,
  planSplit,
  readOutline,
  resetCrop,
  rotateItems,
  splitPdf,
} from './index';
import { darkCount, makeDoc, makeEngines, pageTexts, pngDataUrl, renderPage, rgbAt } from './testutil';

let engines: PdfEngine[] = [];
beforeAll(async () => {
  engines = await makeEngines();
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});
const pdfium = () => engines[0]!;

describe('ranges', () => {
  it('parses and formats ranges', () => {
    expect(parseRanges('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parseRanges('8-', 10)).toEqual([7, 8, 9]);
    expect(parseRanges('odd', 5)).toEqual([0, 2, 4]);
    expect(parseRanges('even', 5)).toEqual([1, 3]);
    expect(parseRanges('', 3)).toEqual([0, 1, 2]);
    expect(parseRanges('2, 2, 1', 3)).toEqual([0, 1]);
    expect(formatRanges([0, 1, 2, 4, 6, 7])).toBe('1-3, 5, 7-8');
  });
  it('rejects malformed input', () => {
    expect(() => parseRanges('abc', 5)).toThrow(/Invalid/);
    expect(() => parseRanges('3-1', 5)).toThrow(/backwards/);
    expect(() => parseRanges('9', 5)).toThrow(/beyond/);
    expect(() => parseRanges('0', 5)).toThrow();
  });
});

describe('plan helpers', () => {
  it('reorders, duplicates, deletes, rotates and inserts blanks', () => {
    const base = identityPlan(4);
    const ids = (items: typeof base) => items.map((i) => (i.page === 'blank' ? 'B' : i.page));
    expect(isIdentity(base, 4)).toBe(true);
    expect(ids(moveItems(base, new Set([base[0]!.id, base[1]!.id]), 2))).toEqual([2, 3, 0, 1]);
    expect(ids(moveItems(base, new Set([base[3]!.id]), 0))).toEqual([3, 0, 1, 2]);
    expect(ids(deleteItems(base, new Set([base[1]!.id])))).toEqual([0, 2, 3]);
    expect(ids(duplicateItems(base, new Set([base[1]!.id])))).toEqual([0, 1, 1, 2, 3]);
    expect(ids(insertBlank(base, 1, { width: 100, height: 100 }, 2))).toEqual([0, 1, 'B', 'B', 2, 3]);
    const rot = rotateItems(base, new Set([base[0]!.id]), -90);
    expect(rot[0]!.rotate).toBe(270);
    expect(isIdentity(rot, 4)).toBe(false);
  });
});

describe('assemble', () => {
  it('reorders and deletes pages in place', async () => {
    const src = await makeDoc(4);
    const plan = identityPlan(4);
    const out = await assemble([src], [plan[3]!, plan[1]!, plan[0]!]);
    for (const e of engines) expect(await pageTexts(e, out)).toEqual(['Page 4', 'Page 2', 'Page 1']);
  });

  it('rotates, duplicates and inserts blank pages', async () => {
    const src = await makeDoc(2);
    let plan = identityPlan(2);
    plan = rotateItems(plan, new Set([plan[0]!.id]), 90);
    plan = duplicateItems(plan, new Set([plan[1]!.id]));
    plan = insertBlank(plan, 0, { width: 200, height: 100 });
    const out = await assemble([src], plan);
    expect(await pageTexts(pdfium(), out)).toEqual(['Page 1', '', 'Page 2', 'Page 2']);
    const doc = await PDFDocument.load(out);
    const pages = doc.getPages();
    expect(pages[0]!.getRotation().angle).toBe(90);
    expect(pages[1]!.getSize()).toEqual({ width: 200, height: 100 });
    expect(pages[3]!.getRotation().angle).toBe(0);
  });

  it('merges pages from other documents (with ranges)', async () => {
    const a = await makeDoc(2, { label: 'A' });
    const b = await makeDoc(3, { label: 'B' });
    const out = await assemble([a, b], [...itemsFromSource(0, [0, 1]), ...itemsFromSource(1, [2, 0])]);
    for (const e of engines) expect(await pageTexts(e, out)).toEqual(['A 1', 'A 2', 'B 3', 'B 1']);
  });

  it('keeps inherited page attributes when pages are re-parented', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) doc.addPage([300, 400]).drawText(`P${i + 1}`, { x: 50, y: 50, size: 20, font });
    const root = doc.catalog.Pages();
    root.set(PDFName.of('Rotate'), doc.context.obj(90));
    const src = await doc.save();
    const plan = identityPlan(2);
    const out = await assemble([src], [plan[1]!, plan[0]!]);
    const back = await PDFDocument.load(out);
    expect(back.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90]);
    expect(await pageTexts(pdfium(), out)).toEqual(['P2', 'P1']);
  });

  it('prunes form fields whose pages were deleted but keeps the rest', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();
    for (let i = 0; i < 3; i++) {
      const p = doc.addPage([300, 400]);
      form.createTextField(`f${i}`).addToPage(p, { x: 20, y: 300, width: 100, height: 20, font });
    }
    const src = await doc.save();
    const plan = identityPlan(3);
    const out = await assemble([src], [plan[0]!, plan[2]!]);
    const names = (await PDFDocument.load(out)).getForm().getFields().map((f) => f.getName());
    expect(names.sort()).toEqual(['f0', 'f2']);
  });

  it('refuses empty plans and bad pages', async () => {
    const src = await makeDoc(1);
    await expect(assemble([src], [])).rejects.toThrow(/at least one page/);
    await expect(assemble([src], itemsFromSource(0, [5]))).rejects.toThrow(/does not exist/);
  });
});

describe('crop', () => {
  it('trims margins in display space, including on rotated pages', async () => {
    const src = await makeDoc(2, { rotate: { 1: 90 } });
    const out = await cropPages(src, [0, 1], { top: 40, right: 20, bottom: 10, left: 30 });
    const a = await renderPage(pdfium(), out, 0);
    expect([a.width, a.height]).toEqual([250, 350]); // 300x400 minus margins
    const b = await renderPage(pdfium(), out, 1);
    expect([b.width, b.height]).toEqual([400 - 50, 300 - 50]); // rotated: display 400x300
    // content moved by the left/top margins: the label "Page 1" now starts 30pt closer to the left edge
    expect(darkCount(a, 60, 150, 100, 40)).toBeGreaterThan(20);
    const reset = await resetCrop(out, [0, 1]);
    expect((await renderPage(pdfium(), reset, 0)).width).toBe(300);
  });

  it('refuses to crop a page to nothing', async () => {
    await expect(cropPages(await makeDoc(1), [0], { top: 200, right: 0, bottom: 200, left: 0 })).rejects.toThrow(/nothing/);
  });

  it('detects blank margins from a bitmap', () => {
    const w = 100;
    const h = 80;
    const px = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 20; y < 50; y++) for (let x = 30; x < 70; x++) px.set([0, 0, 0, 255], (y * w + x) * 4);
    const m = detectMargins(px, w, h, 1, 0);
    expect(m).toEqual({ left: 30, top: 20, right: 30, bottom: 30 });
    expect(detectMargins(new Uint8ClampedArray(w * h * 4).fill(255), w, h, 1)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});

describe('header, footer, page numbers, Bates', () => {
  it('expands tokens on the right pages and draws them', async () => {
    const src = await makeDoc(3);
    const out = await addHeaderFooter(src, {
      pages: [0, 1, 2],
      header: { left: '<<file>>', right: '<<date>>' },
      footer: { center: 'Page <<page>> of <<pages>>', right: '<<bates>>' },
      style: { family: 'Helvetica', size: 10, color: '#000000' },
      margin: { top: 20, bottom: 20, side: 24 },
      bates: { prefix: 'ABC-', suffix: '', start: 100, digits: 6 },
      fileName: 'contract.pdf',
      date: new Date(2026, 0, 5),
    });
    for (const e of engines) {
      const t = await pageTexts(e, out);
      expect(t[1]).toContain('Page 2 of 3');
      expect(t[1]).toContain('ABC-000101');
      expect(t[0]).toContain('contract.pdf');
      expect(t[2]).toContain('ABC-000102');
    }
    // footer text centred near the bottom: dark pixels around y = 400-20
    const b = await renderPage(pdfium(), out, 0);
    expect(darkCount(b, 110, 372, 80, 14)).toBeGreaterThan(15);
  });

  it('is upright on rotated pages, honours start number and a subset of pages', async () => {
    const src = await makeDoc(2, { rotate: { 0: 90 } });
    const out = await addHeaderFooter(src, {
      pages: [0],
      header: {},
      footer: { left: 'N<<page>>' },
      style: { family: 'Courier', bold: true, size: 14, color: '#ff0000' },
      margin: { top: 20, bottom: 20, side: 24 },
      startNumber: 7,
    });
    expect((await pageTexts(pdfium(), out))[0]).toContain('N7');
    expect((await pageTexts(pdfium(), out))[1]).not.toContain('N');
    // rotated page displays 400x300; footer-left text sits at x~24..50, y~280 and is red
    const b = await renderPage(pdfium(), out, 0);
    let red = 0;
    for (let y = 262; y < 286; y++) for (let x = 20; x < 60; x++) {
      const [r, g] = rgbAt(b, x, y);
      if (r > 180 && g < 90) red++;
    }
    expect(red).toBeGreaterThan(10);
  });

  it('is not disturbed by pages whose content leaves the graphics state transformed', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('q 0.5 0 0 0.5 100 100 cm 0 0 0 rg 0 0 50 50 re f'))); // never restored
    const src = await doc.save();
    const out = await addHeaderFooter(src, { pages: [0], header: {}, footer: { left: 'FOOT' }, style: { family: 'Helvetica', size: 12, color: '#000000' }, margin: { top: 20, bottom: 20, side: 20 } });
    const b = await renderPage(pdfium(), out, 0);
    expect(darkCount(b, 18, 366, 60, 16)).toBeGreaterThan(10); // text at the expected spot, not scaled/shifted
  });
});

describe('watermark', () => {
  const coverPage = async () => {
    // a page whose content paints solid white over everything (to prove "behind" really is behind)
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('1 1 1 rg 0 0 300 400 re f')));
    return doc.save();
  };
  const spec = { pages: [0], kind: 'text' as const, text: 'DRAFT', style: { family: 'Helvetica' as const, bold: true, size: 80, color: '#ff0000' }, opacity: 1, rotation: 0, position: 'center' as const };

  it('draws text over the page, centred', async () => {
    const out = await addWatermark(await coverPage(), { ...spec, layer: 'over' });
    for (const e of engines) {
      const b = await renderPage(e, out, 0);
      let red = 0;
      for (let y = 170; y < 230; y++) for (let x = 60; x < 240; x++) {
        const [r, g] = rgbAt(b, x, y);
        if (r > 200 && g < 80) red++;
      }
      expect(red).toBeGreaterThan(300);
    }
  });

  it('draws behind page content when asked', async () => {
    const out = await addWatermark(await coverPage(), { ...spec, layer: 'behind' });
    const b = await renderPage(pdfium(), out, 0);
    for (let y = 170; y < 230; y += 10) for (let x = 60; x < 240; x += 10) expect(rgbAt(b, x, y)).toEqual([255, 255, 255]);
    // ...but the same watermark stays visible on a page without an opaque cover
    const visible = await addWatermark(await makeDoc(1), { ...spec, layer: 'behind' });
    const v = await renderPage(pdfium(), visible, 0);
    let red = 0;
    for (let y = 170; y < 230; y++) for (let x = 60; x < 240; x++) if (rgbAt(v, x, y)[0] > 200 && rgbAt(v, x, y)[1] < 80) red++;
    expect(red).toBeGreaterThan(300);
    // and the page's own text still draws
    expect((await pageTexts(pdfium(), visible))[0]).toContain('Page 1');
  });

  it('rotates, applies opacity, tiles and supports images', async () => {
    const half = await addWatermark(await coverPage(), { ...spec, opacity: 0.5, layer: 'over' });
    const [r, g] = rgbAt(await renderPage(pdfium(), half, 0), 150, 200);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(40); // blended with white, not pure red
    const rotated = await addWatermark(await coverPage(), { ...spec, rotation: 90, layer: 'over' });
    const rb = await renderPage(pdfium(), rotated, 0);
    // 90deg ccw: the word now runs bottom-to-top, so it is tall and narrow
    let minX = 999, maxX = 0, minY = 999, maxY = 0;
    for (let y = 0; y < rb.height; y++) for (let x = 0; x < rb.width; x++) if (rgbAt(rb, x, y)[1] < 80) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    expect(maxY - minY).toBeGreaterThan((maxX - minX) * 2);
    const tiled = await addWatermark(await coverPage(), { ...spec, style: { ...spec.style, size: 24 }, position: 'tile', layer: 'over' });
    const tb = await renderPage(pdfium(), tiled, 0);
    expect(darkCount(tb, 0, 0, 300, 100, 255) - darkCount(tb, 0, 0, 300, 100, 255)).toBe(0); // sanity: function runs
    let regions = 0;
    for (const [x, y] of [[20, 40], [200, 60], [40, 200], [200, 330]] as [number, number][]) {
      for (let j = 0; j < 80; j++) for (let i = 0; i < 80; i++) if (rgbAt(tb, x + i, y + j)[1] < 80) { regions++; j = 80; break; }
    }
    expect(regions).toBeGreaterThanOrEqual(3);
    const img = await addWatermark(await coverPage(), { pages: [0], kind: 'image', dataUrl: pngDataUrl(20, 10, '#0000ff'), imageScale: 0.5, opacity: 1, rotation: 0, position: 'center', layer: 'over' });
    for (const e of engines) expect(rgbAt(await renderPage(e, img, 0), 150, 200)).toEqual([0, 0, 255]);
  });

  it('rejects empty text', async () => {
    await expect(addWatermark(await makeDoc(1), { ...spec, text: '  ', layer: 'over' })).rejects.toThrow(/empty/);
  });
});

describe('outline and split', () => {
  async function docWithOutline() {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage([200, 200]).drawText(`P${i + 1}`, { x: 20, y: 100, size: 20 });
    const ctx = doc.context;
    const pages = doc.getPages();
    const item = (title: string, dest: unknown, extra: Record<string, unknown> = {}) => {
      const d = ctx.obj({ Title: PDFHexString.fromText(title), ...extra }) as PDFDict;
      d.set(PDFName.of('Dest'), dest as never);
      return d;
    };
    const chap1 = item('Chapter 1', ctx.obj([pages[0]!.ref, PDFName.of('Fit')]));
    const chap2 = item('Chapter 2', PDFString.of('ch2')); // named destination
    const sub = item('Section 2.1', ctx.obj([pages[3]!.ref, PDFName.of('Fit')]));
    const chap3 = item('Chapter 3', ctx.obj([pages[4]!.ref, PDFName.of('Fit')]));
    const refs = [chap1, chap2, chap3].map((d) => ctx.register(d));
    const subRef = ctx.register(sub);
    const root = ctx.obj({ Type: 'Outlines' }) as PDFDict;
    const rootRef = ctx.register(root);
    refs.forEach((r, i) => {
      const d = ctx.lookup(r) as PDFDict;
      d.set(PDFName.of('Parent'), rootRef);
      if (refs[i + 1]) d.set(PDFName.of('Next'), refs[i + 1]!);
    });
    (ctx.lookup(refs[1]!) as PDFDict).set(PDFName.of('First'), subRef);
    sub.set(PDFName.of('Parent'), refs[1]!);
    root.set(PDFName.of('First'), refs[0]!);
    doc.catalog.set(PDFName.of('Outlines'), rootRef);
    doc.catalog.set(PDFName.of('Dests'), ctx.obj({ ch2: ctx.obj([pages[2]!.ref, PDFName.of('Fit')]) }));
    return doc.save();
  }

  it('reads nested bookmarks with explicit and named destinations', async () => {
    const tree = await readOutline(await docWithOutline());
    expect(tree.map((t) => [t.title, t.page])).toEqual([['Chapter 1', 0], ['Chapter 2', 2], ['Chapter 3', 4]]);
    expect(tree[1]!.children.map((c) => [c.title, c.page])).toEqual([['Section 2.1', 3]]);
    expect(await readOutline(await makeDoc(2))).toEqual([]);
  });

  it('plans splits by size, ranges and bookmarks', async () => {
    expect(planSplit(5, { mode: 'every', n: 2 })).toEqual([[0, 1], [2, 3], [4]]);
    expect(planSplit(6, { mode: 'ranges', ranges: '1-2, 4-' })).toEqual([[0, 1], [3, 4, 5]]);
    const tree = await readOutline(await docWithOutline());
    expect(planSplit(6, { mode: 'bookmarks' }, tree)).toEqual([[0, 1], [2, 3], [4, 5]]);
    expect(planSplit(3, { mode: 'bookmarks' }, [])).toEqual([[0, 1, 2]]);
  });

  it('splits into separate PDFs with sensible names', async () => {
    const src = await makeDoc(5);
    const parts = await splitPdf(src, planSplit(5, { mode: 'every', n: 2 }), 'report');
    expect(parts.map((p) => p.name)).toEqual(['report_1-2.pdf', 'report_3-4.pdf', 'report_5.pdf']);
    expect(await pageTexts(pdfium(), parts[1]!.data)).toEqual(['Page 3', 'Page 4']);
    expect((await PDFDocument.load(parts[2]!.data)).getPageCount()).toBe(1);
  });
});

describe('zip', () => {
  it('writes a valid archive (checked by walking the central directory)', () => {
    const files = [
      { name: 'a.pdf', data: new TextEncoder().encode('hello') },
      { name: 'ünï.pdf', data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];
    const zip = makeZip(files);
    const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const end = zip.length - 22;
    expect(v.getUint32(end, true)).toBe(0x06054b50);
    expect(v.getUint16(end + 10, true)).toBe(2);
    let p = v.getUint32(end + 16, true);
    for (const f of files) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      expect(v.getUint32(p + 16, true)).toBe(crc32(f.data));
      const nameLen = v.getUint16(p + 28, true);
      const localAt = v.getUint32(p + 42, true);
      expect(v.getUint32(localAt, true)).toBe(0x04034b50);
      const dataAt = localAt + 30 + v.getUint16(localAt + 26, true);
      expect([...zip.slice(dataAt, dataAt + f.data.length)]).toEqual([...f.data]);
      expect(new TextDecoder().decode(zip.slice(p + 46, p + 46 + nameLen))).toBe(f.name);
      p += 46 + nameLen;
    }
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

// keep the unused import referenced for readers of the test file
void PDFArray;
