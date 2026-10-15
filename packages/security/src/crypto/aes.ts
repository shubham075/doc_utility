/**
 * Small, dependency-free AES (128/192/256) with CBC mode, usable in browsers and Node alike.
 * WebCrypto cannot do unpadded CBC, which the PDF hash algorithm (ISO 32000-2, 7.6.4.3.4) needs, and a
 * synchronous implementation keeps the per-object encryption loops simple. Verified against node:crypto in tests.
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

(function init() {
  // S-box = affine transform of the multiplicative inverse in GF(2^8) (polynomial 0x11b)
  const gmul = (x: number, y: number) => {
    let r = 0;
    while (y) {
      if (y & 1) r ^= x;
      x = ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
      y >>= 1;
    }
    return r;
  };
  const inv = new Uint8Array(256);
  for (let x = 1; x < 256; x++) for (let y = 1; y < 256; y++) if (gmul(x, y) === 1) { inv[x] = y; break; }
  const rotl = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff;
  for (let x = 0; x < 256; x++) {
    const i = inv[x]!;
    const v = i ^ rotl(i, 1) ^ rotl(i, 2) ^ rotl(i, 3) ^ rotl(i, 4) ^ 0x63;
    SBOX[x] = v;
    INV_SBOX[v] = x;
  }
})();

const xtime = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return r;
};

// T-tables: SubBytes + ShiftRows + MixColumns folded into word lookups (big-endian columns).
const TE = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
const TD = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
for (let i = 0; i < 256; i++) {
  const s = SBOX[i]!;
  const e = ((mul(s, 2) << 24) | (s << 16) | (s << 8) | mul(s, 3)) >>> 0;
  const v = INV_SBOX[i]!;
  const d = ((mul(v, 14) << 24) | (mul(v, 9) << 16) | (mul(v, 13) << 8) | mul(v, 11)) >>> 0;
  for (let k = 0; k < 4; k++) {
    TE[k]![i] = ((e >>> (8 * k)) | (e << (32 - 8 * k))) >>> 0;
    TD[k]![i] = ((d >>> (8 * k)) | (d << (32 - 8 * k))) >>> 0;
  }
}

const rdWord = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const wrWord = (b: Uint8Array, o: number, w: number) => {
  b[o] = w >>> 24;
  b[o + 1] = (w >>> 16) & 255;
  b[o + 2] = (w >>> 8) & 255;
  b[o + 3] = w & 255;
};
const subWord = (w: number) => ((SBOX[w >>> 24]! << 24) | (SBOX[(w >>> 16) & 255]! << 16) | (SBOX[(w >>> 8) & 255]! << 8) | SBOX[w & 255]!) >>> 0;

export class AES {
  private readonly rounds: number;
  private readonly ek: Uint32Array;
  private readonly dk: Uint32Array;

  constructor(key: Uint8Array) {
    if (![16, 24, 32].includes(key.length)) throw new Error('AES key must be 16, 24 or 32 bytes');
    const nk = key.length / 4;
    this.rounds = nk + 6;
    const total = 4 * (this.rounds + 1);
    const w = new Uint32Array(total);
    for (let i = 0; i < nk; i++) w[i] = rdWord(key, 4 * i);
    for (let i = nk; i < total; i++) {
      let t = w[i - 1]!;
      if (i % nk === 0) t = (subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (RCON[i / nk - 1]! << 24)) >>> 0;
      else if (nk > 6 && i % nk === 4) t = subWord(t);
      w[i] = (w[i - nk]! ^ t) >>> 0;
    }
    this.ek = w;
    // decryption key schedule: reversed round keys with InvMixColumns applied to the middle ones
    const dk = new Uint32Array(total);
    for (let r = 0; r <= this.rounds; r++) {
      for (let c = 0; c < 4; c++) {
        let v = w[4 * (this.rounds - r) + c]!;
        if (r > 0 && r < this.rounds) {
          v = (TD[0]![SBOX[v >>> 24]!]! ^ TD[1]![SBOX[(v >>> 16) & 255]!]! ^ TD[2]![SBOX[(v >>> 8) & 255]!]! ^ TD[3]![SBOX[v & 255]!]!) >>> 0;
        }
        dk[4 * r + c] = v;
      }
    }
    this.dk = dk;
  }

  encryptBlock(inp: Uint8Array, off: number, out: Uint8Array, outOff: number) {
    const k = this.ek;
    let s0 = (rdWord(inp, off) ^ k[0]!) >>> 0;
    let s1 = (rdWord(inp, off + 4) ^ k[1]!) >>> 0;
    let s2 = (rdWord(inp, off + 8) ^ k[2]!) >>> 0;
    let s3 = (rdWord(inp, off + 12) ^ k[3]!) >>> 0;
    const [t0, t1, t2, t3] = TE as [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
    for (let r = 1; r < this.rounds; r++) {
      const n0 = t0[s0 >>> 24]! ^ t1[(s1 >>> 16) & 255]! ^ t2[(s2 >>> 8) & 255]! ^ t3[s3 & 255]! ^ k[4 * r]!;
      const n1 = t0[s1 >>> 24]! ^ t1[(s2 >>> 16) & 255]! ^ t2[(s3 >>> 8) & 255]! ^ t3[s0 & 255]! ^ k[4 * r + 1]!;
      const n2 = t0[s2 >>> 24]! ^ t1[(s3 >>> 16) & 255]! ^ t2[(s0 >>> 8) & 255]! ^ t3[s1 & 255]! ^ k[4 * r + 2]!;
      const n3 = t0[s3 >>> 24]! ^ t1[(s0 >>> 16) & 255]! ^ t2[(s1 >>> 8) & 255]! ^ t3[s2 & 255]! ^ k[4 * r + 3]!;
      s0 = n0 >>> 0; s1 = n1 >>> 0; s2 = n2 >>> 0; s3 = n3 >>> 0;
    }
    const r = this.rounds;
    wrWord(out, outOff, ((SBOX[s0 >>> 24]! << 24) | (SBOX[(s1 >>> 16) & 255]! << 16) | (SBOX[(s2 >>> 8) & 255]! << 8) | SBOX[s3 & 255]!) ^ k[4 * r]!);
    wrWord(out, outOff + 4, ((SBOX[s1 >>> 24]! << 24) | (SBOX[(s2 >>> 16) & 255]! << 16) | (SBOX[(s3 >>> 8) & 255]! << 8) | SBOX[s0 & 255]!) ^ k[4 * r + 1]!);
    wrWord(out, outOff + 8, ((SBOX[s2 >>> 24]! << 24) | (SBOX[(s3 >>> 16) & 255]! << 16) | (SBOX[(s0 >>> 8) & 255]! << 8) | SBOX[s1 & 255]!) ^ k[4 * r + 2]!);
    wrWord(out, outOff + 12, ((SBOX[s3 >>> 24]! << 24) | (SBOX[(s0 >>> 16) & 255]! << 16) | (SBOX[(s1 >>> 8) & 255]! << 8) | SBOX[s2 & 255]!) ^ k[4 * r + 3]!);
  }

  decryptBlock(inp: Uint8Array, off: number, out: Uint8Array, outOff: number) {
    const k = this.dk;
    let s0 = (rdWord(inp, off) ^ k[0]!) >>> 0;
    let s1 = (rdWord(inp, off + 4) ^ k[1]!) >>> 0;
    let s2 = (rdWord(inp, off + 8) ^ k[2]!) >>> 0;
    let s3 = (rdWord(inp, off + 12) ^ k[3]!) >>> 0;
    const [t0, t1, t2, t3] = TD as [Uint32Array, Uint32Array, Uint32Array, Uint32Array];
    for (let r = 1; r < this.rounds; r++) {
      const n0 = t0[s0 >>> 24]! ^ t1[(s3 >>> 16) & 255]! ^ t2[(s2 >>> 8) & 255]! ^ t3[s1 & 255]! ^ k[4 * r]!;
      const n1 = t0[s1 >>> 24]! ^ t1[(s0 >>> 16) & 255]! ^ t2[(s3 >>> 8) & 255]! ^ t3[s2 & 255]! ^ k[4 * r + 1]!;
      const n2 = t0[s2 >>> 24]! ^ t1[(s1 >>> 16) & 255]! ^ t2[(s0 >>> 8) & 255]! ^ t3[s3 & 255]! ^ k[4 * r + 2]!;
      const n3 = t0[s3 >>> 24]! ^ t1[(s2 >>> 16) & 255]! ^ t2[(s1 >>> 8) & 255]! ^ t3[s0 & 255]! ^ k[4 * r + 3]!;
      s0 = n0 >>> 0; s1 = n1 >>> 0; s2 = n2 >>> 0; s3 = n3 >>> 0;
    }
    const r = this.rounds;
    wrWord(out, outOff, ((INV_SBOX[s0 >>> 24]! << 24) | (INV_SBOX[(s3 >>> 16) & 255]! << 16) | (INV_SBOX[(s2 >>> 8) & 255]! << 8) | INV_SBOX[s1 & 255]!) ^ k[4 * r]!);
    wrWord(out, outOff + 4, ((INV_SBOX[s1 >>> 24]! << 24) | (INV_SBOX[(s0 >>> 16) & 255]! << 16) | (INV_SBOX[(s3 >>> 8) & 255]! << 8) | INV_SBOX[s2 & 255]!) ^ k[4 * r + 1]!);
    wrWord(out, outOff + 8, ((INV_SBOX[s2 >>> 24]! << 24) | (INV_SBOX[(s1 >>> 16) & 255]! << 16) | (INV_SBOX[(s0 >>> 8) & 255]! << 8) | INV_SBOX[s3 & 255]!) ^ k[4 * r + 2]!);
    wrWord(out, outOff + 12, ((INV_SBOX[s3 >>> 24]! << 24) | (INV_SBOX[(s2 >>> 16) & 255]! << 16) | (INV_SBOX[(s1 >>> 8) & 255]! << 8) | INV_SBOX[s0 & 255]!) ^ k[4 * r + 3]!);
  }
}

/** CBC without padding; `data.length` must be a multiple of 16. */
export function cbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('CBC data must be a multiple of 16 bytes');
  const aes = new AES(key);
  const out = new Uint8Array(data.length);
  const block = new Uint8Array(16);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    for (let j = 0; j < 16; j++) block[j] = data[i + j]! ^ prev[j]!;
    aes.encryptBlock(block, 0, out, i);
    prev = out.subarray(i, i + 16);
  }
  return out;
}

export function cbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('CBC data must be a multiple of 16 bytes');
  const aes = new AES(key);
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let i = 0; i < data.length; i += 16) {
    aes.decryptBlock(data, i, out, i);
    for (let j = 0; j < 16; j++) out[i + j] = out[i + j]! ^ prev[j]!;
    prev = data.subarray(i, i + 16);
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** PDF string/stream encryption: random IV, PKCS#7 padding, output = IV || ciphertext. */
export function aesEncryptPdf(key: Uint8Array, data: Uint8Array): Uint8Array {
  const iv = randomBytes(16);
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad).fill(pad);
  padded.set(data);
  const ct = cbcEncryptNoPad(key, iv, padded);
  const out = new Uint8Array(16 + ct.length);
  out.set(iv);
  out.set(ct, 16);
  return out;
}

/** Inverse of aesEncryptPdf. Throws on malformed length or padding. */
export function aesDecryptPdf(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  if (data.length < 32 || data.length % 16) throw new Error('Invalid AES data length');
  const pt = cbcDecryptNoPad(key, data.subarray(0, 16), data.subarray(16));
  const pad = pt[pt.length - 1]!;
  if (pad < 1 || pad > 16) throw new Error('Invalid AES padding (wrong key?)');
  return pt.subarray(0, pt.length - pad);
}
