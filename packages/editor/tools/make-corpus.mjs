// Builds the text-editing test corpus: PDFs produced by Edge (Chrome PDF writer: subset TrueType fonts as Type0/Identity-H,
// Type3 fallbacks) and by pdf-lib (standard fonts, embedded fonts, rotated and offset pages).
//   node tools/make-corpus.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'fixtures', 'corpus');
mkdirSync(out, { recursive: true });

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const tmp = mkdtempSync(join(tmpdir(), 'corpus-'));

const lorem = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!';
const css = (extra = '') => `<style>@page{margin:24mm} body{margin:0;font-size:12pt;line-height:1.4} ${extra}</style>`;
const html = {
  'arial-paragraphs': `${css('body{font-family:Arial}')}<h1>Quarterly report</h1><p>${lorem}</p><p>${lorem} ${lorem}</p>`,
  'times-serif': `${css('body{font-family:"Times New Roman"}')}<h2>Serif document</h2><p>${lorem}</p><p><b>Bold text here</b> and <i>italic text there</i> and <b><i>both</i></b>.</p>`,
  'courier-mono': `${css('body{font-family:"Courier New"}')}<pre>function hello(name) {\n  return "Hello, " + name;\n}\nconst total = 1234.56;</pre><p>${lorem}</p>`,
  'georgia-verdana': `${css('body{font-family:Georgia} h3{font-family:Verdana}')}<h3>Mixed families</h3><p>${lorem}</p><p style="font-family:Verdana">${lorem}</p>`,
  'accents-calibri': `${css('body{font-family:Calibri,"Segoe UI"}')}<p>Café naïve résumé coöperate Ångström über señor çedilla.</p><p>${lorem}</p>`,
  'table-borders': `${css('body{font-family:Arial} td,th{border:1px solid #444;padding:4px 8px}')}<table style="border-collapse:collapse"><tr><th>Item</th><th>Qty</th><th>Price</th></tr><tr><td>Widget</td><td>12</td><td>3.50</td></tr><tr><td>Gadget</td><td>7</td><td>12.00</td></tr></table><p>${lorem}</p>`,
  'colors-boxes': `${css('body{font-family:Arial}')}<div style="background:#fde;padding:8px;color:#a00">Red text on pink box</div><p style="color:#06c">Blue paragraph. ${lorem}</p><div style="background:#222;color:#fff;padding:8px">White on black</div>`,
  'rotated-text': `${css('body{font-family:Arial}')}<p>Normal line of text</p><div style="transform:rotate(-12deg);margin:60px 40px;font-size:18pt">Rotated heading</div><p>${lorem}</p>`,
  'columns': `${css('body{font-family:"Times New Roman"} .c{column-count:2;column-gap:24px}')}<h2>Two columns</h2><div class="c"><p>${lorem} ${lorem}</p><p>${lorem}</p></div>`,
  'inline-image': `${css('body{font-family:Arial}')}<p>Text before the picture</p><svg width="200" height="80"><rect width="200" height="80" fill="#4a90d9"/><circle cx="100" cy="40" r="25" fill="#fff"/></svg><p>Text after the picture. ${lorem}</p>`,
  'landscape': `<style>@page{size:A4 landscape;margin:20mm} body{font-family:Arial;font-size:14pt}</style><h1>Landscape page</h1><p>${lorem} ${lorem}</p>`,
  'cjk-arabic': `${css('body{font-family:Arial}')}<p>English line that is editable.</p><p>日本語のテキストです。</p><p dir="rtl">نص عربي للاختبار</p>`,
  'spacing-case': `${css('body{font-family:Arial}')}<p style="letter-spacing:2px">Letter spaced words here</p><p style="word-spacing:12px">Word spaced words here too</p><p style="text-transform:uppercase">Uppercase via css</p><p style="text-align:justify;width:300px">${lorem} ${lorem}</p>`,
  'lists-super': `${css('body{font-family:Arial}')}<ul><li>First item</li><li>Second item</li></ul><ol><li>One</li><li>Two</li></ol><p>E = mc<sup>2</sup> and H<sub>2</sub>O</p>`,
  'segoe-large': `${css('body{font-family:"Segoe UI"}')}<h1 style="font-size:40pt">Big Heading</h1><p style="font-size:9pt">Small print: ${lorem}</p>`,
};

if (!edge) console.warn('No Edge/Chrome found: only pdf-lib documents are generated.');
for (const [name, body] of edge ? Object.entries(html) : []) {
  const file = join(tmp, name + '.html');
  writeFileSync(file, `<!doctype html><meta charset="utf-8">${body}`);
  const target = join(out, `edge-${name}.pdf`);
  const r = spawnSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${target}`, pathToFileURL(file).href], { encoding: 'utf8', timeout: 60000 });
  console.log(name, r.status === 0 && existsSync(target) ? 'ok' : 'FAILED ' + r.stderr?.slice(0, 200));
}

// ---- pdf-lib documents
const text = (page, font, size, lines, x = 50, y0 = 740) => lines.forEach((l, i) => page.drawText(l, { x, y: y0 - i * size * 1.5, size, font, color: rgb(0.1, 0.1, 0.1) }));
const lines = ['Standard font document line one', 'Accented: café résumé naïve señor', 'Numbers 0123456789 and symbols & % ( ) / -', lorem.slice(0, 60)];
for (const [name, fam] of [['helvetica', StandardFonts.Helvetica], ['times', StandardFonts.TimesRoman], ['courier', StandardFonts.Courier], ['helvetica-bold', StandardFonts.HelveticaBold], ['times-italic', StandardFonts.TimesRomanItalic]]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  text(page, await doc.embedFont(fam), 14, lines);
  writeFileSync(join(out, `lib-std-${name}.pdf`), await doc.save());
}
for (const deg of [90, 180, 270]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  text(page, await doc.embedFont(StandardFonts.Helvetica), 16, lines);
  page.setRotation(degrees(deg));
  writeFileSync(join(out, `lib-rotated-${deg}.pdf`), await doc.save());
}
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setCropBox(40, 60, 500, 650);
  text(page, await doc.embedFont(StandardFonts.Helvetica), 14, lines, 70, 700);
  writeFileSync(join(out, 'lib-cropbox-offset.pdf'), await doc.save());
}
{
  // fully embedded (not subset) and subset TrueType fonts
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const ttf = readFileSync(join(root, 'standard_fonts', 'LiberationSans-Regular.ttf'));
  for (const subset of [true, false]) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const page = doc.addPage([612, 792]);
    text(page, await doc.embedFont(ttf, { subset }), 14, lines);
    writeFileSync(join(out, `lib-liberation-${subset ? 'subset' : 'full'}.pdf`), await doc.save());
  }
}
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const f = await doc.embedFont(StandardFonts.Helvetica);
  text(page, f, 14, ['Line with text-state operators'], 50, 740);
  page.pushOperators(); // no-op; keeps pdf-lib's content structure
  writeFileSync(join(out, 'lib-simple.pdf'), await doc.save());
}
console.log('done');
