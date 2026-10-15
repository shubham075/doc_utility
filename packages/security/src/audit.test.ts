import { describe, expect, it } from 'vitest';
import { AuditLog, GENESIS, LocalAuditStore, MemoryAuditStore, auditToCsv, canonicalJson, hashBytes, verifyChain, type AuditEntry } from './audit';

const clock = () => {
  let t = Date.UTC(2026, 0, 1);
  return () => new Date((t += 1000));
};

describe('audit log', () => {
  it('chains entries and verifies', async () => {
    const log = new AuditLog(new MemoryAuditStore(), () => 'alice', clock());
    const a = await log.record('document.open', { doc: { name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]) } });
    const b = await log.record('document.redact', { details: { glyphs: 12, pages: 2 } });
    expect(a).toMatchObject({ seq: 1, prev: GENESIS, user: 'alice', action: 'document.open', doc: { name: 'a.pdf', sha256: await hashBytes(new Uint8Array([1, 2, 3])) } });
    expect(b).toMatchObject({ seq: 2, prev: a.hash });
    expect(await log.verify()).toEqual({ ok: true });
    expect((await log.entries()).map((e) => e.action)).toEqual(['document.open', 'document.redact']);
  });

  it('serialises concurrent writes so the chain stays valid', async () => {
    const log = new AuditLog(new MemoryAuditStore(), () => 'u', clock());
    await Promise.all(Array.from({ length: 25 }, (_, i) => log.record('document.save', { details: { i } })));
    const entries = await log.entries();
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await verifyChain(entries)).toEqual({ ok: true });
  });

  it('detects edited, deleted, inserted and reordered entries', async () => {
    const log = new AuditLog(new MemoryAuditStore(), () => 'u', clock());
    for (const a of ['document.open', 'document.sign', 'document.redact', 'document.save']) await log.record(a);
    const good = await log.entries();

    const edited = structuredClone(good);
    edited[1]!.user = 'mallory';
    expect(await verifyChain(edited)).toMatchObject({ ok: false, brokenAt: 2, reason: expect.stringMatching(/modified/) });

    const deleted = good.filter((e) => e.seq !== 2);
    expect(await verifyChain(deleted)).toMatchObject({ ok: false, brokenAt: 3 });

    const swapped = [good[0]!, good[2]!, good[1]!, good[3]!];
    expect((await verifyChain(swapped)).ok).toBe(false);

    const forged = structuredClone(good);
    forged[3]!.action = 'document.export';
    expect((await verifyChain(forged)).ok).toBe(false);

    const truncatedTail = good.slice(0, 3); // dropping the newest entries is only detectable against a server copy
    expect((await verifyChain(truncatedTail)).ok).toBe(true);
  });

  it('hashes independently of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  it('persists in browser-style storage and caps its size', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const log = new AuditLog(new LocalAuditStore(storage, 'k', 3), () => 'u', clock());
    for (let i = 0; i < 5; i++) await log.record('document.open', { details: { i } });
    const kept = JSON.parse(mem.get('k')!) as AuditEntry[];
    expect(kept.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(storage.getItem('missing')).toBeNull();
  });

  it('exports CSV with quoting and spreadsheet-formula protection', async () => {
    const log = new AuditLog(new MemoryAuditStore(), () => '=cmd|calc', clock());
    await log.record('document.open', { doc: { name: 'we "like", commas.pdf' } });
    const csv = auditToCsv(await log.entries());
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe('seq,time,user,action,document,sha256,details,hash');
    expect(row).toContain("'=cmd|calc");
    expect(row).toContain('"we ""like"", commas.pdf"');
  });
});
