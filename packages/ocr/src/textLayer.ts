import { PDFNumber, PDFOperator, StandardFonts, beginText, endText, popGraphicsState, pushGraphicsState, setFontAndSize, setTextMatrix, showText, type PDFFont } from 'pdf-lib';
import { loadDoc, pageGeometry, toUser } from '@pdfsuite/annotations';

export interface OcrWord {
  text: string;
  /** Pixel box in the rendered page image (origin top-left). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface PageOcr {
  /** Zero-based page index. */
  page: number;
  /** Pixels per point of the image the words were recognised on. */
  scale: number;
  words: readonly OcrWord[];
}

const MIN_CONFIDENCE = 30;

/** Replace characters the standard font cannot encode. */
const encodable = (font: PDFFont, text: string) => {
  const ok = new Set(font.getCharacterSet());
  return Array.from(text, (ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?')).join('');
};

/**
 * Add an invisible (render mode 3) text layer so scanned pages become searchable and selectable.
 * Each word is placed at its recognised box, stretched horizontally to the measured width, and written
 * upright for the page rotation. Visible page content is not touched.
 */
export async function addInvisibleText(bytes: Uint8Array, results: readonly PageOcr[]): Promise<{ bytes: Uint8Array; words: number }> {
  const doc = await loadDoc(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  let count = 0;

  for (const r of results) {
    const page = pages[r.page];
    if (!page) continue;
    const g = pageGeometry(page);
    const th = (g.rotation * Math.PI) / 180;
    const [c, s] = [Math.cos(th), Math.sin(th)];
    const key = page.node.newFontDictionary(font.name, font.ref); // registers the font in the page resources
    const ops = [pushGraphicsState()];
    ops.push(PDFOperator.of('Tr' as never, [PDFNumber.of(3)]));

    for (const w of r.words) {
      const text = encodable(font, w.text.trim());
      if (!text || w.confidence < MIN_CONFIDENCE) continue;
      const boxW = (w.x1 - w.x0) / r.scale;
      const boxH = (w.y1 - w.y0) / r.scale;
      if (boxW <= 0.5 || boxH <= 0.5) continue;
      const size = Math.max(1, boxH * 0.9);
      const natural = font.widthOfTextAtSize(text, size) || 1;
      const hScale = Math.max(5, Math.min(400, (boxW / natural) * 100));
      // baseline sits ~20% above the bottom of the word box
      const base = toUser(g, { x: w.x0 / r.scale, y: w.y1 / r.scale - boxH * 0.2 });
      ops.push(
        beginText(),
        setFontAndSize(key, size),
        PDFOperator.of('Tz' as never, [PDFNumber.of(hScale)]),
        setTextMatrix(c, s, -s, c, base.x, base.y),
        showText(font.encodeText(text)),
        endText(),
      );
      count++;
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  }
  return { bytes: await doc.save(), words: count };
}
