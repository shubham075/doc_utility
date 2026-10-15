import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PdfEngine } from '@pdfsuite/engine';
import { PDFDocument } from 'pdf-lib';
import { ALL_PERMISSIONS, PasswordError, decryptPdf, encryptPdf, permissionsFromP, permissionsToP, readEncryptionInfo } from './encryption';
import { fixture, hasPikepdf, makeEngines, pageTexts, pikepdfCheck } from './testutil';

let engines: PdfEngine[] = [];
beforeAll(async () => {
  engines = await makeEngines();
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

const names = ['rc4-40', 'rc4-128', 'aes-128', 'aes-128-objstm', 'aes-256', 'aes-256-objstm'] as const;
const expectedBits: Record<string, [number, number]> = {
  'rc4-40': [2, 40],
  'rc4-128': [3, 128],
  'aes-128': [4, 128],
  'aes-128-objstm': [4, 128],
  'aes-256': [6, 256],
  'aes-256-objstm': [6, 256],
};
const TEXTS = ['Secret page 1 code ZX19', 'Secret page 2 code ZX29'];

describe('permissions', () => {
  it('round-trips the /P flags', () => {
    expect(permissionsFromP(permissionsToP({}))).toEqual(ALL_PERMISSIONS);
    const p = permissionsFromP(permissionsToP({ copy: false, modify: false, print: false }));
    expect(p).toMatchObject({ copy: false, modify: false, print: false, printHighQuality: false, annotate: true, fillForms: true });
    expect(permissionsToP({})).toBeLessThan(0); // reserved high bits make it a negative int32
  });
});

describe.each(names)('decrypting files made by qpdf: %s', (name) => {
  it('reads the parameters without a password', () => {
    const info = readEncryptionInfo(fixture(name))!;
    expect([info.r, info.keyBits]).toEqual(expectedBits[name]);
    expect(info.permissions).toMatchObject({ copy: false, annotate: false, print: true });
    if (info.r >= 3) expect(info.permissions.printHighQuality).toBe(false); // revision 2 has no separate high-quality bit
  });

  it('opens with the user password and with the owner password', async () => {
    for (const [pw, owner] of [
      ['user-pw', false],
      ['owner-pw', true],
    ] as const) {
      const r = await decryptPdf(fixture(name), pw);
      expect(r.ownerAuthenticated).toBe(owner);
      for (const e of engines) expect(await pageTexts(e, r.bytes)).toEqual(TEXTS);
      expect((await PDFDocument.load(r.bytes)).getTitle()).toBe('Confidential Title');
    }
  });

  it('rejects a missing or wrong password with the right error', async () => {
    await expect(decryptPdf(fixture(name), '')).rejects.toMatchObject({ kind: 'required' });
    await expect(decryptPdf(fixture(name), 'nope')).rejects.toMatchObject({ kind: 'incorrect' });
    await expect(decryptPdf(fixture(name), 'x')).rejects.toBeInstanceOf(PasswordError);
  });
});

describe('encrypting', () => {
  it('produces AES-256 files that PDFium and PDF.js open only with the right password', async () => {
    const out = await encryptPdf(fixture('plain'), { userPassword: 'open sesame', ownerPassword: 'boss', permissions: { copy: false, modify: false } });
    const info = readEncryptionInfo(out)!;
    expect([info.v, info.r, info.keyBits, info.method]).toEqual([5, 6, 256, 'AESV3']);
    expect(info.permissions).toMatchObject({ copy: false, modify: false, print: true });
    for (const e of engines) {
      expect(await pageTexts(e, out, 'open sesame')).toEqual(TEXTS);
      expect(await pageTexts(e, out, 'boss')).toHaveLength(2);
      await expect(pageTexts(e, out, 'wrong')).rejects.toBeTruthy();
      await expect(pageTexts(e, out)).rejects.toBeTruthy();
    }
    // nothing readable leaks into the file
    const raw = new TextDecoder('latin1').decode(out);
    expect(raw).not.toContain('Secret page');
    expect(raw).not.toContain('Confidential Title');
    expect(raw).toContain('/Encrypt');
  });

  it('round-trips through our own decryptor, including an empty user password', async () => {
    const out = await encryptPdf(fixture('plain'), { userPassword: '', ownerPassword: 'boss', permissions: { print: false } });
    const open = await decryptPdf(out, '');
    expect(open.ownerAuthenticated).toBe(false);
    expect(open.info.permissions.print).toBe(false);
    expect(await pageTexts(engines[0]!, open.bytes)).toHaveLength(2);
    expect((await decryptPdf(out, 'boss')).ownerAuthenticated).toBe(true);
  });

  it('re-encrypts documents that were decrypted (AES-128 object streams -> AES-256)', async () => {
    const plain = (await decryptPdf(fixture('aes-128-objstm'), 'user-pw')).bytes;
    const again = await encryptPdf(plain, { userPassword: 'u2', ownerPassword: 'o2' });
    expect(await pageTexts(engines[0]!, again, 'u2')).toEqual(TEXTS);
  });

  it('is accepted by PDFium for many random salts (regression: hash 2.B round termination)', async () => {
    for (let i = 0; i < 40; i++) {
      const out = await encryptPdf(fixture('plain'), { userPassword: `u${i}`, ownerPassword: `o${i}` });
      expect(await pageTexts(engines[0]!, out, `u${i}`)).toHaveLength(2);
      expect(await pageTexts(engines[0]!, out, `o${i}`)).toHaveLength(2);
    }
  });

  it('refuses double encryption and missing owner passwords', async () => {
    await expect(encryptPdf(fixture('aes-256'), { userPassword: 'a', ownerPassword: 'b' })).rejects.toThrow(/already encrypted/);
    await expect(encryptPdf(fixture('plain'), { userPassword: 'a', ownerPassword: '' })).rejects.toThrow(/owner password/);
  });

  it.skipIf(!hasPikepdf)('is accepted by qpdf (independent implementation)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-sec-'));
    const file = join(dir, 'out.pdf');
    writeFileSync(file, await encryptPdf(fixture('plain'), { userPassword: 'open sesame', ownerPassword: 'boss', permissions: { copy: false, annotate: false, print: true, printHighQuality: false } }));
    const user = pikepdfCheck(file, 'open sesame');
    expect(user).toMatchObject({ pages: 2, encrypted: true, R: 6, bits: 256 });
    expect(user.P | 0).toBe(permissionsToP({ copy: false, annotate: false, print: true, printHighQuality: false }));
    expect(user.problems).toEqual([]);
    expect(user.allow).toMatchObject({ extract: false, modify_annotation: false, print_lowres: true, print_highres: false });
    expect(pikepdfCheck(file, 'boss')).toMatchObject({ pages: 2, encrypted: true });
    expect(pikepdfCheck(file, 'bad')).toMatchObject({ error: 'password' });
  });
});
