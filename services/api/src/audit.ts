import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { GENESIS, hashEntry, verifyChain, type AuditEntry, type ChainCheck } from '@pdfsuite/security';

export interface AuditInput {
  user: string;
  action: string;
  doc?: { name: string; sha256: string };
  details?: Record<string, string | number | boolean>;
}

/**
 * Server-side, authoritative audit trail: the server assigns time, sequence and hashes, so clients cannot
 * rewrite history. Optionally persisted as JSON lines (append-only file).
 */
export class ServerAudit {
  private entries: AuditEntry[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.entries = readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AuditEntry);
    }
  }

  /** Appends are serialised so sequence numbers and hash links never interleave. */
  record(input: AuditInput): Promise<AuditEntry> {
    const run = async (): Promise<AuditEntry> => {
      const last = this.entries[this.entries.length - 1];
      const base: Omit<AuditEntry, 'hash'> = {
        seq: (last?.seq ?? 0) + 1,
        time: new Date().toISOString(),
        user: input.user,
        action: input.action,
        ...(input.doc ? { doc: input.doc } : {}),
        ...(input.details ? { details: input.details } : {}),
        prev: last?.hash ?? GENESIS,
      };
      const entry: AuditEntry = { ...base, hash: await hashEntry(base) };
      this.entries.push(entry);
      if (this.file) appendFileSync(this.file, JSON.stringify(entry) + '\n');
      return entry;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  list(offset = 0, limit = 200): AuditEntry[] {
    return this.entries.slice(offset, offset + limit);
  }

  get size() {
    return this.entries.length;
  }

  verify(): Promise<ChainCheck> {
    return verifyChain(this.entries);
  }
}
