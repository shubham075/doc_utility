import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';

/** Build a multipart/form-data body for fastify.inject. */
export function multipart(file: { name: string; data: Uint8Array; type?: string } | null, fields: Record<string, string> = {}) {
  const boundary = '----pdfsuite' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`), Buffer.from(file.data), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export function noisyJpeg(w: number, h: number): Uint8Array {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  let s = 99;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = s & 255;
    img.data[i + 1] = (s >> 8) & 255;
    img.data[i + 2] = (s >> 16) & 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Uint8Array(c.toBuffer('image/jpeg', 98));
}

export async function bigImagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(noisyJpeg(1800, 1200));
  doc.addPage([600, 400]).drawImage(img, { x: 0, y: 0, width: 600, height: 400 });
  return doc.save();
}

export async function scannedPdf(text: string): Promise<Uint8Array> {
  const c = createCanvas(1200, 400);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 1200, 400);
  x.fillStyle = '#000';
  x.font = '80px Arial';
  x.fillText(text, 60, 220);
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(new Uint8Array(c.toBuffer('image/png')));
  doc.addPage([600, 200]).drawImage(img, { x: 0, y: 0, width: 600, height: 200 });
  return doc.save();
}
