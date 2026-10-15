import { PDFDocument, PDFFont, StandardFonts, degrees, rgb, type PDFPage } from 'pdf-lib';
import { displaySize, loadDoc, pageGeometry, toUser, type PageGeometry } from '@pdfsuite/annotations';

export type FontFamily = 'Helvetica' | 'Times' | 'Courier';
export type Slot = 'left' | 'center' | 'right';

export interface TextStyle {
  family: FontFamily;
  bold?: boolean;
  italic?: boolean;
  /** Font size in points. */
  size: number;
  /** #rrggbb */
  color: string;
}

const FONT_MAP: Record<FontFamily, [string, string, string, string]> = {
  // regular, bold, italic, bold-italic
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

export async function embedStyleFont(doc: PDFDocument, s: Pick<TextStyle, 'family' | 'bold' | 'italic'>): Promise<PDFFont> {
  const idx = (s.bold ? 1 : 0) + (s.italic ? 2 : 0);
  return doc.embedFont(FONT_MAP[s.family][idx] as StandardFonts);
}

export const hexToRgb01 = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

/** Replace characters the standard font cannot encode so drawing never throws. */
export const encodable = (font: PDFFont, text: string): string => {
  const ok = new Set(font.getCharacterSet());
  return Array.from(text, (ch) => (ok.has(ch.codePointAt(0)!) ? ch : '?')).join('');
};

export interface HeaderFooterSpec {
  /** Zero-based pages that receive the text. */
  pages: readonly number[];
  header: Partial<Record<Slot, string>>;
  footer: Partial<Record<Slot, string>>;
  style: TextStyle;
  /** Distance from the page edge to the text, in points. */
  margin: { top: number; bottom: number; side: number };
  /** Number shown for the document's first page by `<<page>>` (default 1). */
  startNumber?: number;
  /** Bates numbering: `<<bates>>` expands to prefix + zero-padded counter + suffix, counting across `pages`. */
  bates?: { prefix: string; suffix: string; start: number; digits: number };
  fileName?: string;
  date?: Date;
}

/** Expand `<<page>> <<pages>> <<date>> <<file>> <<bates>>` for one page. */
export function expandTokens(template: string, ctx: { page: number; pageCount: number; rank: number; spec: HeaderFooterSpec }): string {
  const { spec } = ctx;
  const bates = spec.bates ? spec.bates.prefix + String(spec.bates.start + ctx.rank).padStart(spec.bates.digits, '0') + spec.bates.suffix : '';
  return template
    .replace(/<<page>>/gi, String((spec.startNumber ?? 1) + ctx.page))
    .replace(/<<pages>>/gi, String(ctx.pageCount + (spec.startNumber ?? 1) - 1))
    .replace(/<<date>>/gi, (spec.date ?? new Date()).toLocaleDateString())
    .replace(/<<file>>/gi, spec.fileName ?? '')
    .replace(/<<bates>>/gi, bates);
}

/** Draw text at a display-space baseline origin so it reads upright on rotated pages. */
export function drawUpright(page: PDFPage, g: PageGeometry, text: string, x: number, y: number, font: PDFFont, style: TextStyle, extraRotation = 0, opacity = 1) {
  const u = toUser(g, { x, y });
  const [r, gr, b] = hexToRgb01(style.color);
  page.drawText(text, { x: u.x, y: u.y, size: style.size, font, color: rgb(r, gr, b), rotate: degrees(g.rotation + extraRotation), opacity });
}

/**
 * Add headers, footers, page numbers and Bates numbers as permanent page content.
 * Text is positioned in display space (so it is upright on rotated pages) and aligned left/centre/right.
 */
export async function addHeaderFooter(bytes: Uint8Array, spec: HeaderFooterSpec): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const font = await embedStyleFont(doc, spec.style);
  const pages = doc.getPages();
  const total = pages.length;
  spec.pages.forEach((index, rank) => {
    const page = pages[index];
    if (!page) return;
    const g = pageGeometry(page);
    const d = displaySize(g);
    for (const [zone, slots] of [['header', spec.header], ['footer', spec.footer]] as const) {
      for (const slot of ['left', 'center', 'right'] as const) {
        const template = slots[slot];
        if (!template) continue;
        const text = encodable(font, expandTokens(template, { page: index, pageCount: total, rank, spec }));
        if (!text) continue;
        const w = font.widthOfTextAtSize(text, spec.style.size);
        const x = slot === 'left' ? spec.margin.side : slot === 'center' ? (d.width - w) / 2 : d.width - spec.margin.side - w;
        const y = zone === 'header' ? spec.margin.top + spec.style.size * 0.8 : d.height - spec.margin.bottom;
        drawUpright(page, g, text, x, y, font, spec.style);
      }
    }
  });
  return doc.save();
}
