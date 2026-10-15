/** Saved signature / initials images (PNG data URLs) kept in the user's browser profile. */

export type SignatureKind = 'signature' | 'initials';

export interface SavedSignature {
  dataUrl: string;
  /** width / height */
  aspect: number;
}

const key = (k: SignatureKind) => `pdfsuite.${k}`;

export function loadSignature(kind: SignatureKind): SavedSignature | null {
  try {
    const raw = localStorage.getItem(key(kind));
    if (!raw) return null;
    const v = JSON.parse(raw) as SavedSignature;
    return typeof v.dataUrl === 'string' && v.dataUrl.startsWith('data:image/') && v.aspect > 0 ? v : null;
  } catch {
    return null;
  }
}

export function saveSignature(kind: SignatureKind, sig: SavedSignature | null): void {
  try {
    if (sig) localStorage.setItem(key(kind), JSON.stringify(sig));
    else localStorage.removeItem(key(kind));
  } catch {
    /* storage unavailable or full: the signature simply is not remembered */
  }
}

/** Crop transparent margins off a canvas and return a PNG data URL with 4px padding. */
export function trimToPng(canvas: HTMLCanvasElement): SavedSignature | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // nothing drawn
  const pad = 4;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d')!.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL('image/png'), aspect: w / h };
}

/** Make near-white pixels transparent (for scanned signatures on paper). */
export function whiteToTransparent(canvas: HTMLCanvasElement, threshold = 235): void {
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i]! > threshold && d[i + 1]! > threshold && d[i + 2]! > threshold) d[i + 3] = 0;
  }
  ctx.putImageData(img, 0, 0);
}
