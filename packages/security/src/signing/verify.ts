import forge from 'node-forge';
import { sha } from '../crypto/hash';
import { expandObjectStreams } from '../encryption';
import { isDict, isRef, isStr, scanFile, type PObj } from '../syntax/pdfsyntax';
import { bytesToBin, nameOf } from './cms';

const { asn1, pki } = forge;

export type SignatureStatus = 'valid' | 'valid-untrusted' | 'modified-after-signing' | 'invalid';

export interface SignatureReport {
  fieldName: string;
  signer: string;
  issuer: string;
  signingTime?: string;
  reason?: string;
  location?: string;
  subFilter: string;
  /** The signed byte ranges reach the end of the file (nothing was appended after signing). */
  coversWholeFile: boolean;
  /** The hash of the signed bytes equals the hash recorded in the signature. */
  digestMatches: boolean;
  /** The signature over the signed attributes verifies with the signer's public key. */
  signatureValid: boolean;
  /** The signing certificate was within its validity period at the signing time. */
  certificateInDate: boolean;
  trust: 'trusted' | 'untrusted' | 'self-signed';
  status: SignatureStatus;
  problems: string[];
}

export interface VerifyOptions {
  /** Certificates you trust as roots/anchors. Without them every signature is reported as untrusted. */
  trustedRoots?: forge.pki.Certificate[];
}

const DIGESTS: Record<string, { name: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'; md: () => forge.md.MessageDigest }> = {
  '1.3.14.3.2.26': { name: 'SHA-1', md: forge.md.sha1.create },
  '2.16.840.1.101.3.4.2.1': { name: 'SHA-256', md: forge.md.sha256.create },
  '2.16.840.1.101.3.4.2.2': { name: 'SHA-384', md: forge.md.sha384.create },
  '2.16.840.1.101.3.4.2.3': { name: 'SHA-512', md: forge.md.sha512.create },
};

const asArray = (v: unknown) => v as forge.asn1.Asn1[];
const oidOf = (n: forge.asn1.Asn1) => asn1.derToOid(n.value as string);

/** Verify every embedded signature of a PDF (integrity, signature, certificate dates, trust, coverage). */
export async function verifySignatures(bytes: Uint8Array, opts: VerifyOptions = {}): Promise<SignatureReport[]> {
  const scan = scanFile(bytes);
  const objects = await expandObjectStreams(scan.objects);
  const sigs: { num: number; dict: Record<string, PObj> }[] = [];
  for (const [num, { obj }] of objects) {
    if (isDict(obj) && obj.dict.ByteRange && obj.dict.Contents && isStr(obj.dict.Contents) && (obj.dict.Type === undefined || (obj.dict.Type as { name?: string })?.name === 'Sig')) sigs.push({ num, dict: obj.dict });
  }
  const fieldNames = new Map<number, string>();
  for (const [, { obj }] of objects) {
    if (isDict(obj) && obj.dict.FT && (obj.dict.FT as { name?: string }).name === 'Sig' && obj.dict.V && isRef(obj.dict.V) && isStr(obj.dict.T ?? null)) fieldNames.set(obj.dict.V.ref[0], new TextDecoder('latin1').decode((obj.dict.T as { str: Uint8Array }).str));
  }

  const caStore = pki.createCaStore(opts.trustedRoots ?? []);
  const reports: SignatureReport[] = [];
  const ends = sigs.map((s) => {
    const br = s.dict.ByteRange as number[];
    return (br[2] ?? 0) + (br[3] ?? 0);
  });
  const lastEnd = Math.max(0, ...ends);

  for (const [i, s] of sigs.entries()) {
    const problems: string[] = [];
    const text = (o: PObj | undefined) => (o && isStr(o) ? decodeText(o.str) : undefined);
    const br = (s.dict.ByteRange as number[]).map(Number);
    const report: SignatureReport = {
      fieldName: fieldNames.get(s.num) ?? `signature ${i + 1}`,
      signer: '(unknown)',
      issuer: '',
      reason: text(s.dict.Reason),
      location: text(s.dict.Location),
      subFilter: (s.dict.SubFilter as { name?: string } | undefined)?.name ?? '',
      coversWholeFile: br.length === 4 && br[2]! + br[3]! === bytes.length,
      digestMatches: false,
      signatureValid: false,
      certificateInDate: false,
      trust: 'untrusted',
      status: 'invalid',
      problems,
    };
    try {
      if (br.length !== 4 || br[0] !== 0 || br[1]! + 0 > bytes.length || br[2]! + br[3]! > bytes.length) throw new Error('Invalid ByteRange');
      const signed = new Uint8Array(br[1]! + br[3]!);
      signed.set(bytes.subarray(0, br[1]!), 0);
      signed.set(bytes.subarray(br[2]!, br[2]! + br[3]!), br[1]!);
      const der = (s.dict.Contents as { str: Uint8Array }).str;
      const cms = asn1.fromDer(forge.util.createBuffer(bytesToBin(trimDer(der))));

      // ContentInfo { oid, [0] SignedData }
      const signedData = asArray(asArray(cms.value)[1]!.value)[0]!;
      const parts = asArray(signedData.value);
      const certNode = parts.find((p) => p.tagClass === asn1.Class.CONTEXT_SPECIFIC && p.type === 0);
      const certs = certNode ? asArray(certNode.value).map((c) => pki.certificateFromAsn1(c)) : [];
      const signerInfos = parts[parts.length - 1]!;
      const si = asArray(asArray(signerInfos.value)[0]!.value);
      const sid = asArray(si[1]!.value);
      const issuerDer = asn1.toDer(sid[0]!).getBytes();
      const serialHex = forge.util.bytesToHex(sid[1]!.value as string).replace(/^0+/, '');
      const signer = certs.find((c) => asn1.toDer(pki.distinguishedNameToAsn1(c.issuer)).getBytes() === issuerDer && c.serialNumber.replace(/^0+/, '') === serialHex);
      if (!signer) throw new Error('The signing certificate is not included in the signature');
      report.signer = nameOf(signer.subject.attributes);
      report.issuer = nameOf(signer.issuer.attributes);

      const digestOid = oidOf(asArray(si[2]!.value)[0]!);
      const algo = DIGESTS[digestOid];
      if (!algo) throw new Error(`Unsupported digest algorithm ${digestOid}`);
      const attrsNode = si.find((p) => p.tagClass === asn1.Class.CONTEXT_SPECIFIC && p.type === 0);
      if (!attrsNode) throw new Error('The signature has no signed attributes');
      const signature = (si[si.length - 1]!.value as string);

      // messageDigest attribute vs hash of the signed ranges
      let messageDigest = '';
      let signingTime: Date | undefined;
      for (const attr of asArray(attrsNode.value)) {
        const a = asArray(attr.value);
        const type = oidOf(a[0]!);
        const v = asArray(a[1]!.value)[0]!;
        if (type === '1.2.840.113549.1.9.4') messageDigest = v.value as string;
        if (type === '1.2.840.113549.1.9.5') signingTime = v.type === asn1.Type.UTCTIME ? asn1.utcTimeToDate(v.value as string) : asn1.generalizedTimeToDate(v.value as string);
      }
      const computed = bytesToBin(await sha(algo.name === 'SHA-1' ? 'SHA-256' : algo.name, signed)); // SHA-1 handled below
      let actual = computed;
      if (algo.name === 'SHA-1') {
        const md = forge.md.sha1.create();
        md.update(bytesToBin(signed));
        actual = md.digest().getBytes();
      }
      report.digestMatches = actual === messageDigest;
      if (!report.digestMatches) problems.push('The document content differs from what was signed');

      // signature over DER(SET OF signedAttrs)
      const setNode = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, asArray(attrsNode.value));
      const md = algo.md();
      md.update(asn1.toDer(setNode).getBytes());
      try {
        report.signatureValid = (signer.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), signature);
      } catch {
        report.signatureValid = false;
      }
      if (!report.signatureValid) problems.push('The signature does not match the signer’s public key');

      report.signingTime = signingTime?.toISOString();
      const when = signingTime ?? new Date();
      report.certificateInDate = when >= signer.validity.notBefore && when <= signer.validity.notAfter;
      if (!report.certificateInDate) problems.push('The certificate was not valid at the signing time');

      // trust: build a chain from the embedded certificates to a configured root
      const selfSigned = signer.isIssuer(signer);
      try {
        const ok = pki.verifyCertificateChain(caStore, [signer, ...certs.filter((c) => c !== signer)], { validityCheckDate: when });
        report.trust = ok === true ? 'trusted' : selfSigned ? 'self-signed' : 'untrusted';
      } catch {
        report.trust = selfSigned ? 'self-signed' : 'untrusted';
      }
      if (report.trust !== 'trusted') problems.push(report.trust === 'self-signed' ? 'The certificate is self-signed and not in your trusted list' : 'The certificate does not chain to a trusted root');
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }

    const isLast = (br[2] ?? 0) + (br[3] ?? 0) === lastEnd;
    if (!report.digestMatches || !report.signatureValid) report.status = 'invalid';
    else if (!report.certificateInDate) report.status = 'invalid';
    else if (isLast && !report.coversWholeFile) {
      report.status = 'modified-after-signing';
      problems.push('Bytes were added after the document was signed');
    } else report.status = report.trust === 'trusted' ? 'valid' : 'valid-untrusted';
    reports.push(report);
  }
  return reports;
}

function decodeText(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  return new TextDecoder('latin1').decode(b);
}

/** The signature field is zero-padded after the DER blob; cut it off using the outer length. */
function trimDer(b: Uint8Array): Uint8Array {
  if (b.length < 2 || b[0] !== 0x30) throw new Error('The signature is not a DER SEQUENCE');
  if (b[1]! < 0x80) return b.subarray(0, 2 + b[1]!);
  const n = b[1]! & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + b[2 + i]!;
  return b.subarray(0, 2 + n + len);
}
