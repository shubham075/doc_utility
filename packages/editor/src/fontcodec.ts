import { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib';
import type { FontInfo, FontLoader } from '@pdfsuite/security/fonts';
import { N, decodeStream } from './util';

/** Maps between character codes of a PDF font and Unicode, and says which characters the font can still show. */
export interface FontCodec {
  info: FontInfo;
  baseFont: string;
  bytesPerCode: 1 | 2;
  bold: boolean;
  italic: boolean;
  /** Decoded text of a character code; undefined when the font gives no usable mapping. */
  decode(code: number): string | undefined;
  /** A code that displays `ch` with this font, or undefined when the font cannot show it. */
  encode(ch: string): number | undefined;
}

// ------------------------------------------------------------------ ToUnicode

const utf16 = (hex: string) => {
  let s = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return s;
};

export function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(m[1]!, 16), utf16(m[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16);
      const hi = Math.min(parseInt(m[2]!, 16), lo + 65535);
      const dst = m[3]!;
      if (dst.startsWith('[')) {
        let k = lo;
        for (const d of dst.matchAll(/<([0-9A-Fa-f]*)>/g)) map.set(k++, utf16(d[1]!));
      } else {
        const base = utf16(dst.slice(1, -1));
        if (!base) continue;
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      }
    }
  }
  return map;
}

// ------------------------------------------------------------------ glyph names

const NAMES: Record<string, number> = {
  space: 32, exclam: 33, quotedbl: 34, numbersign: 35, dollar: 36, percent: 37, ampersand: 38, quotesingle: 39, parenleft: 40, parenright: 41, asterisk: 42, plus: 43, comma: 44, hyphen: 45, minus: 0x2212, period: 46, slash: 47,
  zero: 48, one: 49, two: 50, three: 51, four: 52, five: 53, six: 54, seven: 55, eight: 56, nine: 57, colon: 58, semicolon: 59, less: 60, equal: 61, greater: 62, question: 63, at: 64, bracketleft: 91, backslash: 92, bracketright: 93,
  asciicircum: 94, underscore: 95, grave: 96, braceleft: 123, bar: 124, braceright: 125, asciitilde: 126, bullet: 0x2022, endash: 0x2013, emdash: 0x2014, quoteleft: 0x2018, quoteright: 0x2019, quotesinglbase: 0x201a, quotedblleft: 0x201c,
  quotedblright: 0x201d, quotedblbase: 0x201e, Euro: 0x20ac, ellipsis: 0x2026, fi: 0xfb01, fl: 0xfb02, dagger: 0x2020, daggerdbl: 0x2021, trademark: 0x2122, copyright: 0xa9, registered: 0xae, degree: 0xb0, section: 0xa7, paragraph: 0xb6,
  germandbls: 0xdf, ae: 0xe6, AE: 0xc6, oe: 0x153, OE: 0x152, oslash: 0xf8, Oslash: 0xd8, ccedilla: 0xe7, Ccedilla: 0xc7, nbspace: 0xa0, guillemotleft: 0xab, guillemotright: 0xbb, exclamdown: 0xa1, questiondown: 0xbf, sterling: 0xa3, yen: 0xa5, cent: 0xa2,
};
const ACCENTS: Record<string, string> = { grave: '̀', acute: '́', circumflex: '̂', tilde: '̃', macron: '̄', breve: '̆', dotaccent: '̇', dieresis: '̈', ring: '̊', hungarumlaut: '̋', caron: '̌', cedilla: '̧', ogonek: '̨' };

export function glyphToUnicode(name: string): string | undefined {
  if (name.length === 1) return name;
  const base = name.split('.')[0]!;
  if (NAMES[base] !== undefined) return String.fromCodePoint(NAMES[base]!);
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(base);
  if (m) return String.fromCharCode(parseInt(m[1]!, 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1]!, 16));
  m = /^([A-Za-z])([a-z]+)$/.exec(base);
  if (m && ACCENTS[m[2]!]) return (m[1]! + ACCENTS[m[2]!]!).normalize('NFC');
  return undefined;
}

// ------------------------------------------------------------------ codec

const one = (d: TextDecoder, b: number) => {
  const s = d.decode(Uint8Array.of(b));
  return s.length ? s : undefined;
};
const WIN = new TextDecoder('windows-1252');
const MAC = new TextDecoder('macintosh');

const nameOf = (ctx: PDFContext, v: PDFObject | undefined) => {
  const o = ctx.lookup(v);
  return o instanceof PDFName ? o.decodeText() : undefined;
};
const num = (ctx: PDFContext, v: PDFObject | undefined, d = 0) => {
  const o = ctx.lookup(v);
  return o instanceof PDFNumber ? o.asNumber() : d;
};

export async function loadCodec(ctx: PDFContext, font: PDFDict, loader: FontLoader, used: ReadonlySet<number>): Promise<FontCodec> {
  const info = await loader.load(font);
  const subtype = nameOf(ctx, font.get(N('Subtype')));
  const baseFont = nameOf(ctx, font.get(N('BaseFont'))) ?? '';
  const type0 = subtype === 'Type0';
  const desc = type0 ? ctx.lookup((ctx.lookup(font.get(N('DescendantFonts'))) as PDFArray | undefined)?.get(0)) : font;
  const fd = desc instanceof PDFDict ? ctx.lookup(desc.get(N('FontDescriptor'))) : undefined;
  const flags = fd instanceof PDFDict ? num(ctx, fd.get(N('Flags'))) : 0;
    const subset = /^[A-Z]{6}\+/.test(baseFont);
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  const clean = baseFont.replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(clean) || (flags & 0x40000) !== 0;
  const italic = /italic|oblique/i.test(clean) || (flags & 64) !== 0 || (fd instanceof PDFDict && num(ctx, fd.get(N('ItalicAngle'))) !== 0);

  let toUni = new Map<number, string>();
  const tu = ctx.lookup(font.get(N('ToUnicode')));
  if (tu instanceof PDFStream) {
    try {
      toUni = parseToUnicode(new TextDecoder('latin1').decode(decodeStream(tu)));
    } catch {
      /* unreadable CMap: treated as absent */
    }
  }

  const decodeMap = new Map<number, string>();
  const available = new Set<number>();

  if (type0) {
    for (const [c, s] of toUni) decodeMap.set(c, s);
    for (const c of toUni.keys()) available.add(c);
    for (const c of used) available.add(c);
  } else {
    // simple font: base encoding + Differences, overridden by ToUnicode
    const enc = ctx.lookup(font.get(N('Encoding')));
    let base: 'win' | 'mac' | 'none' = symbolic ? 'none' : 'win';
    const diff = new Map<number, string>();
    const baseName = enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFDict ? nameOf(ctx, enc.get(N('BaseEncoding'))) : undefined;
    if (baseName === 'MacRomanEncoding') base = 'mac';
    else if (baseName === 'WinAnsiEncoding' || baseName === 'StandardEncoding' || baseName === 'MacExpertEncoding') base = baseName === 'MacExpertEncoding' ? 'none' : 'win';
    if (enc instanceof PDFDict) {
      const d = ctx.lookup(enc.get(N('Differences')));
      if (d instanceof PDFArray) {
        let code = 0;
        for (let i = 0; i < d.size(); i++) {
          const e = ctx.lookup(d.get(i));
          if (e instanceof PDFNumber) code = e.asNumber();
          else if (e instanceof PDFName) {
            const u = glyphToUnicode(e.decodeText());
            if (u) diff.set(code, u);
            code++;
          }
        }
      }
    }
    const restricted = subset || symbolic;
    for (let c = 0; c < 256; c++) {
      const u = toUni.get(c) ?? diff.get(c) ?? (base === 'win' ? one(WIN, c) : base === 'mac' ? one(MAC, c) : undefined);
      if (u && !(c < 32 && !toUni.has(c))) decodeMap.set(c, u);
      const w = info.width(c);
      const exists = w > 0 || c === 32;
      if (!exists) continue;
      if (restricted) {
        if (used.has(c) || (subset && toUni.has(c))) available.add(c);
      } else available.add(c);
    }
  }

  const reverse = new Map<string, number>();
  for (const c of [...available].sort((a, b) => a - b)) {
    const u = decodeMap.get(c);
    if (u && !reverse.has(u)) reverse.set(u, c);
  }

  return {
    info,
    baseFont: clean,
    bytesPerCode: type0 ? 2 : 1,
    bold,
    italic,
    decode: (code) => decodeMap.get(code),
    encode: (ch) => reverse.get(ch),
  };
}
