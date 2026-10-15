import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry, ChainCheck, Findings, Permissions, RedactReport, RedactionMark, SanitizeOptions, SanitizeResult, SignatureReport } from '@pdfsuite/security';
import { Footer, Modal, useRun } from './PageToolDialogs';
import { PATTERNS, compileQuery, findPatterns, type PatternKind } from './redactPatterns';
import type { Rect, TextSource } from './search';

export interface ProtectRequest {
  userPassword: string;
  ownerPassword: string;
  permissions: Permissions;
}

export type SignIdentity = { kind: 'pfx'; file: File; password: string } | { kind: 'self-signed'; commonName: string };

export interface SignRequest {
  identity: SignIdentity;
  reason: string;
  location: string;
  /** Visible signature: page (0-based) and rectangle in display space; omitted = invisible. */
  visible?: { page: number; rect: Rect };
}

/** Everything the security tools need from the host application. */
export interface SecurityTools {
  busy: boolean;
  /** What the current user may do with this document (all true unless opened with only the user password). */
  permissions: Permissions;
  /** The file will be encrypted when saved. */
  protection: { hasUserPassword: boolean; ownerKnown: boolean } | null;
  signed: boolean;
  onProtect(r: ProtectRequest): Promise<void>;
  onRemoveProtection(): Promise<void>;
  examine(): Promise<Findings>;
  onSanitize(o: SanitizeOptions): Promise<SanitizeResult['removed']>;
  onApplyRedactions(marks: RedactionMark[]): Promise<RedactReport>;
  onSign(r: SignRequest): Promise<void>;
  verify(): Promise<SignatureReport[]>;
  trusted: string[];
  onAddTrust(file: File): Promise<void>;
  onRemoveTrust(index: number): void;
  auditEntries(): Promise<AuditEntry[]>;
  auditVerify(): Promise<ChainCheck>;
  onAuditExport(): Promise<void>;
}

export type SecurityDialogKind = 'protect' | 'sanitize' | 'redact' | 'sign' | 'signatures' | 'audit';

interface Common {
  tools: SecurityTools;
  onClose(): void;
}

const PERMISSION_LABELS: [keyof Permissions, string][] = [
  ['print', 'Printing'],
  ['printHighQuality', 'High-quality printing'],
  ['modify', 'Editing content'],
  ['assemble', 'Page assembly (insert, delete, rotate)'],
  ['annotate', 'Comments and annotations'],
  ['fillForms', 'Filling form fields'],
  ['copy', 'Copying text and images'],
  ['accessibility', 'Screen-reader access'],
];

const ALLOWED: Permissions = { print: true, printHighQuality: true, modify: true, copy: true, annotate: true, fillForms: true, accessibility: true, assemble: true };

// ---------------------------------------------------------------- protect

export function ProtectDialog({ tools, onClose }: Common) {
  const [userPw, setUserPw] = useState('');
  const [ownerPw, setOwnerPw] = useState('');
  const [requireOpen, setRequireOpen] = useState(false);
  const [perms, setPerms] = useState<Permissions>(tools.permissions);
  const { error, running, run } = useRun(onClose);
  const [localError, setLocalError] = useState<string | null>(null);

  const apply = () => {
    if (!ownerPw) return setLocalError('Choose a permissions password: it is needed to change or remove the restrictions.');
    if (requireOpen && !userPw) return setLocalError('Enter the password people must type to open the document.');
    if (requireOpen && userPw === ownerPw) return setLocalError('The two passwords must differ, otherwise opening the file would grant full access.');
    setLocalError(null);
    void run(() => tools.onProtect({ userPassword: requireOpen ? userPw : '', ownerPassword: ownerPw, permissions: perms }));
  };

  return (
    <Modal title="Protect with password" onClose={onClose} wide>
      <p className="pv-muted">AES-256 encryption is applied when you save. {tools.signed && 'This file is signed: protecting it invalidates the signatures.'}</p>
      <label>
        <input type="checkbox" checked={requireOpen} onChange={(e) => setRequireOpen(e.target.checked)} /> Require a password to open the document
      </label>
      {requireOpen && <input className="pv-search-input" type="password" autoComplete="new-password" value={userPw} onChange={(e) => setUserPw(e.target.value)} placeholder="Open password" aria-label="Open password" />}
      <input className="pv-search-input" type="password" autoComplete="new-password" value={ownerPw} onChange={(e) => setOwnerPw(e.target.value)} placeholder="Permissions password" aria-label="Permissions password" />
      <fieldset className="pv-fieldset">
        <legend>Allowed actions</legend>
        {PERMISSION_LABELS.map(([k, label]) => (
          <label key={k} className="pv-check">
            <input type="checkbox" checked={perms[k]} onChange={(e) => setPerms({ ...perms, [k]: e.target.checked })} /> {label}
          </label>
        ))}
      </fieldset>
      <p className="pv-muted">Restrictions are honoured by compliant viewers; they are not a defence against someone who can crack the file offline. Keep the passwords safe: they cannot be recovered.</p>
      {tools.protection && tools.protection.ownerKnown && (
        <div className="pv-search-row">
          <span className="pv-muted">This document is currently protected.</span>
          <button onClick={() => void run(() => tools.onRemoveProtection())} disabled={running}>
            Remove protection
          </button>
        </div>
      )}
      <Footer error={localError ?? error} running={running} onClose={onClose} action="Apply protection" onAction={apply} />
    </Modal>
  );
}

// ---------------------------------------------------------------- sanitize

const SANITIZE_ROWS: { key: keyof SanitizeOptions; label: string; count?: (f: Findings) => string | null }[] = [
  { key: 'metadata', label: 'Document properties and XMP metadata', count: (f) => (Object.keys(f.metadata.infoFields).length || f.metadata.xmp ? `${Object.keys(f.metadata.infoFields).length} fields${f.metadata.xmp ? ' + XMP' : ''}` : null) },
  { key: 'javascript', label: 'JavaScript and launch actions', count: (f) => { const n = f.javascript.documentLevel + f.javascript.fieldActions + f.javascript.annotationActions + (f.javascript.openAction ? 1 : 0); return n ? `${n} found` : null; } },
  { key: 'attachments', label: 'Embedded files', count: (f) => (f.attachments.length ? f.attachments.join(', ') : null) },
  { key: 'comments', label: 'Comments and markup', count: (f) => (f.annotations.comments ? `${f.annotations.comments} found` : null) },
  { key: 'links', label: 'Links', count: (f) => (f.annotations.links ? `${f.annotations.links} (${f.externalLinks} external)` : null) },
  { key: 'bookmarks', label: 'Bookmarks', count: (f) => (f.bookmarks ? `${f.bookmarks} found` : null) },
  { key: 'thumbnails', label: 'Page thumbnails', count: (f) => (f.thumbnails ? `${f.thumbnails} found` : null) },
  { key: 'privateData', label: 'Application private data', count: (f) => (f.privateData ? 'found' : null) },
  { key: 'flattenForms', label: 'Flatten form fields into the page', count: (f) => (f.formFields ? `${f.formFields} fields` : null) },
];

export function SanitizeDialog({ tools, onClose }: Common) {
  const [findings, setFindings] = useState<Findings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opts, setOpts] = useState<SanitizeOptions>({ metadata: true, javascript: true, attachments: true, comments: true, links: false, bookmarks: false, thumbnails: true, privateData: true, flattenForms: false });
  const [done, setDone] = useState<string | null>(null);
  const { error, running, run } = useRun(() => undefined);

  useEffect(() => {
    tools.examine().then(setFindings, (e) => setLoadError(String(e)));
  }, [tools]);

  const apply = () =>
    run(async () => {
      const removed = await tools.onSanitize(opts);
      const n = Object.values(removed).reduce((a, b) => a + (b ?? 0), 0);
      setDone(n ? `Removed ${n} item(s). Save the document to keep the result.` : 'Nothing to remove.');
    });

  return (
    <Modal title="Examine and sanitize" onClose={onClose} wide>
      {loadError && <div className="pv-error">{loadError}</div>}
      {!findings && !loadError && <p className="pv-muted">Examining…</p>}
      {findings && (
        <>
          {findings.previousVersions && <div className="pv-warn">This file contains earlier revisions (incremental saves). Content you deleted may still be recoverable: saving a fresh copy discards them.</div>}
          <table className="pv-table">
            <tbody>
              {SANITIZE_ROWS.map((r) => {
                const c = r.count?.(findings) ?? null;
                return (
                  <tr key={r.key}>
                    <td>
                      <label>
                        <input type="checkbox" checked={opts[r.key]} onChange={(e) => setOpts({ ...opts, [r.key]: e.target.checked })} /> {r.label}
                      </label>
                    </td>
                    <td className="pv-muted">{c ?? 'none'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {Object.keys(findings.metadata.infoFields).length > 0 && (
            <details>
              <summary>Properties that would be removed</summary>
              <ul>
                {Object.entries(findings.metadata.infoFields).map(([k, v]) => (
                  <li key={k}>
                    <strong>{k}</strong>: {v}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {done && <div role="status" className="pv-ok">{done}</div>}
      <Footer error={error} running={running} onClose={onClose} action="Sanitize" onAction={() => void apply()} disabled={!findings || !!done} />
    </Modal>
  );
}

// ---------------------------------------------------------------- redact

export function RedactDialog({
  tools,
  textSource,
  markCount,
  onMark,
  onClose,
  collectMarks,
}: Common & {
  textSource: TextSource | null;
  markCount: number;
  onMark(page: number, rects: Rect[]): void;
  collectMarks(): RedactionMark[];
}) {
  const [kinds, setKinds] = useState<PatternKind[]>([]);
  const [words, setWords] = useState('');
  const [regex, setRegex] = useState('');
  const [scan, setScan] = useState<{ running: boolean; found: number; error?: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [report, setReport] = useState<RedactReport | null>(null);
  const cancel = useRef<AbortController | null>(null);
  const { error, running, run } = useRun(() => undefined);
  useEffect(() => () => cancel.current?.abort(), []);

  const find = async () => {
    if (!textSource) return;
    let compiled;
    try {
      compiled = compileQuery({ kinds, words: words.split('\n'), regex });
    } catch (e) {
      return setScan({ running: false, found: 0, error: e instanceof Error ? e.message : String(e) });
    }
    if (!compiled.length) return setScan({ running: false, found: 0, error: 'Choose a pattern or enter text to look for.' });
    const ac = new AbortController();
    cancel.current = ac;
    setScan({ running: true, found: 0 });
    let found = 0;
    for (let p = 0; p < textSource.pageCount && !ac.signal.aborted; p++) {
      const items = await textSource.getItems(p).catch(() => []);
      for (const m of findPatterns(p, items, compiled)) {
        onMark(p, m.rects);
        found++;
      }
      setScan({ running: true, found });
    }
    setScan({ running: false, found });
  };

  const apply = () =>
    run(async () => {
      const marks = collectMarks();
      setReport(await tools.onApplyRedactions(marks));
    });

  return (
    <Modal title="Redact" onClose={onClose} wide>
      {report ? (
        <>
          <div role="status" className="pv-ok">
            Redaction applied on {report.pages} page(s): {report.glyphsRemoved} characters, {report.imagesRedacted + report.imagesRemoved + report.inlineImagesRemoved} images, {report.pathsRemoved} vector shapes and {report.annotationsRemoved} annotations were permanently removed. Save the document to keep the result.
          </div>
          <div className="pv-search-row">
            <span className="pv-spacer" />
            <button className="pv-primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="pv-muted">Mark areas with the Redact tools (text selection or area), or find sensitive text automatically. Nothing is removed until you apply.</p>
          <fieldset className="pv-fieldset">
            <legend>Find and mark</legend>
            {(Object.keys(PATTERNS) as PatternKind[]).map((k) => (
              <label key={k} className="pv-check">
                <input type="checkbox" checked={kinds.includes(k)} onChange={(e) => setKinds(e.target.checked ? [...kinds, k] : kinds.filter((x) => x !== k))} /> {PATTERNS[k].label}
              </label>
            ))}
            <textarea className="pv-search-input" rows={2} value={words} onChange={(e) => setWords(e.target.value)} placeholder="Words or phrases, one per line" aria-label="Words or phrases" />
            <input className="pv-search-input" value={regex} onChange={(e) => setRegex(e.target.value)} placeholder="Regular expression (optional)" aria-label="Regular expression" />
            <div className="pv-search-row">
              <button onClick={() => void find()} disabled={!textSource || scan?.running}>
                {scan?.running ? 'Searching…' : 'Find and mark all'}
              </button>
              {scan?.running && <button onClick={() => cancel.current?.abort()}>Stop</button>}
              {scan && !scan.error && <span className="pv-muted">{scan.found} match(es) marked</span>}
            </div>
            {scan?.error && <div className="pv-error">{scan.error}</div>}
          </fieldset>
          <p>
            <strong>{markCount}</strong> area(s) marked for redaction.
          </p>
          <label className="pv-check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand that applying redaction permanently removes the marked content and cannot be undone after saving.
          </label>
          <Footer error={error} running={running} onClose={onClose} action="Apply redactions" onAction={() => void apply()} disabled={!markCount || !confirm} />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- sign

type Place = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center';

export function SignDialog({ tools, pageCount, currentPage, pageSizes, onClose }: Common & { pageCount: number; currentPage: number; pageSizes: { width: number; height: number }[] }) {
  const [source, setSource] = useState<'pfx' | 'self-signed'>('pfx');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [visible, setVisible] = useState(true);
  const [page, setPage] = useState(currentPage);
  const [place, setPlace] = useState<Place>('bottom-right');
  const { error, running, run } = useRun(onClose);
  const [localError, setLocalError] = useState<string | null>(null);

  const rect = useMemo((): Rect => {
    const s = pageSizes[page] ?? { width: 612, height: 792 };
    const w = Math.min(200, s.width - 40);
    const h = 64;
    const m = 36;
    const x = place.endsWith('left') ? m : place === 'center' ? (s.width - w) / 2 : s.width - w - m;
    const y = place.startsWith('top') ? m : place === 'center' ? (s.height - h) / 2 : s.height - h - m;
    return { x, y, width: w, height: h };
  }, [page, place, pageSizes]);

  const sign = () => {
    if (tools.protection) return setLocalError('Signing is not possible while the file is set to be password-protected. Sign first, or remove the protection.');
    if (source === 'pfx' && !file) return setLocalError('Choose a certificate file (.pfx or .p12).');
    if (source === 'self-signed' && !name.trim()) return setLocalError('Enter the name for the test certificate.');
    setLocalError(null);
    void run(() =>
      tools.onSign({
        identity: source === 'pfx' ? { kind: 'pfx', file: file!, password } : { kind: 'self-signed', commonName: name.trim() },
        reason: reason.trim(),
        location: location.trim(),
        visible: visible ? { page, rect } : undefined,
      }),
    );
  };

  return (
    <Modal title="Sign with a certificate" onClose={onClose} wide>
      {tools.signed && <div className="pv-warn">This document already has signatures. They stay valid: the new signature is added as an update.</div>}
      <div className="pv-tabs" role="tablist">
        <button role="tab" aria-selected={source === 'pfx'} onClick={() => setSource('pfx')}>
          Certificate file
        </button>
        <button role="tab" aria-selected={source === 'self-signed'} onClick={() => setSource('self-signed')}>
          Test certificate
        </button>
      </div>
      {source === 'pfx' ? (
        <>
          <input type="file" accept=".pfx,.p12" aria-label="Certificate file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <input className="pv-search-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Certificate password" aria-label="Certificate password" />
          <p className="pv-muted">The file and password are used once in this browser to sign; they are neither stored nor uploaded.</p>
        </>
      ) : (
        <>
          <input className="pv-search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name on the certificate" aria-label="Name on the certificate" />
          <p className="pv-muted">Creates a throw-away self-signed certificate. Recipients will see the signature as untrusted: use it for testing only.</p>
        </>
      )}
      <input className="pv-search-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" />
      <input className="pv-search-input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" aria-label="Location" />
      <label className="pv-check">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Show the signature on a page
      </label>
      {visible && (
        <div className="pv-search-row">
          <label>
            Page{' '}
            <select value={page} onChange={(e) => setPage(Number(e.target.value))} aria-label="Signature page">
              {Array.from({ length: pageCount }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}
                </option>
              ))}
            </select>
          </label>
          <label>
            Position{' '}
            <select value={place} onChange={(e) => setPlace(e.target.value as Place)} aria-label="Signature position">
              <option value="bottom-right">Bottom right</option>
              <option value="bottom-left">Bottom left</option>
              <option value="top-right">Top right</option>
              <option value="top-left">Top left</option>
              <option value="center">Centre</option>
            </select>
          </label>
        </div>
      )}
      <p className="pv-muted">Any change made after signing (including saving through the editor) invalidates the signature, so sign last.</p>
      <Footer error={localError ?? error} running={running} onClose={onClose} action="Sign" onAction={sign} />
    </Modal>
  );
}

// ---------------------------------------------------------------- signatures panel

const STATUS_TEXT: Record<SignatureReport['status'], { label: string; cls: string }> = {
  valid: { label: 'Valid', cls: 'pv-ok' },
  'valid-untrusted': { label: 'Intact, signer not trusted', cls: 'pv-warn' },
  'modified-after-signing': { label: 'Document changed after signing', cls: 'pv-warn' },
  invalid: { label: 'Invalid', cls: 'pv-error' },
};

export function SignaturesDialog({ tools, onClose }: Common) {
  const [reports, setReports] = useState<SignatureReport[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setReports(null);
    tools.verify().then(setReports, (e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [tools.verify, tools.trusted]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title="Signatures" onClose={onClose} wide>
      {err && <div className="pv-error">{err}</div>}
      {!reports && !err && <p className="pv-muted">Verifying…</p>}
      {reports && reports.length === 0 && <p className="pv-muted">This document has no signatures.</p>}
      {reports?.map((r, i) => {
        const s = STATUS_TEXT[r.status];
        return (
          <div key={i} className="pv-sigcard">
            <div className={s.cls}>
              <strong>{s.label}</strong> — {r.fieldName}
            </div>
            <div>Signed by {r.signer} (issuer {r.issuer})</div>
            {r.signingTime && <div className="pv-muted">Claimed signing time: {r.signingTime}</div>}
            {r.reason && <div className="pv-muted">Reason: {r.reason}</div>}
            {r.location && <div className="pv-muted">Location: {r.location}</div>}
            {r.problems.length > 0 && (
              <ul>
                {r.problems.map((p, k) => (
                  <li key={k}>{p}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <fieldset className="pv-fieldset">
        <legend>Trusted certificates</legend>
        {tools.trusted.length === 0 && <p className="pv-muted">None. Add the certificate (PEM) of your organisation's root to have its signatures show as trusted.</p>}
        {tools.trusted.map((t, i) => (
          <div key={i} className="pv-search-row">
            <span>{t}</span>
            <span className="pv-spacer" />
            <button onClick={() => tools.onRemoveTrust(i)}>Remove</button>
          </div>
        ))}
        <input
          type="file"
          accept=".pem,.crt,.cer"
          aria-label="Add trusted certificate"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) tools.onAddTrust(f).then(() => setAddError(null), (er) => setAddError(er instanceof Error ? er.message : String(er)));
          }}
        />
        {addError && <div className="pv-error">{addError}</div>}
      </fieldset>
      <div className="pv-search-row">
        <span className="pv-spacer" />
        <button className="pv-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- audit

export function AuditDialog({ tools, onClose }: Common) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [check, setCheck] = useState<ChainCheck | null>(null);

  useEffect(() => {
    void tools.auditEntries().then((e) => setEntries(e.slice().reverse()));
    void tools.auditVerify().then(setCheck);
  }, [tools]);

  return (
    <Modal title="Audit log" onClose={onClose} wide>
      <div className="pv-search-row">
        {check && (check.ok ? <span className="pv-ok">Chain intact</span> : <span className="pv-error">Tampering detected at entry {check.brokenAt}: {check.reason}</span>)}
        <span className="pv-spacer" />
        <button onClick={() => void tools.onAuditExport()}>Export CSV</button>
      </div>
      <div className="pv-table-scroll">
        <table className="pv-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Document</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{e.time.replace('T', ' ').slice(0, 19)}</td>
                <td>{e.user}</td>
                <td>{e.action}{e.details ? ` (${Object.entries(e.details).map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}</td>
                <td>{e.doc?.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries?.length === 0 && <p className="pv-muted">No events yet.</p>}
      </div>
      <p className="pv-muted">The log is stored in this browser and hash-chained, so edits to earlier entries are detected. Deleting the newest entries is only detectable against the server's copy.</p>
      <div className="pv-search-row">
        <span className="pv-spacer" />
        <button className="pv-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

export { ALLOWED as ALL_ALLOWED };
