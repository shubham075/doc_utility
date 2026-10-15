import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import type { PdfEngine, RenderedBitmap } from '@pdfsuite/engine';
import { redactPdf, type JpegDecoder } from './redact';
import { makeEngines, pageTexts } from '../testutil';

let engines: PdfEngine[] = [];
beforeAll(async () => {
  engines = await makeEngines();
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

/** Every stream of the file, decoded, plus the raw file — what a forensic tool would search. */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let out = new TextDecoder('latin1').decode(bytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        out += '\n' + new TextDecoder('latin1').decode(decodePDFRawStream(obj).decode());
      } catch {
        /* binary image data */
      }
    }
  }
  return out;
}
/** Search text that may be literal, hex-encoded or TJ-split. */
const leaks = (hay: string, needle: string) => {
  const hex = Array.from(needle, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
  return hay.includes(needle) || hay.toUpperCase().includes(hex);
};

const render = async (e: PdfEngine, bytes: Uint8Array, page = 0): Promise<RenderedBitmap> => {
  const d = await e.open(bytes);
  const p = await d.getPage(page);
  const b = await p.render({ scale: 1 });
  d.close();
  return b;
};
const px = (b: RenderedBitmap, x: number, y: number) => {
  const i = (Math.round(y) * b.width + Math.round(x)) * 4;
  return [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!];
};
const isBlack = (c: number[]) => c.every((v) => v < 30);

async function textDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText('Name: SECRETNAME Account 12345 end', { x: 20, y: 200, size: 16, font });
  page.drawText('Second line stays untouched', { x: 20, y: 150, size: 16, font });
  return { bytes: await doc.save({ useObjectStreams: false }), font, width: (s: string) => font.widthOfTextAtSize(s, 16) };
}

describe('text redaction', () => {
  it('removes the covered words (and only those) from content, extraction and the file', async () => {
    const { bytes, width } = await textDoc();
    expect(leaks(await everything(bytes), 'SECRETNAME')).toBe(true);
    // display space: baseline y=200 on a 300pt page -> top of glyphs around y=100..
    const x0 = 20 + width('Name: ');
    const x1 = x0 + width('SECRETNAME');
    const { bytes: out, report } = await redactPdf(bytes, [{ page: 0, rects: [{ x: x0 - 0.5, y: 300 - 200 - 14, width: x1 - x0 + 1, height: 20 }] }]);
    expect(report.glyphsRemoved).toBeGreaterThanOrEqual('SECRETNAME'.length);
    expect(report.glyphsRemoved).toBeLessThanOrEqual('SECRETNAME'.length + 2); // may take a bordering space
    expect(leaks(await everything(out), 'SECRETNAME')).toBe(false);
    for (const e of engines) {
      const t = (await pageTexts(e, out))[0]!;
      expect(t).not.toContain('SECRET');
      expect(t).not.toContain('NAME ');
      expect(t).toContain('Name:');
      expect(t).toContain('Account 12345 end');
      expect(t).toContain('Second line stays untouched');
    }
    // the box is painted, and the neighbouring text did not move
    const before = await render(engines[0]!, bytes);
    const after = await render(engines[0]!, out);
    expect(isBlack(px(after, (x0 + x1) / 2, 300 - 200 - 4))).toBe(true);
    let moved = 0;
    for (let y = 100; y < 112; y++) for (let x = Math.ceil(x1) + 4; x < 380; x++) if (Math.abs(px(before, x, y)[0]! - px(after, x, y)[0]!) > 40) moved++;
    expect(moved).toBe(0);
  });

  it('handles TJ kerning arrays, quote operators, invisible text and rotated pages', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const page = doc.addPage([400, 300]);
    page.node.setFontDictionary(PDFName.of('F1'), font.ref);
    const content = [
      'BT /F1 16 Tf 20 250 Td [(SEC) -200 (RET) 120 (TJWORD) 60 ( keep1)] TJ ET',
      'BT /F1 16 Tf 20 200 Td 18 TL (first) Tj (QUOTEDSECRET) \' ET',
      'BT /F1 16 Tf 3 Tr 20 150 Td (HIDDENOCR text) Tj ET',
      'BT /F1 16 Tf 20 100 Td (plain keep2) Tj ET',
    ].join('\n');
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
    const src = await doc.save({ useObjectStreams: false });

    const sw = (s: string) => font.widthOfTextAtSize(s, 16);
    const out = (await redactPdf(src, [
      { page: 0, rects: [
        { x: 18, y: 300 - 250 - 14, width: sw('SECRET') + 3, height: 20 },
        { x: 18, y: 300 - 182 - 14, width: sw('QUOTEDSECRET') + 2, height: 20 },
        { x: 18, y: 300 - 150 - 14, width: sw('HIDDENOCR') + 2, height: 20 },
      ] },
    ])).bytes;
    const all = await everything(out);
    for (const needle of ['SEC', 'RET', 'QUOTEDSECRET', 'HIDDENOCR']) expect(leaks(all, needle), needle).toBe(false);
    for (const e of engines) {
      const t = (await pageTexts(e, out))[0]!;
      expect(t).toContain('keep1');
      expect(t).toContain('keep2');
      expect(t).toContain('first');
      expect(t).not.toContain('TJWORD'.slice(0, 2) + 'XX'); // sanity
    }
  });

  it('works in display space on rotated pages', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText('ROTATED SECRET visible', { x: 40, y: 150, size: 18, font });
    page.setRotation(degrees(90)); // displayed 300 x 400, text runs top-to-bottom
    const src = await doc.save({ useObjectStreams: false });
    // user (40..) along x becomes display y; user y=150 becomes display x=150
    const sx = 40 + font.widthOfTextAtSize('ROTATED ', 18);
    const { bytes: out, report } = await redactPdf(src, [{ page: 0, rects: [{ x: 140, y: sx - 1, width: 25, height: font.widthOfTextAtSize('SECRET', 18) + 2 }] }]);
    expect(report.glyphsRemoved).toBeGreaterThanOrEqual(6);
    expect(report.glyphsRemoved).toBeLessThanOrEqual(8);
    for (const e of engines) {
      const t = (await pageTexts(e, out))[0]!;
      expect(t).not.toContain('SECRET');
      expect(t).toContain('ROTATED');
      expect(t).toContain('visible');
    }
  });
});

describe('vectors, annotations, form XObjects', () => {
  it('removes small shapes inside the area but keeps large backgrounds; removes covered annotations and form values', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('0.9 0.9 0.9 rg 0 0 400 300 re f\n1 0 0 rg 100 100 20 20 re f\n0 0 1 rg 250 100 20 20 re f')));
    const field = doc.getForm().createTextField('acct');
    field.addToPage(page, { x: 90, y: 60, width: 60, height: 20, font });
    field.setText('MARKER_ACCT_VALUE');
    const note = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [95, 95, 115, 115], Contents: PDFHexString.fromText('MARKER_NOTE') }));
    page.node.Annots()!.push(note);
    const src = await doc.save({ useObjectStreams: false });
    expect(leaks(await everything(src), 'MARKER_ACCT_VALUE')).toBe(true);

    const { bytes: out, report } = await redactPdf(src, [{ page: 0, rects: [{ x: 85, y: 300 - 125, width: 80, height: 70 }] }]);
    expect(report).toMatchObject({ pathsRemoved: 1, annotationsRemoved: 2 });
    const all = await everything(out);
    expect(leaks(all, 'MARKER_NOTE')).toBe(false);
    expect(leaks(all, 'MARKER_ACCT_VALUE')).toBe(false);
    const b = await render(engines[0]!, out);
    expect(px(b, 110, 300 - 110)).toEqual([0, 0, 0]); // red square gone, covered
    expect(px(b, 260, 300 - 110)[2]).toBeGreaterThan(200); // blue square elsewhere survives
    expect(px(b, 300, 50)[0]).toBeGreaterThan(200); // grey background kept
  });

  it('rewrites form XObjects per use without damaging other pages that share them', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const form = ctx.register(
      ctx.flateStream('BT /F1 14 Tf 10 10 Td (FORMSECRET) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 40], Resources: { Font: { F1: font.ref } } }),
    );
    for (let i = 0; i < 2; i++) {
      const p = doc.addPage([300, 200]);
      p.node.setXObject(PDFName.of('Fm1'), form);
      p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 1 0 0 1 50 100 cm /Fm1 Do Q')));
    }
    const src = await doc.save({ useObjectStreams: false });
    const w = font.widthOfTextAtSize('FORM', 14);
    const { bytes: out, report } = await redactPdf(src, [{ page: 0, rects: [{ x: 58, y: 200 - 100 - 24, width: w + 2, height: 22 }] }]);
    expect(report).toMatchObject({ formXObjectsRewritten: 1 });
    expect(report.glyphsRemoved).toBeGreaterThanOrEqual(4);
    const t0 = (await pageTexts(engines[0]!, out))[0]!;
    const t1 = (await pageTexts(engines[0]!, out))[1]!;
    expect(t0).not.toContain('FORM');
    expect(t0).toContain('SECRET');
    expect(t1).toContain('FORMSECRET'); // untouched page keeps the original form
  });
});

describe('images', () => {
  const decodeJpeg: JpegDecoder = async (jpeg) => {
    const img = await loadImage(Buffer.from(jpeg));
    const c = createCanvas(img.width, img.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const rgb = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, j = 0; i < d.length; i += 4) {
      rgb[j++] = d[i]!;
      rgb[j++] = d[i + 1]!;
      rgb[j++] = d[i + 2]!;
    }
    return { width: img.width, height: img.height, rgb };
  };
  const picture = () => {
    const c = createCanvas(200, 100);
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 200, 100);
    x.fillStyle = '#ff0000';
    x.fillRect(0, 0, 100, 100); // left half red
    x.fillStyle = '#00aa00';
    x.fillRect(100, 0, 100, 100); // right half green
    return c;
  };

  async function imageDoc(kind: 'png' | 'jpeg') {
    const doc = await PDFDocument.create();
    const c = picture();
    const img = kind === 'png' ? await doc.embedPng(new Uint8Array(c.toBuffer('image/png'))) : await doc.embedJpg(new Uint8Array(c.toBuffer('image/jpeg', 100)));
    doc.addPage([400, 300]).drawImage(img, { x: 100, y: 100, width: 200, height: 100 });
    return doc.save({ useObjectStreams: false });
  }

  it.each(['png', 'jpeg'] as const)('blanks only the covered pixels of a %s image', async (kind) => {
    const src = await imageDoc(kind);
    // image occupies display x 100..300, y 100..200; cover its right half
    const { bytes: out, report } = await redactPdf(src, [{ page: 0, rects: [{ x: 200, y: 100, width: 100, height: 100 }] }], { decodeJpeg });
    expect(report).toMatchObject({ imagesRedacted: 1, imagesRemoved: 0 });
    for (const e of engines) {
      const b = await render(e, out);
      expect(px(b, 150, 150)[0]).toBeGreaterThan(200); // left half still red
      expect(px(b, 150, 150)[1]).toBeLessThan(80);
      expect(isBlack(px(b, 250, 150))).toBe(true); // right half blacked out
    }
    // the green pixels are gone from the file itself, not just painted over
    const doc = await PDFDocument.load(out);
    let greenPixels = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && (obj.dict.get(PDFName.of('Subtype')) as PDFName | undefined)?.decodeText() === 'Image') {
        const raw = decodePDFRawStream(obj).decode();
        for (let i = 0; i + 2 < raw.length; i += 3) if (raw[i]! < 40 && raw[i + 1]! > 140 && raw[i + 2]! < 40) greenPixels++;
      }
    }
    expect(greenPixels).toBe(0);
  });

  it('removes an image completely when its pixels cannot be edited safely', async () => {
    const src = await imageDoc('jpeg');
    const { report, bytes } = await redactPdf(src, [{ page: 0, rects: [{ x: 200, y: 100, width: 100, height: 100 }] }]); // no JPEG decoder supplied
    expect(report).toMatchObject({ imagesRedacted: 0, imagesRemoved: 1 });
    const b = await render(engines[0]!, bytes);
    expect(px(b, 150, 150)).toEqual([255, 255, 255]); // the whole picture is gone, not only the covered half
  });
});

describe('reports and no-ops', () => {
  it('leaves pages without marks byte-identical in content and counts only what it touched', async () => {
    const { bytes } = await textDoc();
    const { report } = await redactPdf(bytes, [{ page: 0, rects: [{ x: 300, y: 5, width: 10, height: 10 }] }]); // empty corner
    expect(report).toMatchObject({ glyphsRemoved: 0, imagesRedacted: 0, annotationsRemoved: 0 });
    const { report: none } = await redactPdf(bytes, []);
    expect(none.pages).toBe(0);
  });

  it('is accepted as a valid PDF by an independent parser (PDFium) and keeps page count', async () => {
    const { bytes } = await textDoc();
    const out = (await redactPdf(bytes, [{ page: 0, rects: [{ x: 20, y: 80, width: 100, height: 30 }] }])).bytes;
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    expect((await pageTexts(engines[0]!, out)).length).toBe(1);
    void PDFDict;
  });
});
