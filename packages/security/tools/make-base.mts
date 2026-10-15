import { PDFDocument, StandardFonts } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.setTitle('Confidential Title');
for (let i = 1; i <= 2; i++) doc.addPage([300, 200]).drawText(`Secret page ${i} code ZX${i}9`, { x: 20, y: 100, size: 16, font });
await writeFile(process.argv[2]!, await doc.save());
