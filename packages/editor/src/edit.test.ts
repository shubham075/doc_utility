import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { diffFraction, fallbackFont, makeEngines, pageText, render } from './testutil';
import { scanPage } from './scan';
import { openForEdit, editText, moveResizeObjects, deleteObjects } from './edit';

// 2x2 red PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2P8z8Dwn4EIwDiqEF8oAAC3VQz9UoTqgwAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

async function makeDoc(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([400, 300]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Hello World', { x: 40, y: 250, size: 18, font: f });
  page.drawText('Second line', { x: 40, y: 220, size: 12, font: f });
  const img = await doc.embedPng(PNG);
  page.drawImage(img, { x: 40, y: 100, width: 80, height: 60 });
  page.drawRectangle({ x: 200, y: 100, width: 60, height: 40, color: rgb(0, 0, 1) });
  return doc.save();
}

let engines: Awaited<ReturnType<typeof makeEngines>>;
let base: Uint8Array;
beforeAll(async () => {
  engines = await makeEngines();
  base = await makeDoc();
});

describe('scan', () => {
  it('finds text, image and path objects with display-space boxes', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const kinds = s.objects.map((o) => o.kind).sort();
    expect(kinds).toEqual(['image', 'path', 'text', 'text']);
    const hello = s.objects.find((o) => o.text === 'Hello World')!;
    expect(hello.editable).toBe(true);
    expect(hello.bbox.x).toBeCloseTo(40, 0);
    expect(hello.bbox.y).toBeGreaterThan(30); // top-left origin
    expect(hello.bbox.y).toBeLessThan(55);
    const img = s.objects.find((o) => o.kind === 'image')!;
    expect(img.bbox).toMatchObject({ x: 40, width: 80, height: 60 });
    expect(img.bbox.y).toBeCloseTo(140, 0);
  });
});

describe('move, resize, delete', () => {
  it('moves and resizes an image and a path', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const img = s.objects.find((o) => o.kind === 'image')!;
    const path = s.objects.find((o) => o.kind === 'path')!;
    const out = await moveResizeObjects(base, 0, [
      { id: img.id, bbox: { x: 100, y: 40, width: 160, height: 120 } },
      { id: path.id, bbox: { x: path.bbox.x + 20, y: path.bbox.y - 30, width: path.bbox.width, height: path.bbox.height } },
    ]);
    const after = await scanPage(await openForEdit(out), 0);
    const img2 = after.objects.find((o) => o.kind === 'image')!;
    const path2 = after.objects.find((o) => o.kind === 'path')!;
    expect(img2.bbox.x).toBeCloseTo(100, 1);
    expect(img2.bbox.y).toBeCloseTo(40, 1);
    expect(img2.bbox.width).toBeCloseTo(160, 1);
    expect(img2.bbox.height).toBeCloseTo(120, 1);
    expect(path2.bbox.x).toBeCloseTo(path.bbox.x + 20, 1);
    expect(path2.bbox.y).toBeCloseTo(path.bbox.y - 30, 1);
    expect(await pageText(engines.pdfjs, out)).toContain('Hello World');
  });

  it('moves a text run without disturbing the other lines', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const t = s.objects.find((o) => o.text === 'Hello World')!;
    const other = s.objects.find((o) => o.text === 'Second line')!;
    const out = await moveResizeObjects(base, 0, [{ id: t.id, bbox: { ...t.bbox, x: t.bbox.x + 100, y: t.bbox.y + 60 } }]);
    const a = await scanPage(await openForEdit(out), 0);
    const moved = a.objects.find((o) => o.text === 'Hello World')!;
    expect(moved.bbox.x).toBeCloseTo(t.bbox.x + 100, 1);
    expect(moved.bbox.y).toBeCloseTo(t.bbox.y + 60, 1);
    const still = a.objects.find((o) => o.text === 'Second line')!;
    expect(still.bbox.x).toBeCloseTo(other.bbox.x, 1);
    expect(still.bbox.y).toBeCloseTo(other.bbox.y, 1);
  });

  it('deletes objects', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const ids = s.objects.filter((o) => o.kind === 'image' || o.text === 'Second line').map((o) => o.id);
    const out = await deleteObjects(base, 0, ids);
    const a = await scanPage(await openForEdit(out), 0);
    expect(a.objects.map((o) => o.kind).sort()).toEqual(['path', 'text']);
    expect(await pageText(engines.pdfjs, out)).toBe('Hello World');
  });
});

describe('text editing', () => {
  it('replaces text using the original font', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const t = s.objects.find((o) => o.text === 'Hello World')!;
    const r = await editText(base, 0, t.id, 'Hello There', {});
    expect(r.usedFallback).toBe(false);
    expect(await pageText(engines.pdfjs, r.bytes)).toContain('Hello There');
    expect(await pageText(engines.pdfium, r.bytes)).toContain('Hello There');
    // everything else on the page is untouched
    const before = await render(engines.pdfium, base);
    const after = await render(engines.pdfium, r.bytes);
    const box = { x: 35, y: 30, width: 200, height: 40 };
    expect(diffFraction(before, after, [box])).toBeLessThan(0.0005);
  });

  it('uses the fallback font for characters the font lacks, and says so', async () => {
    const s = await scanPage(await openForEdit(base), 0);
    const t = s.objects.find((o) => o.text === 'Hello World')!;
    const r = await editText(base, 0, t.id, 'Hello Ωmega ✓', { fallbackFont });
    expect(r.usedFallback).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/substitute font/);
    const txt = await pageText(engines.pdfjs, r.bytes);
    expect(txt).toContain('Hello');
    expect(txt).toContain('Ωmega');
    expect(r.warnings.join(' ')).toMatch(/No font available for "✓"/);
  });
});
