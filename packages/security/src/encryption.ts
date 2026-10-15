import { aesDecryptPdf, aesEncryptPdf, cbcDecryptNoPad, cbcEncryptNoPad, randomBytes } from './crypto/aes';
import { concat, md5, rc4, sha, toHex, utf8 } from './crypto/hash';
import {
  asciiOf,
  dictOf,
  isDict,
  isName,
  isRef,
  isStr,
  isStream,
  Lexer,
  scanFile,
  writePdf,
  type PDict,
  type PObj,
  type PStream,
} from './syntax/pdfsyntax';

// ------------------------------------------------------------------ permissions

export interface Permissions {
  print: boolean;
  printHighQuality: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibility: boolean;
  assemble: boolean;
}

export const ALL_PERMISSIONS: Permissions = { print: true, printHighQuality: true, modify: true, copy: true, annotate: true, fillForms: true, accessibility: true, assemble: true };

const BITS: Record<keyof Permissions, number> = {
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  accessibility: 1 << 9,
  assemble: 1 << 10,
  printHighQuality: 1 << 11,
};

/** Signed 32-bit /P value. Reserved bits are set as the specification requires. */
export function permissionsToP(p: Partial<Permissions>): number {
  let v = 0xfffff0c0; // bits 7-8 and 13-32 must be 1
  const full = { ...ALL_PERMISSIONS, ...p };
  for (const k of Object.keys(BITS) as (keyof Permissions)[]) if (full[k]) v |= BITS[k];
  return v | 0;
}

export function permissionsFromP(p: number): Permissions {
  const out = {} as Permissions;
  for (const k of Object.keys(BITS) as (keyof Permissions)[]) out[k] = (p & BITS[k]) !== 0;
  // "print high quality" only counts if printing is allowed at all
  out.printHighQuality = out.printHighQuality && out.print;
  return out;
}

export class PasswordError extends Error {
  constructor(
    readonly kind: 'required' | 'incorrect',
    message?: string,
  ) {
    super(message ?? (kind === 'required' ? 'This document is password protected' : 'The password is incorrect'));
  }
}

export interface EncryptionInfo {
  v: number;
  r: number;
  keyBits: number;
  method: 'RC4' | 'AESV2' | 'AESV3';
  permissions: Permissions;
  rawP: number;
  encryptMetadata: boolean;
}

// ------------------------------------------------------------------ helpers

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const ZERO_IV = new Uint8Array(16);

const latin1 = (pw: string) => Uint8Array.from(pw, (c) => c.charCodeAt(0) & 255);
const padPassword = (pw: Uint8Array) => concat(pw.subarray(0, 32), PAD).subarray(0, 32);
const u32le = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const strBytes = (o: PObj | undefined): Uint8Array => (o && isStr(o) ? o.str : new Uint8Array());
const numOf = (o: PObj | undefined, d: number) => (typeof o === 'number' ? o : d);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** ISO 32000-2 algorithm 2.B (revision 6 password hash). */
async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha('SHA-256', concat(password, salt, udata));
  for (let i = 0; ; i++) {
    const k1 = concat(password, k, udata);
    const rep = new Uint8Array(k1.length * 64);
    for (let j = 0; j < 64; j++) rep.set(k1, j * k1.length);
    const e = cbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), rep);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += e[j]!;
    mod %= 3;
    k = await sha(mod === 0 ? 'SHA-256' : mod === 1 ? 'SHA-384' : 'SHA-512', e);
    if (i >= 63 && e[e.length - 1]! <= i - 31) break; // 1-based round number n = i + 1: stop when n >= 64 and last byte <= n - 32
  }
  return k.subarray(0, 32);
}

const hashR = (r: number, pw: Uint8Array, salt: Uint8Array, udata: Uint8Array) =>
  r >= 6 ? hash2B(pw, salt, udata) : sha('SHA-256', concat(pw, salt, udata));

// ------------------------------------------------------------------ reading the encryption dictionary

interface EncDict {
  v: number;
  r: number;
  length: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array;
  ue: Uint8Array;
  p: number;
  encryptMetadata: boolean;
  stm: 'RC4' | 'AESV2' | 'AESV3' | 'None';
  str: 'RC4' | 'AESV2' | 'AESV3' | 'None';
  id0: Uint8Array;
}

function parseEncDict(d: Record<string, PObj>, trailer: Record<string, PObj>): EncDict {
  const v = numOf(d.V, 0);
  const r = numOf(d.R, 2);
  let stm: EncDict['stm'] = 'RC4';
  let str: EncDict['str'] = 'RC4';
  let length = numOf(d.Length, 40);
  if (v >= 4) {
    const cf = dictOf(d.CF ?? null) ?? {};
    const method = (name: PObj | undefined): EncDict['stm'] => {
      if (!name || !isName(name) || name.name === 'Identity') return 'None';
      const f = dictOf(cf[name.name] ?? null);
      const cfm = f?.CFM;
      if (cfm && isName(cfm)) {
        if (cfm.name === 'AESV2') return 'AESV2';
        if (cfm.name === 'AESV3') return 'AESV3';
        if (cfm.name === 'V2') return 'RC4';
        if (cfm.name === 'None') return 'None';
      }
      return 'RC4';
    };
    stm = method(d.StmF);
    str = method(d.StrF);
    if (v === 4) length = 128;
    if (v === 5) length = 256;
  }
  const ids = Array.isArray(trailer.ID) ? trailer.ID : [];
  return {
    v,
    r,
    length,
    o: strBytes(d.O),
    u: strBytes(d.U),
    oe: strBytes(d.OE),
    ue: strBytes(d.UE),
    p: numOf(d.P, 0) | 0,
    encryptMetadata: d.EncryptMetadata !== false,
    stm,
    str,
    id0: strBytes(ids[0]),
  };
}

/** Algorithm 2: file key from a (padded) user password, revisions 2-4. */
function legacyKey(e: EncDict, pw: Uint8Array): Uint8Array {
  const n = e.r === 2 ? 5 : e.length / 8;
  let h = md5(concat(padPassword(pw), e.o.subarray(0, 32), u32le(e.p), e.id0, e.r >= 4 && !e.encryptMetadata ? Uint8Array.of(255, 255, 255, 255) : new Uint8Array()));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

function legacyUserOk(e: EncDict, key: Uint8Array): boolean {
  if (e.r === 2) return eq(rc4(key, PAD), e.u.subarray(0, 32));
  let x = rc4(key, md5(concat(PAD, e.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return eq(x.subarray(0, 16), e.u.subarray(0, 16));
}

/** Algorithm 7: recover the user password from /O with the owner password. */
function userPasswordFromOwner(e: EncDict, ownerPw: Uint8Array): Uint8Array {
  let h = md5(padPassword(ownerPw));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const n = e.r === 2 ? 5 : e.length / 8;
  const key = h.subarray(0, n);
  let x = e.o.subarray(0, 32);
  if (e.r === 2) return rc4(key, x);
  for (let i = 19; i >= 0; i--) x = rc4(key.map((b) => b ^ i), x);
  return x;
}

interface Auth {
  fileKey: Uint8Array;
  owner: boolean;
}

async function authenticate(e: EncDict, password: string): Promise<Auth | null> {
  if (e.r >= 5) {
    const pw = utf8(password).subarray(0, 127);
    const uValidation = e.u.subarray(0, 32);
    const uVSalt = e.u.subarray(32, 40);
    const uKSalt = e.u.subarray(40, 48);
    const oValidation = e.o.subarray(0, 32);
    const oVSalt = e.o.subarray(32, 40);
    const oKSalt = e.o.subarray(40, 48);
    const u48 = e.u.subarray(0, 48);
    if (eq(await hashR(e.r, pw, oVSalt, u48), oValidation)) {
      const ik = await hashR(e.r, pw, oKSalt, u48);
      return { fileKey: cbcDecryptNoPad(ik, ZERO_IV, e.oe.subarray(0, 32)), owner: true };
    }
    if (eq(await hashR(e.r, pw, uVSalt, new Uint8Array()), uValidation)) {
      const ik = await hashR(e.r, pw, uKSalt, new Uint8Array());
      return { fileKey: cbcDecryptNoPad(ik, ZERO_IV, e.ue.subarray(0, 32)), owner: false };
    }
    return null;
  }
  const pw = latin1(password);
  let key = legacyKey(e, pw);
  if (legacyUserOk(e, key)) return { fileKey: key, owner: false };
  const userPw = userPasswordFromOwner(e, pw);
  key = legacyKey(e, userPw);
  if (legacyUserOk(e, key)) return { fileKey: key, owner: true };
  return null;
}

// ------------------------------------------------------------------ whole-file object decoding

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  void w.write(data as BufferSource).catch(() => undefined);
  void w.close().catch(() => undefined);
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  void w.write(data as BufferSource);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Expand compressed object streams into ordinary objects. Returns the objects keyed by number. */
export async function expandObjectStreams(objects: { num: number; gen: number; obj: PObj }[]): Promise<Map<number, { gen: number; obj: PObj }>> {
  const out = new Map<number, { gen: number; obj: PObj }>();
  const later: { num: number; obj: PStream }[] = [];
  for (const o of objects) {
    if (isStream(o.obj) && isName(o.obj.dict.Type ?? null, 'XRef')) continue;
    if (isStream(o.obj) && isName(o.obj.dict.Type ?? null, 'ObjStm')) {
      later.push({ num: o.num, obj: o.obj });
      continue;
    }
    out.set(o.num, { gen: o.gen, obj: o.obj });
  }
  for (const { obj } of later) {
    const f = obj.dict.Filter;
    const filters = Array.isArray(f) ? f : f ? [f] : [];
    if (filters.length > 1 || (filters.length === 1 && !isName(filters[0]!, 'FlateDecode'))) continue; // unsupported filter chain
    const data = filters.length ? await inflate(obj.data).catch(() => null) : obj.data;
    if (!data) continue;
    const n = numOf(obj.dict.N, 0);
    const first = numOf(obj.dict.First, 0);
    const head = new Lexer(data, 0);
    const pairs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = head.parse(false);
      const b = head.parse(false);
      if (typeof a === 'number' && typeof b === 'number') pairs.push([a, b]);
    }
    for (const [num, off] of pairs) {
      const body = new Lexer(data, first + off).parse() ?? null;
      if (!out.has(num)) out.set(num, { gen: 0, obj: body });
    }
  }
  return out;
}

function objectKey(e: EncDict, fileKey: Uint8Array, num: number, gen: number, method: EncDict['stm']): Uint8Array {
  if (method === 'AESV3') return fileKey;
  const parts = [fileKey, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255)];
  if (method === 'AESV2') parts.push(Uint8Array.of(0x73, 0x41, 0x6c, 0x54));
  return md5(concat(...parts)).subarray(0, Math.min(fileKey.length + 5, 16));
}

type Crypt = (data: Uint8Array, key: Uint8Array) => Uint8Array;

/** Apply `fn` to every string (recursively through arrays and dictionaries). */
function mapStrings(o: PObj, fn: (s: Uint8Array) => Uint8Array): PObj {
  if (isStr(o)) return { str: fn(o.str) };
  if (Array.isArray(o)) return o.map((x) => mapStrings(x, fn));
  if (isStream(o)) return { ...o, dict: mapStringsInDict(o.dict, fn) };
  if (isDict(o)) return { dict: mapStringsInDict(o.dict, fn) };
  return o;
}
const mapStringsInDict = (d: Record<string, PObj>, fn: (s: Uint8Array) => Uint8Array) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, mapStrings(v, fn)]));

function transformObject(o: PObj, e: Pick<EncDict, 'stm' | 'str' | 'encryptMetadata'>, fileKeyFor: (m: EncDict['stm']) => Uint8Array, cryptStr: Crypt, cryptStm: Crypt): PObj {
  const strKey = fileKeyFor(e.str);
  const withStrings = e.str === 'None' ? o : mapStrings(o, (s) => cryptStr(s, strKey));
  if (!isStream(withStrings)) return withStrings;
  const type = withStrings.dict.Type;
  const filters = withStrings.dict.Filter;
  const hasCrypt = (Array.isArray(filters) ? filters : [filters]).some((f) => f && isName(f, 'Crypt'));
  const skipMeta = !e.encryptMetadata && !!type && isName(type, 'Metadata');
  if (e.stm === 'None' || hasCrypt || skipMeta) return withStrings;
  return { ...withStrings, data: cryptStm(withStrings.data, fileKeyFor(e.stm)) };
}

// ------------------------------------------------------------------ public API: reading

/** Encryption parameters of a file (null if not encrypted). Needs no password. */
export function readEncryptionInfo(bytes: Uint8Array): EncryptionInfo | null {
  const scan = scanFile(bytes);
  const enc = resolveEncrypt(scan);
  if (!enc) return null;
  const e = parseEncDict(enc.dict, scan.trailer);
  return { v: e.v, r: e.r, keyBits: e.length, method: e.v >= 5 ? 'AESV3' : e.stm === 'None' ? 'RC4' : e.stm, permissions: permissionsFromP(e.p), rawP: e.p, encryptMetadata: e.encryptMetadata };
}

function resolveEncrypt(scan: ReturnType<typeof scanFile>): { dict: Record<string, PObj>; ref?: number } | null {
  const t = scan.trailer.Encrypt;
  if (!t) return null;
  if (isRef(t)) {
    const hit = scan.objects.filter((o) => o.num === t.ref[0]).pop();
    const d = hit && dictOf(hit.obj);
    return d ? { dict: d, ref: t.ref[0] } : null;
  }
  const d = dictOf(t);
  return d ? { dict: d } : null;
}

export interface DecryptResult {
  /** A plain, unencrypted copy of the document. */
  bytes: Uint8Array;
  info: EncryptionInfo;
  /** True if the password opened the document as owner (all restrictions can be lifted). */
  ownerAuthenticated: boolean;
}

/**
 * Remove encryption (RC4 40/128, AES-128, AES-256) given a password; the user password may be empty.
 * The result is an ordinary PDF with all objects written out (object streams expanded).
 */
export async function decryptPdf(bytes: Uint8Array, password = ''): Promise<DecryptResult> {
  const scan = scanFile(bytes);
  const enc = resolveEncrypt(scan);
  if (!enc) throw new Error('The document is not encrypted');
  const e = parseEncDict(enc.dict, scan.trailer);
  if (e.v < 1 || e.v > 5 || e.r < 2 || e.r > 6) throw new Error(`Unsupported encryption (V${e.v} R${e.r})`);
  const auth = await authenticate(e, password);
  if (!auth) throw new PasswordError(password ? 'incorrect' : 'required');

  const decStr: Crypt = (data, key) => (e.str === 'RC4' ? rc4(key, data) : aesDecryptPdf(key, data));
  const decStm: Crypt = (data, key) => (e.stm === 'RC4' ? rc4(key, data) : aesDecryptPdf(key, data));

  const plain: { num: number; gen: number; obj: PObj }[] = [];
  for (const o of scan.objects) {
    if (o.num === enc.ref) continue; // the encryption dictionary itself is never encrypted
    let obj = o.obj;
    try {
      obj = transformObject(
        o.obj,
        e,
        (m) => objectKey(e, auth.fileKey, o.num, o.gen, m),
        decStr,
        decStm,
      );
    } catch {
      /* damaged object: keep as is rather than failing the whole document */
    }
    plain.push({ num: o.num, gen: o.gen, obj });
  }
  const objects = await expandObjectStreams(plain);

  const trailer: Record<string, PObj> = {};
  for (const k of ['Root', 'Info', 'ID']) if (scan.trailer[k] !== undefined) trailer[k] = scan.trailer[k]!;
  // /ID strings in the trailer are never encrypted
  return {
    bytes: writePdf(scan.header, objects, trailer),
    info: { v: e.v, r: e.r, keyBits: e.length, method: e.v >= 5 ? 'AESV3' : e.stm === 'None' ? 'RC4' : e.stm, permissions: permissionsFromP(e.p), rawP: e.p, encryptMetadata: e.encryptMetadata },
    ownerAuthenticated: auth.owner,
  };
}

// ------------------------------------------------------------------ public API: writing

export interface EncryptOptions {
  /** Password needed to open the document. Empty = anyone can open it (permissions still apply). */
  userPassword: string;
  /** Password that lifts the permission restrictions. Required. */
  ownerPassword: string;
  permissions?: Partial<Permissions>;
  /** Encrypt XMP metadata too (default true). */
  encryptMetadata?: boolean;
}

/** Encrypt with AES-256 (PDF 2.0 revision 6). The input must not already be encrypted. */
export async function encryptPdf(bytes: Uint8Array, opts: EncryptOptions): Promise<Uint8Array> {
  if (!opts.ownerPassword) throw new Error('An owner password is required');
  const scan = scanFile(bytes);
  if (scan.trailer.Encrypt) throw new Error('The document is already encrypted');
  const objects = await expandObjectStreams(scan.objects);

  const fileKey = randomBytes(32);
  const userPw = utf8(opts.userPassword).subarray(0, 127);
  const ownerPw = utf8(opts.ownerPassword).subarray(0, 127);
  const P = permissionsToP(opts.permissions ?? {});
  const encryptMetadata = opts.encryptMetadata !== false;

  const uvs = randomBytes(8);
  const uks = randomBytes(8);
  const u = concat(await hash2B(userPw, uvs, new Uint8Array()), uvs, uks);
  const ue = cbcEncryptNoPad(await hash2B(userPw, uks, new Uint8Array()), ZERO_IV, fileKey);
  const ovs = randomBytes(8);
  const oks = randomBytes(8);
  const o = concat(await hash2B(ownerPw, ovs, u), ovs, oks);
  const oe = cbcEncryptNoPad(await hash2B(ownerPw, oks, u), ZERO_IV, fileKey);
  const perms = new Uint8Array(16);
  perms.set(u32le(P), 0);
  perms.set([255, 255, 255, 255], 4);
  perms[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  perms.set([0x61, 0x64, 0x62], 9); // 'adb'
  perms.set(randomBytes(4), 12);
  const permsEnc = cbcEncryptNoPad(fileKey, ZERO_IV, perms);

  const crypt: Crypt = (data, key) => aesEncryptPdf(key, data);
  const encrypted = new Map<number, { gen: number; obj: PObj }>();
  for (const [num, { gen, obj }] of objects) {
    encrypted.set(num, { gen, obj: transformObject(obj, { stm: 'AESV3', str: 'AESV3', encryptMetadata }, () => fileKey, crypt, crypt) });
  }

  const encNum = Math.max(0, ...encrypted.keys()) + 1;
  const encDict: PDict = {
    dict: {
      Filter: { name: 'Standard' },
      V: 5,
      R: 6,
      Length: 256,
      P,
      O: { str: o },
      U: { str: u },
      OE: { str: oe },
      UE: { str: ue },
      Perms: { str: permsEnc },
      EncryptMetadata: encryptMetadata,
      CF: { dict: { StdCF: { dict: { AuthEvent: { name: 'DocOpen' }, CFM: { name: 'AESV3' }, Length: 32 } } } },
      StmF: { name: 'StdCF' },
      StrF: { name: 'StdCF' },
    },
  };
  encrypted.set(encNum, { gen: 0, obj: encDict });

  const trailer: Record<string, PObj> = { Encrypt: { ref: [encNum, 0] } };
  for (const k of ['Root', 'Info']) if (scan.trailer[k] !== undefined) trailer[k] = scan.trailer[k]!;
  const id = Array.isArray(scan.trailer.ID) && scan.trailer.ID.length ? scan.trailer.ID : [{ str: randomBytes(16) }, { str: randomBytes(16) }];
  trailer.ID = id; // not encrypted
  return writePdf(scan.header, encrypted, trailer);
}

export { toHex, asciiOf };
