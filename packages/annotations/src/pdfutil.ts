/** Small formatting/parsing helpers shared by the PDF reader and writer. */

export const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** /C-style colour array (gray, rgb or cmyk) -> #rrggbb. */
export function colorArrayToHex(values: number[] | undefined): string | null {
  if (!values || !values.length) return null;
  if (values.length === 1) return rgbToHex([values[0]!, values[0]!, values[0]!]);
  if (values.length === 3) return rgbToHex(values as [number, number, number]);
  if (values.length === 4) {
    const [c, m, y, k] = values as [number, number, number, number];
    return rgbToHex([(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]);
  }
  return null;
}

/** Content-stream colour operator: `r g b rg` (fill) or `RG` (stroke). */
export function colorOp(hex: string, stroke = false): string {
  const [r, g, b] = hexToRgb(hex);
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${stroke ? 'RG' : 'rg'}`;
}

export function toPdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Parse `D:YYYYMMDDHHmmSS+HH'mm'` (all parts after the year optional) to ISO-8601. */
export function parsePdfDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(s.trim());
  if (!m) return undefined;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', tz = 'Z'] = m;
  let offset = 'Z';
  const t = /^([+-])(\d{2})'?(\d{2})/.exec(tz);
  if (t) offset = `${t[1]}${t[2]}:${t[3]}`;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${offset}`);
  return Number.isNaN(dt.getTime()) ? undefined : dt.toISOString();
}
