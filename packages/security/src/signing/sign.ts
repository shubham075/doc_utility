import { loadDoc, pageGeometry, rectToUser, type Rect } from '@pdfsuite/annotations';
import { concat, sha } from '../crypto/hash';
import { expandObjectStreams } from '../encryption';
import { asciiOf, bytesOf, isDict, isRef, scanFile, serialize, type PDict, type PObj } from '../syntax/pdfsyntax';
import { buildCms, nameOf, type SigningIdentity } from './cms';

export interface SignOptions {
  identity: SigningIdentity;
  /** Show a signature box on this page (display space). Omit for an invisible signature. */
  visible?: { page: number; rect: Rect };
  fieldName?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  signingTime?: Date;
  /** Bytes reserved for the CMS blob (default 12 000; certificate chains need more). */
  signatureSize?: number;
}

const hexStr = (s: string): string => {
  let h = 'FEFF';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0xffff) {
      const v = c - 0x10000;
      h += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else h += c.toString(16).padStart(4, '0');
  }
  return `<${h.toUpperCase()}>`;
};

const pdfDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

/** Standard-font hex string; characters outside Latin-1 become '?'. */
const winAnsiHex = (s: string) => `<${Array.from(s, (c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63).toString(16).padStart(2, '0')).join('')}>`;

const clone = <T extends PObj>(o: T): T => (o === null || typeof o !== 'object' ? o : Array.isArray(o) ? (o.map(clone) as unknown as T) : ('str' in o ? ({ str: o.str.slice() } as unknown as T) : ('isStream' in o ? ({ ...o, dict: cloneDict(o.dict) } as unknown as T) : 'dict' in o ? ({ dict: cloneDict(o.dict) } as unknown as T) : ({ ...o } as T))));
const cloneDict = (d: Record<string, PObj>) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, clone(v)]));

/** Does the last cross-reference section of the file use a table (vs. an xref stream)? */
function lastStartxref(bytes: Uint8Array): { offset: number; isTable: boolean } {
  const tail = asciiOf(bytes, Math.max(0, bytes.length - 1024));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error('Not a valid PDF: startxref not found');
  const offset = Number(m[1]);
  return { offset, isTable: asciiOf(bytes, offset, offset + 4) === 'xref' };
}

interface NewObject {
  num: number;
  body: Uint8Array;
}

/**
 * Add a digital signature as an incremental update: the original bytes are left untouched (earlier signatures
 * stay valid) and a new revision carrying the signature field, its value and updated page/form dictionaries
 * is appended. Signing uses CAdES-style CMS (SubFilter ETSI.CAdES.detached, SHA-256 with RSA).
 */
export async function signPdf(bytes: Uint8Array, opts: SignOptions): Promise<Uint8Array> {
  const scan = scanFile(bytes);
  if (scan.trailer.Encrypt) throw new Error('Decrypt the document before signing it');
  const rootRef = scan.trailer.Root;
  if (!rootRef || !isRef(rootRef)) throw new Error('Document has no catalog');
  const objects = await expandObjectStreams(scan.objects);
  const get = (ref: PObj | undefined) => (ref && isRef(ref) ? objects.get(ref.ref[0])?.obj : ref);
  const rootDict = get(rootRef);
  if (!rootDict || !isDict(rootDict)) throw new Error('Document catalog is damaged');

  // page + geometry through pdf-lib (inherited MediaBox/Rotate etc.)
  const pageIndex = opts.visible?.page ?? 0;
  const lib = await loadDoc(bytes);
  const libPage = lib.getPage(pageIndex);
  const pageNum = libPage.ref.objectNumber;
  const pageDictOrig = get({ ref: [pageNum, libPage.ref.generationNumber] });
  if (!pageDictOrig || !isDict(pageDictOrig)) throw new Error('Page dictionary not found');
  const g = pageGeometry(libPage);

  const prev = lastStartxref(bytes);
  const maxNum = Math.max(...objects.keys(), typeof scan.trailer.Size === 'number' ? scan.trailer.Size - 1 : 0);
  let next = maxNum + 1;
  const sigNum = next++;
  const fieldNum = next++;
  const apNum = opts.visible ? next++ : 0;

  const now = opts.signingTime ?? new Date();
  const signerName = nameOf(opts.identity.certificate.subject.attributes);
  const size = opts.signatureSize ?? 12000;
  const fieldName = opts.fieldName ?? `Signature${objects.size % 1000}`;

  // ---------------- new objects
  const fresh = new Map<number, Uint8Array>();
  const enc = (o: PObj) => Uint8Array.from(serialize(o));

  // the signature value dictionary is written by hand so that ByteRange/Contents have fixed widths
  const sigText =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0000000000 0000000000 0000000000] ` +
    `/Contents <${'0'.repeat(size * 2)}> /M (${pdfDate(now)}) /Name ${hexStr(signerName)}` +
    (opts.reason ? ` /Reason ${hexStr(opts.reason)}` : '') +
    (opts.location ? ` /Location ${hexStr(opts.location)}` : '') +
    (opts.contactInfo ? ` /ContactInfo ${hexStr(opts.contactInfo)}` : '') +
    ' >>';

  const widget: Record<string, PObj> = {
    Type: { name: 'Annot' },
    Subtype: { name: 'Widget' },
    FT: { name: 'Sig' },
    T: { str: bytesOf(fieldName) },
    V: { ref: [sigNum, 0] },
    P: { ref: [pageNum, libPage.ref.generationNumber] },
    F: 132, // print + locked
    Rect: [0, 0, 0, 0],
  };
  if (opts.visible) {
    const [x1, y1, x2, y2] = rectToUser(g, opts.visible.rect);
    widget.Rect = [x1, y1, x2, y2];
    const w = opts.visible.rect.width;
    const h = opts.visible.rect.height;
    const lines = [`Digitally signed by ${signerName}`, `Date: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`, ...(opts.reason ? [`Reason: ${opts.reason}`] : []), ...(opts.location ? [`Location: ${opts.location}`] : [])];
    const fs = Math.max(6, Math.min(10, (h - 6) / (lines.length * 1.25)));
    const text = lines.map((l, i) => `BT /F1 ${fs.toFixed(2)} Tf 4 ${(h - 4 - fs * (i + 1) * 1.2).toFixed(2)} Td ${winAnsiHex(l)} Tj ET`).join('\n');
    const content = `q 0.95 0.97 1 rg 0 0 ${w} ${h} re f 0.1 0.3 0.7 RG 0.75 w 0.375 0.375 ${w - 0.75} ${h - 0.75} re S Q\n0.05 0.1 0.3 rg\n${text}`;
    const matrix = g.rotation === 90 ? [0, 1, -1, 0, 0, 0] : g.rotation === 180 ? [-1, 0, 0, -1, 0, 0] : g.rotation === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0];
    const ap: PObj = {
      dict: {
        Type: { name: 'XObject' },
        Subtype: { name: 'Form' },
        BBox: [0, 0, w, h],
        Matrix: matrix,
        Resources: { dict: { Font: { dict: { F1: { dict: { Type: { name: 'Font' }, Subtype: { name: 'Type1' }, BaseFont: { name: 'Helvetica' }, Encoding: { name: 'WinAnsiEncoding' } } } } } } },
        Length: content.length,
      },
    };
    const apBytes = concat(enc(ap), bytesOf('\nstream\n'), bytesOf(content), bytesOf('\nendstream'));
    fresh.set(apNum, apBytes);
    widget.AP = { dict: { N: { ref: [apNum, 0] } } };
    widget.MK = { dict: { R: g.rotation } };
  }
  fresh.set(fieldNum, enc({ dict: widget }));

  // ---------------- modified existing objects
  const rewritten = new Map<number, Uint8Array>();
  const fieldRef: PObj = { ref: [fieldNum, 0] };

  /** Append `ref` to an array that is either direct inside `holder[key]` or an indirect object. */
  const pushTo = (holder: Record<string, PObj>, key: string, ownerNum: number, owner: PObj) => {
    const cur = holder[key];
    if (Array.isArray(cur)) {
      cur.push(fieldRef);
      rewritten.set(ownerNum, enc(owner));
    } else if (cur && isRef(cur)) {
      const target = clone(get(cur) ?? null);
      if (Array.isArray(target)) {
        target.push(fieldRef);
        rewritten.set(cur.ref[0], enc(target));
      }
    } else {
      holder[key] = [fieldRef];
      rewritten.set(ownerNum, enc(owner));
    }
  };

  const pageDict = clone(pageDictOrig) as PDict;
  pushTo(pageDict.dict, 'Annots', pageNum, pageDict);

  const catalog = clone(rootDict) as PDict;
  const af = catalog.dict.AcroForm;
  if (!af) {
    catalog.dict.AcroForm = { dict: { Fields: [fieldRef], SigFlags: 3 } };
    rewritten.set(rootRef.ref[0], enc(catalog));
  } else if (isRef(af)) {
    const formObj = clone(get(af) ?? null) as PDict;
    if (!isDict(formObj)) throw new Error('AcroForm is damaged');
    formObj.dict.SigFlags = 3;
    pushTo(formObj.dict, 'Fields', af.ref[0], formObj);
    rewritten.set(af.ref[0], enc(formObj));
  } else if (isDict(af)) {
    af.dict.SigFlags = 3;
    pushTo(af.dict, 'Fields', rootRef.ref[0], catalog);
    rewritten.set(rootRef.ref[0], enc(catalog));
  }

  // ---------------- assemble the appended revision
  const base = bytes[bytes.length - 1] === 10 ? bytes : concat(bytes, Uint8Array.of(10));
  const parts: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let cursor = base.length;
  let byteRangeAt = -1; // offset of the ByteRange placeholder array
  let contentsStart = -1; // offset of the '<' that opens /Contents
  const emit = (num: number, body: Uint8Array, mark?: boolean) => {
    const head = bytesOf(`${num} 0 obj\n`);
    offsets.set(num, cursor);
    if (mark) {
      const text = asciiOf(body);
      byteRangeAt = cursor + head.length + text.indexOf('[0 0000000000');
      contentsStart = cursor + head.length + text.indexOf('/Contents <') + '/Contents '.length;
    }
    const chunk = concat(head, body, bytesOf('\nendobj\n'));
    parts.push(chunk);
    cursor += chunk.length;
  };
  const all = new Map<number, Uint8Array>([...fresh, ...rewritten]);
  all.set(sigNum, bytesOf(sigText));
  for (const [num, body] of [...all].sort((a, b) => a[0] - b[0])) emit(num, body, num === sigNum);

  // cross-reference data for the new objects
  const nums = [...all.keys()].sort((a, b) => a - b);
  const runs: [number, number[]][] = [];
  for (const n of nums) {
    const last = runs[runs.length - 1];
    if (last && last[1][last[1].length - 1] === n - 1) last[1].push(n);
    else runs.push([n, [n]]);
  }
  const trailerBase: Record<string, PObj> = { Root: rootRef };
  if (scan.trailer.Info) trailerBase.Info = scan.trailer.Info;
  if (scan.trailer.ID) trailerBase.ID = scan.trailer.ID;
  const xrefAt = cursor;
  let tail: Uint8Array;
  if (prev.isTable) {
    let x = 'xref\n';
    for (const [start, list] of runs) {
      x += `${start} ${list.length}\n`;
      for (const n of list) x += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
    }
    tail = bytesOf(`${x}trailer\n${asciiOf(Uint8Array.from(serialize({ dict: { ...trailerBase, Size: next, Prev: prev.offset } })))}\nstartxref\n${xrefAt}\n%%EOF\n`);
  } else {
    const xrefNum = next++;
    offsets.set(xrefNum, xrefAt);
    const all2 = [...nums, xrefNum].sort((a, b) => a - b);
    const runs2: [number, number[]][] = [];
    for (const n of all2) {
      const last = runs2[runs2.length - 1];
      if (last && last[1][last[1].length - 1] === n - 1) last[1].push(n);
      else runs2.push([n, [n]]);
    }
    const data: number[] = [];
    for (const [, list] of runs2) for (const n of list) {
      const o = offsets.get(n)!;
      data.push(1, (o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255, 0, 0);
    }
    const dict: Record<string, PObj> = { Type: { name: 'XRef' }, Size: next, W: [1, 4, 2], Index: runs2.flatMap(([s, l]) => [s, l.length]), Length: data.length, Prev: prev.offset, ...trailerBase };
    tail = concat(bytesOf(`${xrefNum} 0 obj\n`), Uint8Array.from(serialize({ dict })), bytesOf('\nstream\n'), Uint8Array.from(data), bytesOf(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  const file = concat(base, ...parts, tail);

  // ---------------- patch ByteRange, hash, sign, insert
  const cStart = contentsStart;
  const cEnd = cStart + 2 + size * 2; // just after '>'
  const br = `[0 ${String(cStart).padStart(10, '0')} ${String(cEnd).padStart(10, '0')} ${String(file.length - cEnd).padStart(10, '0')}]`;
  file.set(bytesOf(br), byteRangeAt);

  const digest = await sha('SHA-256', concat(file.subarray(0, cStart), file.subarray(cEnd)));
  const cms = await buildCms(opts.identity, digest, now);
  if (cms.length > size) throw new Error(`The signature needs ${cms.length} bytes but only ${size} are reserved; increase signatureSize`);
  const hex = Array.from(cms, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().padEnd(size * 2, '0');
  file.set(bytesOf(hex), cStart + 1);
  return file;
}
