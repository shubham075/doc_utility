/** A "scanned" page (text rasterised into an image, no text layer) for testing OCR. */
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';

const c = createCanvas(1700, 2200);
const x = c.getContext('2d');
x.fillStyle = '#fff';
x.fillRect(0, 0, 1700, 2200);
x.fillStyle = '#111';
x.font = 'bold 96px Arial';
x.fillText('Invoice 2026-0042', 200, 300);
x.font = '60px Arial';
['Customer: Ada Lovelace', 'Total due: 4500 dollars', 'Payment terms: net thirty days'].forEach((l, i) => x.fillText(l, 200, 520 + i * 130));
const doc = await PDFDocument.create();
doc.addPage([612, 792]).drawImage(await doc.embedPng(new Uint8Array(c.toBuffer('image/png'))), { x: 0, y: 0, width: 612, height: 792 });
const bytes = await doc.save();
await mkdir(new URL('../../../corpus/', import.meta.url), { recursive: true });
await writeFile(new URL('../../../corpus/scan-sample.pdf', import.meta.url), bytes);
await writeFile(new URL('../../../apps/web/public/scan.pdf', import.meta.url), bytes);
console.log('wrote scan-sample.pdf', bytes.length);
