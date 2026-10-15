import { sha, toHex, utf8 } from './crypto/hash';

export type AuditAction =
  | 'document.open'
  | 'document.save'
  | 'document.encrypt'
  | 'document.decrypt'
  | 'document.sign'
  | 'document.redact'
  | 'document.sanitize'
  | 'document.export'
  | 'document.print'
  | 'document.convert'
  | (string & {});

export interface AuditEntry {
  /** 1-based position in the log. */
  seq: number;
  /** ISO-8601 time the entry was recorded. */
  time: string;
  user: string;
  action: AuditAction;
  doc?: { name: string; sha256: string };
  details?: Record<string, string | number | boolean>;
  /** Hash of the previous entry ('0' x 64 for the first). */
  prev: string;
  /** SHA-256 over `prev` and this entry's content: editing or removing any earlier entry breaks every later hash. */
  hash: string;
}

export const GENESIS = '0'.repeat(64);

/** Stable JSON: object keys sorted, so the hash does not depend on key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export async function hashEntry(e: Omit<AuditEntry, 'hash'>): Promise<string> {
  return toHex(new Uint8Array(await sha('SHA-256', utf8(e.prev + canonicalJson(e)))));
}

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  return toHex(await sha('SHA-256', bytes));
}

export interface ChainCheck {
  ok: boolean;
  /** Sequence number of the first entry that does not fit the chain. */
  brokenAt?: number;
  reason?: string;
}

/** Check seq numbers, prev links and every hash. */
export async function verifyChain(entries: readonly AuditEntry[]): Promise<ChainCheck> {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i]!;
    if (rest.seq !== i + 1) return { ok: false, brokenAt: rest.seq, reason: 'Missing or reordered entry' };
    if (rest.prev !== prev) return { ok: false, brokenAt: rest.seq, reason: 'Chain link does not match the previous entry' };
    if ((await hashEntry(rest)) !== hash) return { ok: false, brokenAt: rest.seq, reason: 'Entry content was modified' };
    prev = hash;
  }
  return { ok: true };
}

export interface AuditStore {
  load(): Promise<AuditEntry[]>;
  append(entry: AuditEntry): Promise<void>;
}

export class MemoryAuditStore implements AuditStore {
  constructor(private readonly items: AuditEntry[] = []) {}
  async load() {
    return [...this.items];
  }
  async append(e: AuditEntry) {
    this.items.push(e);
  }
}

/** Browser storage; keeps the newest `max` entries (older ones are shipped to the server log when one is configured). */
export class LocalAuditStore implements AuditStore {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly key = 'pdfsuite.audit',
    private readonly max = 5000,
  ) {}
  async load() {
    try {
      return JSON.parse(this.storage.getItem(this.key) ?? '[]') as AuditEntry[];
    } catch {
      return [];
    }
  }
  async append(e: AuditEntry) {
    const all = await this.load();
    all.push(e);
    try {
      this.storage.setItem(this.key, JSON.stringify(all.slice(-this.max)));
    } catch {
      /* storage full or blocked: the log is best effort locally */
    }
  }
}

/** Tamper-evident, append-only log of security-relevant actions. */
export class AuditLog {
  private lock: Promise<unknown> = Promise.resolve();
  /** Called after each entry is stored (e.g. to forward it to a server). */
  onEntry?: (e: AuditEntry) => void;

  constructor(
    private readonly store: AuditStore,
    private readonly user: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Entries are appended strictly one after another so the chain stays consistent. */
  record(action: AuditAction, info: { doc?: { name: string; bytes?: Uint8Array }; details?: AuditEntry['details'] } = {}): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      const existing = await this.store.load();
      const last = existing[existing.length - 1];
      const base: Omit<AuditEntry, 'hash'> = {
        seq: (last?.seq ?? 0) + 1,
        time: this.now().toISOString(),
        user: this.user(),
        action,
        ...(info.doc ? { doc: { name: info.doc.name, sha256: info.doc.bytes ? await hashBytes(info.doc.bytes) : '' } } : {}),
        ...(info.details ? { details: info.details } : {}),
        prev: last?.hash ?? GENESIS,
      };
      const entry: AuditEntry = { ...base, hash: await hashEntry(base) };
      await this.store.append(entry);
      this.onEntry?.(entry);
      return entry;
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }

  entries() {
    return this.store.load();
  }

  async verify(): Promise<ChainCheck> {
    return verifyChain(await this.store.load());
  }
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  // neutralise spreadsheet formula injection as well as quoting
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function auditToCsv(entries: readonly AuditEntry[]): string {
  const head = ['seq', 'time', 'user', 'action', 'document', 'sha256', 'details', 'hash'];
  const rows = entries.map((e) => [e.seq, e.time, e.user, e.action, e.doc?.name, e.doc?.sha256, e.details ? canonicalJson(e.details) : '', e.hash].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\n') + '\n';
}
