import { createCipheriv, createDecipheriv, createHash, createCipheriv as c2, randomBytes as nodeRandom } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesDecryptPdf, aesEncryptPdf, cbcDecryptNoPad, cbcEncryptNoPad } from './aes';
import { md5, rc4, toHex } from './hash';

const rnd = (n: number) => new Uint8Array(nodeRandom(n));

describe('AES', () => {
  it.each([16, 24, 32])('matches node:crypto for %i-byte keys (CBC, no padding)', (len) => {
    for (const size of [16, 48, 256]) {
      const key = rnd(len);
      const iv = rnd(16);
      const data = rnd(size);
      const c = createCipheriv(`aes-${len * 8}-cbc`, key, iv);
      c.setAutoPadding(false);
      const expected = new Uint8Array(Buffer.concat([c.update(data), c.final()]));
      const ours = cbcEncryptNoPad(key, iv, data);
      expect([...ours]).toEqual([...expected]);
      expect([...cbcDecryptNoPad(key, iv, ours)]).toEqual([...data]);
      const d = createDecipheriv(`aes-${len * 8}-cbc`, key, iv);
      d.setAutoPadding(false);
      expect([...new Uint8Array(Buffer.concat([d.update(expected), d.final()]))]).toEqual([...data]);
    }
  });

  it('passes the FIPS-197 AES-128 example vector', () => {
    const key = Uint8Array.from('000102030405060708090a0b0c0d0e0f'.match(/../g)!.map((h) => parseInt(h, 16)));
    const pt = Uint8Array.from('00112233445566778899aabbccddeeff'.match(/../g)!.map((h) => parseInt(h, 16)));
    expect(toHex(cbcEncryptNoPad(key, new Uint8Array(16), pt))).toBe('69c4e0d86a7b0430d8cdb78070b4c55a');
  });

  it('PDF-style encryption round-trips and is interoperable with node:crypto', () => {
    const key = rnd(32);
    for (const n of [0, 1, 15, 16, 17, 1000]) {
      const data = rnd(n);
      const enc = aesEncryptPdf(key, data);
      expect(enc.length).toBe(16 + (Math.floor(n / 16) + 1) * 16);
      expect([...aesDecryptPdf(key, enc)]).toEqual([...data]);
      const d = createDecipheriv('aes-256-cbc', key, enc.subarray(0, 16)); // standard padding
      expect([...new Uint8Array(Buffer.concat([d.update(enc.subarray(16)), d.final()]))]).toEqual([...data]);
    }
    expect(() => aesDecryptPdf(key, rnd(48))).toThrow(); // wrong key => bad padding (overwhelmingly likely)
    void c2;
  });
});

describe('MD5 and RC4', () => {
  it('md5 matches node:crypto', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const d = rnd(n);
      expect(toHex(md5(d))).toBe(createHash('md5').update(d).digest('hex'));
    }
    expect(toHex(md5(new TextEncoder().encode('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('rc4 matches the RFC 6229 vector and is symmetric', () => {
    const key = Uint8Array.from([1, 2, 3, 4, 5]);
    const ks = rc4(key, new Uint8Array(16));
    expect(toHex(ks)).toBe('b2396305f03dc027ccc3524a0a1118a8');
    const data = rnd(100);
    expect([...rc4(key, rc4(key, data))]).toEqual([...data]);
  });
});
