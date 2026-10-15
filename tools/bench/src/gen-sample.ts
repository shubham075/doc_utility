import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const pages = Number(process.argv[2] ?? 50);
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= pages; i++) {
  const page = doc.addPage([612, 792]);
  page.drawText(`Sample page ${i} of ${pages}`, { x: 50, y: 740, size: 24, font });
  for (let l = 0; l < 40; l++) {
    page.drawText(`Line ${l}: The quick brown fox jumps over the lazy dog 0123456789`, {
      x: 50, y: 700 - l * 16, size: 11, font,
    });
  }
  page.drawRectangle({ x: 50, y: 40, width: 200, height: 40, color: rgb(0.2, 0.4, 0.8) });
}
await mkdir(new URL('../../../corpus/', import.meta.url), { recursive: true });
const out = new URL(`../../../corpus/synthetic-${pages}p.pdf`, import.meta.url);
await writeFile(out, await doc.save());
console.log('wrote', out.pathname);
