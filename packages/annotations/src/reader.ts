import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFContext } from 'pdf-lib';
import { fromUser, rectFromUser, type PageGeometry } from './geometry';
import type { Annotation, Point, Rect, ReviewStatus } from './model';
import { colorArrayToHex, parsePdfDate } from './pdfutil';
import { getArray, getNumber, getNumbers, getRef, getText, loadDoc, pageGeometry, refId, scanManaged } from './pdfio';

export interface ReadResult {
  annotations: Annotation[];
  geometry: PageGeometry[];
}

const STATUS_BY_STATE: Record<string, ReviewStatus> = {
  Accepted: 'accepted',
  Rejected: 'rejected',
  Completed: 'completed',
  Cancelled: 'cancelled',
  None: 'none',
};

const HEX = /^#[0-9a-f]{6}$/i;

/** Parse the managed annotation subtypes of a PDF into the display-space model. Unsupported ones are ignored. */
export async function readAnnotations(bytes: Uint8Array): Promise<ReadResult> {
  const doc = await loadDoc(bytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const geometry = pages.map(pageGeometry);
  const entries = scanManaged(doc);

  const idOf = new Map<string, string>(); // ref string -> model id
  for (const e of entries) idOf.set(refId(e.ref), getText(ctx, e.dict, 'NM') || refId(e.ref));

  const annotations: Annotation[] = [];
  const statusOf = new Map<string, ReviewStatus>();

  for (const e of entries) {
    try {
      const g = geometry[e.pageIndex]!;
      const d = e.dict;
      const id = idOf.get(refId(e.ref))!;
      const irt = getRef(d, 'IRT');
      const base = {
        id,
        page: e.pageIndex,
        author: getText(ctx, d, 'T') ?? '',
        createdAt: parsePdfDate(getText(ctx, d, 'CreationDate')) ?? parsePdfDate(getText(ctx, d, 'M')) ?? new Date(0).toISOString(),
        modifiedAt: parsePdfDate(getText(ctx, d, 'M')) ?? new Date(0).toISOString(),
        contents: getText(ctx, d, 'Contents') ?? '',
        color: colorArrayToHex(getNumbers(ctx, d, 'C')) ?? '#ffeb3b',
        opacity: getNumber(ctx, d, 'CA') ?? 1,
        status: 'none' as ReviewStatus,
      };

      if (e.subtype === 'Text' && irt) {
        const parentId = idOf.get(refId(irt));
        if (!parentId) continue;
        const state = getText(ctx, d, 'State');
        if (getText(ctx, d, 'StateModel') && state) {
          statusOf.set(parentId, STATUS_BY_STATE[state] ?? 'none');
        } else {
          annotations.push({ ...base, type: 'reply', parentId });
        }
        continue;
      }

      const box = getNumbers(ctx, d, 'Rect');
      const rect: Rect | undefined =
        box && box.length === 4 ? rectFromUser(g, [Math.min(box[0]!, box[2]!), Math.min(box[1]!, box[3]!), Math.max(box[0]!, box[2]!), Math.max(box[1]!, box[3]!)]) : undefined;
      const borderWidth = borderWidthOf(ctx, d);

      switch (e.subtype) {
        case 'Redact':
        case 'Highlight':
        case 'Underline':
        case 'StrikeOut':
        case 'Squiggly': {
          const qp = getNumbers(ctx, d, 'QuadPoints');
          const quads: Rect[] = [];
          if (qp) {
            for (let i = 0; i + 7 < qp.length; i += 8) {
              const pts = [0, 2, 4, 6].map((k) => fromUser(g, { x: qp[i + k]!, y: qp[i + k + 1]! }));
              const xs = pts.map((p) => p.x);
              const ys = pts.map((p) => p.y);
              quads.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
            }
          } else if (rect) quads.push(rect);
          if (e.subtype === 'Redact') {
            annotations.push({ ...base, type: 'redact', quads, overlayColor: colorArrayToHex(getNumbers(ctx, d, 'IC')) ?? '#000000' });
            break;
          }
          const type = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' }[e.subtype as 'Highlight'] as 'highlight';
          annotations.push({ ...base, type, quads });
          break;
        }
        case 'Text':
          if (rect) annotations.push({ ...base, type: 'note', x: rect.x, y: rect.y });
          break;
        case 'FreeText': {
          if (!rect) break;
          const da = getText(ctx, d, 'DA') ?? '';
          const size = /([\d.]+)\s+Tf/.exec(da);
          const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
          const gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
          const textColor = rgb
            ? colorArrayToHex([+rgb[1]!, +rgb[2]!, +rgb[3]!])
            : gray
              ? colorArrayToHex([+gray[1]!])
              : '#000000';
          const fill = colorArrayToHex(getNumbers(ctx, d, 'C'));
          annotations.push({
            ...base,
            type: 'freetext',
            color: textColor ?? '#000000',
            rect,
            fontSize: size ? +size[1]! : 12,
            fill: fill && HEX.test(fill) ? fill : null,
            borderWidth,
          });
          break;
        }
        case 'Ink': {
          const list = getArray(ctx, d, 'InkList');
          const strokes: Point[][] = [];
          if (list) {
            for (let i = 0; i < list.size(); i++) {
              const arr = ctx.lookup(list.get(i));
              if (!(arr instanceof PDFArray)) continue;
              const nums: number[] = [];
              for (let k = 0; k < arr.size(); k++) {
                const n = ctx.lookup(arr.get(k));
                if (n instanceof PDFNumber) nums.push(n.asNumber());
              }
              const pts: Point[] = [];
              for (let k = 0; k + 1 < nums.length; k += 2) pts.push(fromUser(g, { x: nums[k]!, y: nums[k + 1]! }));
              if (pts.length) strokes.push(pts);
            }
          }
          annotations.push({ ...base, type: 'ink', strokes, width: borderWidth || 1 });
          break;
        }
        case 'Square':
        case 'Circle': {
          if (!rect) break;
          const fill = colorArrayToHex(getNumbers(ctx, d, 'IC'));
          annotations.push({ ...base, type: e.subtype === 'Square' ? 'square' : 'circle', rect, width: borderWidth || 1, fill });
          break;
        }
        case 'Line': {
          const l = getNumbers(ctx, d, 'L');
          if (!l || l.length < 4) break;
          const le = getArray(ctx, d, 'LE');
          const styleAt = (i: number) => {
            const n = le ? ctx.lookup(le.get(i)) : undefined;
            const name = n instanceof PDFName ? n.decodeText() : 'None';
            return name === 'None' ? ('none' as const) : ('arrow' as const);
          };
          annotations.push({
            ...base,
            type: 'line',
            p1: fromUser(g, { x: l[0]!, y: l[1]! }),
            p2: fromUser(g, { x: l[2]!, y: l[3]! }),
            width: borderWidth || 1,
            startStyle: styleAt(0),
            endStyle: styleAt(1),
          });
          break;
        }
      }
    } catch (err) {
      console.warn('Skipping unreadable annotation', err);
    }
  }

  for (const a of annotations) {
    const s = statusOf.get(a.id);
    if (s && a.type !== 'reply') a.status = s;
  }
  return { annotations, geometry };
}

function borderWidthOf(ctx: PDFContext, d: PDFDict): number {
  const bs = ctx.lookup(d.get(PDFName.of('BS')));
  if (bs instanceof PDFDict) {
    const w = getNumber(ctx, bs, 'W');
    if (w !== undefined) return w;
  }
  const border = getNumbers(ctx, d, 'Border');
  if (border && border.length >= 3) return border[2]!;
  return 0;
}
