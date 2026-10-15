import forge from 'node-forge';
import { sha } from '../crypto/hash';

const { asn1, pki } = forge;
const oids = (pki as unknown as { oids: Record<string, string> }).oids;
const U = asn1.Class.UNIVERSAL;
const T = asn1.Type;

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
};

const oid = (s: string) => asn1.create(U, T.OID, false, asn1.oidToDer(s).getBytes());
const seq = (...v: forge.asn1.Asn1[]) => asn1.create(U, T.SEQUENCE, true, v);
const set = (v: forge.asn1.Asn1[]) => asn1.create(U, T.SET, true, v);
const octets = (bin: string) => asn1.create(U, T.OCTETSTRING, false, bin);
const nul = () => asn1.create(U, T.NULL, false, '');
const algId = (o: string) => seq(oid(o), nul());

export const binToBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
export const bytesToBin = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

export interface SigningIdentity {
  certificate: forge.pki.Certificate;
  /** Intermediate/root certificates to embed (excluding the signer's own). */
  chain: forge.pki.Certificate[];
  privateKey: forge.pki.rsa.PrivateKey;
}

/** Load an RSA signing identity from a PKCS#12 (.pfx/.p12) file. */
export function loadPkcs12(data: Uint8Array, password: string): SigningIdentity {
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(forge.util.createBuffer(bytesToBin(data))), password);
  const bags = (type: string) => (p12.getBags({ bagType: type }) as Record<string, forge.pkcs12.Bag[] | undefined>)[type] ?? [];
  const keyBags = [...bags(oids.pkcs8ShroudedKeyBag!), ...bags(oids.keyBag!)];
  const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key || !('n' in key)) throw new Error('The file has no RSA private key (only RSA signing keys are supported)');
  const certs = bags(oids.certBag!).map((b) => b.cert!).filter(Boolean);
  const mine = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n.compareTo(key.n) === 0);
  if (!mine) throw new Error('The file has no certificate matching the private key');
  return { certificate: mine, chain: certs.filter((c) => c !== mine), privateKey: key };
}

const certDer = (c: forge.pki.Certificate) => asn1.toDer(pki.certificateToAsn1(c)).getBytes();

/**
 * Build a detached CMS SignedData (CAdES-style: contentType, signingTime, messageDigest and
 * ESS signing-certificate-v2 signed attributes, SHA-256 with RSA PKCS#1 v1.5).
 */
export async function buildCms(id: SigningIdentity, contentDigest: Uint8Array, signingTime: Date): Promise<Uint8Array> {
  const cert = id.certificate;
  const certHashBytes = await sha('SHA-256', binToBytes(certDer(cert)));

  const attrs: forge.asn1.Asn1[] = [
    seq(oid(OID.contentType), set([oid(OID.data)])),
    seq(oid(OID.signingTime), set([asn1.create(U, T.UTCTIME, false, asn1.dateToUtcTime(signingTime))])),
    seq(oid(OID.messageDigest), set([octets(bytesToBin(contentDigest))])),
    // ESSCertIDv2 { certHash } (the hash algorithm defaults to SHA-256)
    seq(oid(OID.signingCertificateV2), set([seq(seq(seq(octets(bytesToBin(certHashBytes)))))])),
  ];
  // DER requires the members of a SET OF to be sorted by their encodings
  const sorted = attrs.map((x) => ({ x, der: asn1.toDer(x).getBytes() })).sort((p, q) => (p.der < q.der ? -1 : p.der > q.der ? 1 : 0));
  const signedAttrsDer = asn1.toDer(set(sorted.map((e) => e.x))).getBytes();

  const md = forge.md.sha256.create();
  md.update(signedAttrsDer);
  const signature = id.privateKey.sign(md);

  const issuerAndSerial = seq(pki.distinguishedNameToAsn1(cert.issuer), asn1.create(U, T.INTEGER, false, forge.util.hexToBytes(cert.serialNumber.length % 2 ? '0' + cert.serialNumber : cert.serialNumber)));
  const signedAttrsImplicit = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, asn1.fromDer(signedAttrsDer).value as forge.asn1.Asn1[]);
  const signerInfo = seq(asn1.create(U, T.INTEGER, false, '\x01'), issuerAndSerial, algId(OID.sha256), signedAttrsImplicit, algId(OID.sha256WithRSA), octets(signature));

  const certs = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [cert, ...id.chain].map((c) => pki.certificateToAsn1(c)));
  const signedData = seq(asn1.create(U, T.INTEGER, false, '\x01'), set([algId(OID.sha256)]), seq(oid(OID.data)), certs, set([signerInfo]));
  const content = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [signedData]);
  return binToBytes(asn1.toDer(seq(oid(OID.signedData), content)).getBytes());
}

// ------------------------------------------------------------------ self-signed identities (tests, demos, internal PKI bootstrap)

export interface SelfSignedOptions {
  commonName: string;
  organization?: string;
  days?: number;
  keyBits?: number;
}

export function createSelfSignedIdentity(o: SelfSignedOptions): SigningIdentity {
  const keys = pki.rsa.generateKeyPair({ bits: o.keyBits ?? 2048, e: 0x10001 });
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + (o.days ?? 365) * 86_400_000);
  const attrs = [{ name: 'commonName', value: o.commonName }, ...(o.organization ? [{ name: 'organizationName', value: o.organization }] : [])];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certificate: cert, chain: [], privateKey: keys.privateKey };
}

export function identityToPkcs12(id: SigningIdentity, password: string): Uint8Array {
  const p12 = forge.pkcs12.toPkcs12Asn1(id.privateKey, [id.certificate, ...id.chain], password, { algorithm: '3des' });
  return binToBytes(asn1.toDer(p12).getBytes());
}

export const certificateToPem = (c: forge.pki.Certificate) => pki.certificateToPem(c);
export const certificateFromPem = (pem: string) => pki.certificateFromPem(pem);
/** Certificate from a PEM or DER file. */
export function certificateFromBytes(data: Uint8Array): forge.pki.Certificate {
  const text = new TextDecoder('latin1').decode(data);
  if (text.includes('-----BEGIN CERTIFICATE-----')) return pki.certificateFromPem(text);
  return pki.certificateFromAsn1(asn1.fromDer(bytesToBin(data)));
}

/** Common name (or the first available attribute) of a certificate subject/issuer. */
export function nameOf(attrs: forge.pki.CertificateField[]): string {
  const pick = (n: string) => attrs.find((a) => a.name === n)?.value as string | undefined;
  return pick('commonName') ?? pick('organizationName') ?? attrs.map((a) => String(a.value)).join(', ');
}

export { forge };
