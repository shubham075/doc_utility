import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import type { PdfEngine } from '@pdfsuite/engine';
import { certificateFromPem, certificateToPem, createSelfSignedIdentity, identityToPkcs12, loadPkcs12, type SigningIdentity } from './cms';
import { signPdf } from './sign';
import { verifySignatures } from './verify';
import { fixture, hasPikepdf, makeEngines, pageTexts } from '../testutil';
import { PDFName } from 'pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => new Uint8Array(readFileSync(join(here, '..', '..', 'fixtures', n)));
const hasPyhanko = spawnSync('python', ['-c', 'import pyhanko'], { encoding: 'utf8' }).status === 0;

let engines: PdfEngine[] = [];
let id: SigningIdentity;
beforeAll(async () => {
  engines = await makeEngines();
  id = loadPkcs12(fx('modern.p12'), 'pw'); // made by Python's cryptography: independent of forge's generator
});
afterAll(async () => {
  for (const e of engines) await e.dispose();
});

async function basePdf(opts: { rotate?: number; objstm?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText('Contract text to be signed', { x: 30, y: 200, size: 18, font });
  if (opts.rotate) page.setRotation(degrees(opts.rotate));
  doc.addPage([400, 300]);
  return doc.save({ useObjectStreams: opts.objstm === true });
}

const trust = () => [certificateFromPem(readFileSync(join(here, '..', '..', 'fixtures', 'test-cert.pem'), 'utf8'))];

describe('PFX loading', () => {
  it('reads RSA identities from modern (AES) and legacy (3DES) PKCS#12 files, and rejects a wrong password', () => {
    for (const f of ['modern.p12', 'legacy.p12']) {
      const i = loadPkcs12(fx(f), 'pw');
      expect(i.certificate.subject.getField('CN').value).toBe('Test Signer');
    }
    expect(() => loadPkcs12(fx('modern.p12'), 'wrong')).toThrow();
  });

  it('round-trips a generated identity through PKCS#12', () => {
    const made = createSelfSignedIdentity({ commonName: 'Generated', organization: 'Org', keyBits: 1024 });
    const back = loadPkcs12(identityToPkcs12(made, 'x'), 'x');
    expect(back.certificate.subject.getField('CN').value).toBe('Generated');
    expect(certificateToPem(back.certificate)).toContain('BEGIN CERTIFICATE');
  });
});

describe('signing and verifying', () => {
  it('produces a signature that verifies, is untrusted without a root and trusted with it', async () => {
    const signed = await signPdf(await basePdf(), { identity: id, reason: 'I approve', location: 'Berlin' });
    const [untrusted] = await verifySignatures(signed);
    expect(untrusted).toMatchObject({ signer: 'Test Signer', digestMatches: true, signatureValid: true, certificateInDate: true, coversWholeFile: true, trust: 'self-signed', status: 'valid-untrusted', reason: 'I approve', location: 'Berlin', subFilter: 'ETSI.CAdES.detached' });
    const [trusted] = await verifySignatures(signed, { trustedRoots: trust() });
    expect(trusted).toMatchObject({ trust: 'trusted', status: 'valid', problems: [] });
  });

  it('keeps the original bytes untouched (incremental update) and the document readable', async () => {
    const base = await basePdf();
    const signed = await signPdf(base, { identity: id });
    expect([...signed.subarray(0, base.length)]).toEqual([...base]);
    for (const e of engines) expect((await pageTexts(e, signed))[0]).toContain('Contract text to be signed');
    const doc = await PDFDocument.load(signed);
    expect(doc.getForm().getFields().map((f) => f.constructor.name)).toContain('PDFSignature');
  });

  it('detects tampering inside the signed range and appended changes', async () => {
    const signed = await signPdf(await basePdf(), { identity: id });
    const flipped = signed.slice();
    const at = new TextDecoder('latin1').decode(flipped).indexOf('%PDF-1.7');
    flipped[at + 5] = 0x38; // change the header version inside the signed range
    const [broken] = await verifySignatures(flipped, { trustedRoots: trust() });
    expect(broken).toMatchObject({ status: 'invalid', digestMatches: false });
    expect(broken!.problems.join(' ')).toMatch(/differs/);

    const appended = new Uint8Array([...signed, ...new TextEncoder().encode('\n% appended\n')]);
    const [late] = await verifySignatures(appended, { trustedRoots: trust() });
    expect(late).toMatchObject({ status: 'modified-after-signing', coversWholeFile: false, digestMatches: true, signatureValid: true });
  });

  it('supports several signatures in a row; earlier ones stay valid but no longer cover the whole file', async () => {
    const one = await signPdf(await basePdf(), { identity: id, fieldName: 'First' });
    const two = await signPdf(one, { identity: id, fieldName: 'Second', reason: 'second approver' });
    const reports = await verifySignatures(two, { trustedRoots: trust() });
    expect(reports.map((r) => r.fieldName).sort()).toEqual(['First', 'Second']);
    expect(reports.every((r) => r.status === 'valid')).toBe(true);
    expect(reports.find((r) => r.fieldName === 'First')!.coversWholeFile).toBe(false);
    expect(reports.find((r) => r.fieldName === 'Second')!.coversWholeFile).toBe(true);
    expect(await PDFDocument.load(two).then((d) => d.getForm().getFields().length)).toBe(2);
  });

  it('signs files whose cross-reference data is an xref stream', async () => {
    const base = await basePdf({ objstm: true });
    expect(new TextDecoder('latin1').decode(base)).not.toMatch(/\nxref\n/); // really a stream-based file
    const signed = await signPdf(base, { identity: id });
    const [r] = await verifySignatures(signed, { trustedRoots: trust() });
    expect(r!.status).toBe('valid');
    for (const e of engines) expect((await pageTexts(e, signed))[0]).toContain('Contract text');
  });

  it('draws a visible signature box (also on rotated pages) with the signer and reason', async () => {
    for (const rotate of [0, 90]) {
      const signed = await signPdf(await basePdf({ rotate }), { identity: id, reason: 'Approved', visible: { page: 0, rect: { x: rotate ? 150 : 200, y: 20, width: 180, height: 60 } } });
      const [r] = await verifySignatures(signed, { trustedRoots: trust() });
      expect(r!.status).toBe('valid');
      const doc = await engines[0]!.open(signed);
      const page = await doc.getPage(0);
      const bmp = await page.render({ scale: 1 });
      let dark = 0;
      const [x0, y0] = rotate ? [150, 20] : [200, 20];
      for (let y = y0; y < y0 + 60; y++) for (let x = x0; x < x0 + 180; x++) {
        const i = (y * bmp.width + x) * 4;
        if (bmp.data[i]! < 120 && bmp.data[i + 2]! < 160) dark++;
      }
      doc.close();
      expect(dark, `rotation ${rotate}`).toBeGreaterThan(80); // text and border are drawn
    }
  });

  it('refuses encrypted input and reports signatures that do not fit the reserved space', async () => {
    await expect(signPdf(fixture('aes-256'), { identity: id })).rejects.toThrow(/Decrypt/);
    await expect(signPdf(await basePdf(), { identity: id, signatureSize: 200 })).rejects.toThrow(/reserved/);
  });

  it('finds no signatures in an unsigned document', async () => {
    expect(await verifySignatures(await basePdf())).toEqual([]);
  });

  it.skipIf(!hasPikepdf)('is structurally valid for qpdf and keeps both revisions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-sig-'));
    const file = join(dir, 'signed.pdf');
    writeFileSync(file, await signPdf(await basePdf(), { identity: id }));
    const out = spawnSync('python', ['-c', `import pikepdf,sys\np=pikepdf.open(sys.argv[1])\nprint(len(p.pages), len(p.Root.AcroForm.Fields), p.Root.AcroForm.SigFlags)`, file], { encoding: 'utf8' });
    expect(out.stdout.trim()).toBe('2 1 3');
  });

  it.skipIf(!hasPyhanko)('is validated by pyHanko (independent implementation): intact, valid and trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfsuite-sig-'));
    const run = (file: string) => JSON.parse(spawnSync('python', [join(here, '..', '..', 'tools', 'validate_sig.py'), file, join(here, '..', '..', 'fixtures', 'test-cert.pem')], { encoding: 'utf8' }).stdout.trim().split('\n').pop()!) as Record<string, unknown>[];
    const base = await basePdf();
    const one = join(dir, 'one.pdf');
    writeFileSync(one, await signPdf(base, { identity: id, fieldName: 'Sig1' }));
    expect(run(one)[0]).toMatchObject({ field: 'Sig1', intact: true, valid: true, trusted: true });

    const two = join(dir, 'two.pdf');
    writeFileSync(two, await signPdf(await signPdf(base, { identity: id, fieldName: 'A' }), { identity: id, fieldName: 'B', visible: { page: 0, rect: { x: 200, y: 20, width: 150, height: 50 } } }));
    const both = run(two);
    expect(both.map((s) => s.field).sort()).toEqual(['A', 'B']);
    expect(both.every((s) => s.intact && s.valid && s.trusted)).toBe(true);

    const bad = join(dir, 'bad.pdf');
    const tampered = await signPdf(base, { identity: id });
    tampered[10] = tampered[10]! ^ 1;
    writeFileSync(bad, tampered);
    expect(run(bad)[0]).toMatchObject({ intact: false });
    void PDFName;
  });
});
