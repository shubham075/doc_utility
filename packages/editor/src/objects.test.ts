import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { fallbackFont, makeEngines, pageText, render } from './testutil';
import { scanPage } from './scan';
import { openForEdit } from './edit';
import { addImage, addShape, addText } from './add';
import { cropImage, encodePng, exportImage, replaceImage } from './images';
import { addLink, deleteLink, listLinks, updateLink } from './links';

let RED: Uint8Array;

let engines: Awaited<ReturnType<typeof makeEngines>>;
let base: Uint8Array;
beforeAll(async () => {
  engines = await makeEngines();
  RED = await encodePng(2, 2, 3, Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0]));
  const doc = await PDFDocument.create();
  const p = doc.addPage([300, 200]);
  p.drawText('Base', { x: 20, y: 170, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.addPage([300, 200]);
  base = await doc.save();
});

const pixel = (b: { width: number; data: Uint8ClampedArray }, x: number, y: number) => Array.from(b.data.slice((y * b.width + x) * 4, (y * b.width + x) * 4 + 3));

describe('adding content', () => {
  it('adds text, an image and shapes as page objects', async () => {
    let out = (await addText(base, 0, { x: 40, y: 60, text: 'Added line\nSecond', size: 16, color: '#cc0000', family: 'Times', bold: true })).bytes;
    const img = await addImage(out, 0, { x: 150, y: 80, width: 60, height: 40 }, { data: RED, type: 'png' });
    out = img.bytes;
    out = (await addShape(out, 0, { kind: 'rect', rect: { x: 20, y: 120, width: 50, height: 30 }, stroke: '#0000ff', fill: '#00ff00', width: 2 })).bytes;
    out = (await addShape(out, 0, { kind: 'ellipse', rect: { x: 100, y: 120, width: 50, height: 30 }, stroke: '#000000', fill: null, width: 1 })).bytes;
    out = (await addShape(out, 0, { kind: 'arrow', rect: { x: 200, y: 120, width: 60, height: 30 }, stroke: '#000000', fill: null, width: 2 })).bytes;

    const txt = await pageText(engines.pdfjs, out);
    expect(txt).toContain('Added line');
    expect(txt).toContain('Second');
    const bmp = await render(engines.pdfium, out);
    expect(pixel(bmp, 180, 100)).toEqual([255, 0, 0]); // the image
    expect(pixel(bmp, 45, 135)).toEqual([0, 255, 0]); // the filled rectangle
    const s = await scanPage(await openForEdit(out), 0);
    expect(s.objects.filter((o) => o.kind === 'text').map((o) => o.text)).toEqual(expect.arrayContaining(['Base', 'Added line', 'Second']));
    expect(s.objects.some((o) => o.kind === 'image')).toBe(true);
    expect(s.objects.filter((o) => o.kind === 'path').length).toBeGreaterThanOrEqual(3);
  });

  it('adds text on a rotated page so it reads upright', async () => {
    const doc = await PDFDocument.load(base);
    const { degrees } = await import('pdf-lib');
    doc.getPage(0).setRotation(degrees(90));
    const rotated = await doc.save();
    const r = await addText(rotated, 0, { x: 30, y: 30, text: 'Upright', size: 20, color: '#000000', family: 'Helvetica' });
    const s = await scanPage(await openForEdit(r.bytes), 0);
    const t = s.objects.find((o) => o.text === 'Upright')!;
    expect(t.bbox.x).toBeCloseTo(30, 0);
    expect(t.bbox.width).toBeGreaterThan(t.bbox.height * 2); // wider than tall = horizontal in display space
  });

  it('uses the fallback font for text outside Latin-1', async () => {
    const r = await addText(base, 0, { x: 30, y: 60, text: 'Ωmega Привет', size: 14, color: '#000000', family: 'Helvetica' }, { fallbackFont });
    expect(await pageText(engines.pdfjs, r.bytes)).toContain('Привет');
    await expect(addText(base, 0, { x: 30, y: 60, text: 'Ω', size: 14, color: '#000000', family: 'Helvetica' })).rejects.toThrow(/cannot show/);
  });
});

describe('image tools', () => {
  it('exports, replaces and crops an image', async () => {
    const added = await addImage(base, 0, { x: 100, y: 50, width: 80, height: 40 }, { data: RED, type: 'png' });
    const s = await scanPage(await openForEdit(added.bytes), 0);
    const img = s.objects.find((o) => o.kind === 'image')!;

    const exported = await exportImage(added.bytes, 0, img.id);
    expect(exported.extension).toBe('png');
    expect(Array.from(exported.data.slice(0, 4))).toEqual([137, 80, 78, 71]);

    // replace with a different picture, keeping proportions (2x2 square into 80x40 -> 40x40 centred)
    const replaced = await replaceImage(added.bytes, 0, img.id, { data: RED, type: 'png' }, 'contain');
    const after = (await scanPage(await openForEdit(replaced), 0)).objects.find((o) => o.kind === 'image')!;
    expect(after.bbox.width).toBeCloseTo(40, 1);
    expect(after.bbox.height).toBeCloseTo(40, 1);
    expect(after.bbox.x).toBeCloseTo(120, 1);

    const cropped = await cropImage(added.bytes, 0, img.id, { x: 100, y: 50, width: 40, height: 40 });
    const bmp = await render(engines.pdfium, cropped);
    expect(pixel(bmp, 110, 70)).toEqual([255, 0, 0]);
    expect(pixel(bmp, 170, 70)).toEqual([255, 255, 255]); // clipped away
  });
});

describe('links', () => {
  it('adds, lists, updates and deletes links', async () => {
    let out = await addLink(base, 0, { x: 20, y: 20, width: 100, height: 20 }, { uri: 'https://example.com/a' });
    out = await addLink(out, 0, { x: 20, y: 60, width: 100, height: 20 }, { page: 1 });
    let links = await listLinks(out, 0);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ kind: 'uri', uri: 'https://example.com/a', rect: { x: 20, y: 20, width: 100, height: 20 } });
    expect(links[1]).toMatchObject({ kind: 'page', page: 1 });

    out = await updateLink(out, 0, 0, { target: { uri: 'mailto:a@b.co' }, rect: { x: 30, y: 25, width: 90, height: 20 } });
    links = await listLinks(out, 0);
    expect(links[0]).toMatchObject({ uri: 'mailto:a@b.co', rect: { x: 30, y: 25 } });
    await expect(updateLink(out, 0, 0, { target: { uri: 'javascript:alert(1)' } })).rejects.toThrow(/must start with/);

    out = await deleteLink(out, 0, 0);
    links = await listLinks(out, 0);
    expect(links).toHaveLength(1);
    expect(links[0]!.kind).toBe('page');
    expect(await pageText(engines.pdfium, out)).toContain('Base');
  });
});
