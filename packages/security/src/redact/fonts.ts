import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, StandardFonts, type PDFContext, type PDFFont, type PDFObject } from 'pdf-lib';

export interface FontInfo {
  bytesPerCode: 1 | 2;
  /** Advance of a character code in 1/1000 text-space units. */
  width(code: number): number;
  /** Glyph box extent above/below the baseline as fractions of the font size. */
  ascent: number;
  descent: number;
}

const STANDARD: [RegExp, StandardFonts][] = [
  [/^(helvetica|arial)[-,]?bold[-,]?(oblique|italic)/i, StandardFonts.HelveticaBoldOblique],
  [/^(helvetica|arial)[-,]?bold/i, StandardFonts.HelveticaBold],
  [/^(helvetica|arial)[-,]?(oblique|italic)/i, StandardFonts.HelveticaOblique],
  [/^(helvetica|arial)/i, StandardFonts.Helvetica],
  [/^(times|timesnewroman)[-,]?bold[-,]?italic/i, StandardFonts.TimesRomanBoldItalic],
  [/^(times|timesnewroman)[-,]?bold/i, StandardFonts.TimesRomanBold],
  [/^(times|timesnewroman)[-,]?italic/i, StandardFonts.TimesRomanItalic],
  [/^(times|timesnewroman)/i, StandardFonts.TimesRoman],
  [/^(courier|couriernew)[-,]?bold[-,]?(oblique|italic)/i, StandardFonts.CourierBoldOblique],
  [/^(courier|couriernew)[-,]?bold/i, StandardFonts.CourierBold],
  [/^(courier|couriernew)[-,]?(oblique|italic)/i, StandardFonts.CourierOblique],
  [/^(courier|couriernew)/i, StandardFonts.Courier],
];

const nameOf = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFName ? o.decodeText() : undefined;
};
const numberOf = (ctx: PDFContext, v: PDFObject | undefined, d: number) => {
  const o = ctx.lookup(v);
  return o instanceof PDFNumber ? o.asNumber() : d;
};
const arrayOf = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFArray ? o : undefined;
};
const dictOf = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFDict ? o : o instanceof PDFStream ? o.dict : undefined;
};

/** Reads glyph metrics from PDF font dictionaries; standard fonts without /Widths use the built-in AFM data. */
export class FontLoader {
  private scratch: PDFDocument | null = null;
  private standard = new Map<StandardFonts, PDFFont>();
  private cache = new Map<PDFDict, FontInfo>();

  constructor(private readonly ctx: PDFContext) {}

  private async standardFont(name: string): Promise<PDFFont | null> {
    const hit = STANDARD.find(([re]) => re.test(name.replace(/^[A-Z]{6}\+/, '')));
    if (!hit) return null;
    this.scratch ??= await PDFDocument.create();
    let f = this.standard.get(hit[1]);
    if (!f) {
      f = await this.scratch.embedFont(hit[1]);
      this.standard.set(hit[1], f);
    }
    return f;
  }

  async load(font: PDFDict): Promise<FontInfo> {
    const cached = this.cache.get(font);
    if (cached) return cached;
    const ctx = this.ctx;
    const subtype = nameOf(ctx, font.get(PDFName.of('Subtype')));
    const baseFont = nameOf(ctx, font.get(PDFName.of('BaseFont'))) ?? '';
    let info: FontInfo;

    if (subtype === 'Type0') {
      const desc = dictOf(ctx, arrayOf(ctx, font.get(PDFName.of('DescendantFonts')))?.get(0));
      const dw = desc ? numberOf(ctx, desc.get(PDFName.of('DW')), 1000) : 1000;
      const widths = new Map<number, number>();
      const w = desc && arrayOf(ctx, desc.get(PDFName.of('W')));
      if (w) {
        for (let i = 0; i < w.size(); ) {
          const first = numberOf(ctx, w.get(i), 0);
          const second = ctx.lookup(w.get(i + 1));
          if (second instanceof PDFArray) {
            for (let k = 0; k < second.size(); k++) widths.set(first + k, numberOf(ctx, second.get(k), dw));
            i += 2;
          } else {
            const last = numberOf(ctx, second, first);
            const width = numberOf(ctx, w.get(i + 2), dw);
            for (let c = first; c <= last && c - first < 70000; c++) widths.set(c, width);
            i += 3;
          }
        }
      }
      const fd = desc && dictOf(ctx, desc.get(PDFName.of('FontDescriptor')));
      info = { bytesPerCode: 2, width: (c) => widths.get(c) ?? dw, ascent: fd ? numberOf(ctx, fd.get(PDFName.of('Ascent')), 880) / 1000 : 0.88, descent: fd ? Math.abs(numberOf(ctx, fd.get(PDFName.of('Descent')), -120)) / -1000 : -0.12 };
    } else {
      const first = numberOf(ctx, font.get(PDFName.of('FirstChar')), 0);
      const w = arrayOf(ctx, font.get(PDFName.of('Widths')));
      const fd = dictOf(ctx, font.get(PDFName.of('FontDescriptor')));
      const missing = fd ? numberOf(ctx, fd.get(PDFName.of('MissingWidth')), 0) : 0;
      const ascent = fd ? numberOf(ctx, fd.get(PDFName.of('Ascent')), 880) / 1000 : 0.88;
      const descent = fd ? -Math.abs(numberOf(ctx, fd.get(PDFName.of('Descent')), -120)) / 1000 : -0.12;
      const scale = subtype === 'Type3' ? (arrayOf(ctx, font.get(PDFName.of('FontMatrix'))) ? numberOf(ctx, arrayOf(ctx, font.get(PDFName.of('FontMatrix')))!.get(0), 0.001) * 1000 : 1) : 1;
      if (w) {
        info = { bytesPerCode: 1, width: (c) => (c >= first && c - first < w.size() ? numberOf(ctx, w.get(c - first), missing) * scale : missing), ascent, descent };
      } else {
        const std = await this.standardFont(baseFont);
        info = {
          bytesPerCode: 1,
          width: (c) => {
            if (!std) return 500;
            try {
              return std.widthOfTextAtSize(String.fromCharCode(c), 1000);
            } catch {
              return 500;
            }
          },
          ascent,
          descent,
        };
      }
    }
    this.cache.set(font, info);
    return info;
  }
}
