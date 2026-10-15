import { PDFArray, PDFRef, PDFDocument, degrees, rgb } from 'pdf-lib';
import { displaySize, loadDoc, pageGeometry, toUser } from '@pdfsuite/annotations';
import { embedStyleFont, encodable, hexToRgb01, type TextStyle } from './stampText';

export interface WatermarkSpec {
  pages: readonly number[];
  kind: 'text' | 'image';
  /** Text watermark. */
  text?: string;
  style?: TextStyle;
  /** Image watermark as a PNG/JPEG data URL, scaled to this fraction of the page width. */
  dataUrl?: string;
  imageScale?: number;
  opacity: number;
  /** Counter-clockwise rotation in degrees as seen on the page. */
  rotation: number;
  position: 'center' | 'tile';
  layer: 'over' | 'behind';
}

async function embedImage(doc: PDFDocument, dataUrl: string) {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error('Watermark image must be a PNG or JPEG data URL');
  const bin = atob(m[2]!);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return m[1]!.toLowerCase() === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes);
}

/** Add a text or image watermark, over or behind the page content. */
export async function addWatermark(bytes: Uint8Array, spec: WatermarkSpec): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const pages = doc.getPages();
  const font = spec.kind === 'text' ? await embedStyleFont(doc, spec.style ?? { family: 'Helvetica', size: 72, color: '#000000' }) : undefined;
  const image = spec.kind === 'image' && spec.dataUrl ? await embedImage(doc, spec.dataUrl) : undefined;
  if (spec.kind === 'text' && !spec.text?.trim()) throw new Error('Watermark text is empty');
  if (spec.kind === 'image' && !image) throw new Error('Watermark image is missing');

  const phi = (spec.rotation * Math.PI) / 180;
  const dir = { x: Math.cos(phi), y: -Math.sin(phi) }; // text direction in display space (y grows downward)
  const up = { x: -Math.sin(phi), y: -Math.cos(phi) };

  for (const index of spec.pages) {
    const page = pages[index];
    if (!page) continue;
    const g = pageGeometry(page);
    const d = displaySize(g);
    const before = contentRefs(page);

    // size of one watermark element
    let w: number;
    let h: number;
    let text = '';
    if (font) {
      text = encodable(font, spec.text!);
      const size = spec.style?.size ?? 72;
      w = font.widthOfTextAtSize(text, size);
      h = size;
    } else {
      w = d.width * (spec.imageScale ?? 0.5);
      h = (w * image!.height) / image!.width;
    }

    const centres: { x: number; y: number }[] = [];
    if (spec.position === 'center') centres.push({ x: d.width / 2, y: d.height / 2 });
    else {
      const stepX = w * 1.5 + 40;
      const stepY = h * 3 + 40;
      for (let y = stepY / 2; y < d.height + stepY; y += stepY) for (let x = stepX / 2 - (Math.round(y / stepY) % 2) * (stepX / 4); x < d.width + stepX; x += stepX) centres.push({ x, y });
    }

    for (const c of centres) {
      if (font) {
        const style = spec.style!;
        const o = { x: c.x - dir.x * (w / 2) - up.x * (h * 0.3), y: c.y - dir.y * (w / 2) - up.y * (h * 0.3) };
        const u = toUser(g, o);
        const [r, gr, b] = hexToRgb01(style.color);
        page.drawText(text, { x: u.x, y: u.y, size: style.size, font, color: rgb(r, gr, b), rotate: degrees(g.rotation + spec.rotation), opacity: spec.opacity });
      } else {
        const o = { x: c.x - dir.x * (w / 2) - up.x * (h / 2), y: c.y - dir.y * (w / 2) - up.y * (h / 2) };
        const u = toUser(g, o);
        page.drawImage(image!, { x: u.x, y: u.y, width: w, height: h, rotate: degrees(g.rotation + spec.rotation), opacity: spec.opacity });
      }
    }
    if (spec.layer === 'behind') moveNewContentToFront(page, before);
  }
  return doc.save();
}

const refKey = (r: PDFRef) => `${r.objectNumber}.${r.generationNumber}`;

function contentRefs(page: import('pdf-lib').PDFPage): Set<string> {
  const out = new Set<string>();
  page.node.normalize(); // make /Contents an array so existing streams can be told apart from new ones
  const c = page.node.Contents();
  if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) {
    const r = c.get(i);
    if (r instanceof PDFRef) out.add(refKey(r));
  }
  return out;
}

/**
 * Content streams added after `before` was captured are the watermark's. Move them to the front of the
 * page's /Contents so they paint underneath. Each drawn element is self-contained (q ... Q).
 */
function moveNewContentToFront(page: import('pdf-lib').PDFPage, before: Set<string>) {
  page.node.normalize();
  const c = page.node.Contents();
  if (!(c instanceof PDFArray)) return;
  const fresh: PDFRef[] = [];
  for (let i = c.size() - 1; i >= 0; i--) {
    const r = c.get(i);
    if (r instanceof PDFRef && !before.has(refKey(r))) {
      fresh.unshift(r);
      c.remove(i);
    }
  }
  fresh.forEach((r, i) => c.insert(i, r));
}
