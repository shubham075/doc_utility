import { PDFName } from 'pdf-lib';
import { displaySize, loadDoc, pageGeometry, rectToUser, type Rect } from '@pdfsuite/annotations';

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const MIN_SIZE = 12;

/**
 * Crop pages by trimming margins (points, in the page as displayed, i.e. after rotation).
 * Sets the CropBox only; the MediaBox and page content are untouched, so cropping is reversible with `resetCrop`.
 * Annotations are stored in user space and therefore stay where they are on the page content.
 */
export async function cropPages(bytes: Uint8Array, pages: readonly number[], margins: Margins): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const all = doc.getPages();
  for (const i of pages) {
    const page = all[i];
    if (!page) continue;
    const g = pageGeometry(page);
    const d = displaySize(g);
    const keep: Rect = {
      x: Math.max(0, margins.left),
      y: Math.max(0, margins.top),
      width: d.width - Math.max(0, margins.left) - Math.max(0, margins.right),
      height: d.height - Math.max(0, margins.top) - Math.max(0, margins.bottom),
    };
    if (keep.width < MIN_SIZE || keep.height < MIN_SIZE) throw new Error(`Page ${i + 1} would be cropped to nothing`);
    const [x1, y1, x2, y2] = rectToUser(g, keep);
    page.setCropBox(x1, y1, x2 - x1, y2 - y1);
  }
  return doc.save();
}

/** Remove the CropBox so the MediaBox is visible again. */
export async function resetCrop(bytes: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
  const doc = await loadDoc(bytes);
  const all = doc.getPages();
  for (const i of pages) all[i]?.node.delete(PDFName.of('CropBox'));
  return doc.save();
}

/**
 * Margins that remove blank (near-white) borders, from an RGBA bitmap of the page rendered at `scale`
 * (pixels per point). Returns points; `padding` points are kept around the content.
 */
export function detectMargins(rgba: Uint8ClampedArray, width: number, height: number, scale: number, padding = 6, threshold = 245): Margins {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (rgba[i + 3]! > 8 && (rgba[i]! < threshold || rgba[i + 1]! < threshold || rgba[i + 2]! < threshold)) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return { top: 0, right: 0, bottom: 0, left: 0 }; // blank page: nothing to detect
  const pt = (px: number) => Math.max(0, px / scale - padding);
  return { top: pt(top), left: pt(left), bottom: pt(height - 1 - bottom), right: pt(width - 1 - right) };
}
