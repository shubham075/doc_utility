import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer, type ServerConfig } from './server';
import { bigImagePdf, multipart } from './testutil';

const base: ServerConfig = { maxFileBytes: 5 * 1024 * 1024, toolTimeoutMs: 20_000, concurrency: 2, maxJobsPerUser: 3, resultTtlMs: 60_000, corsOrigins: [], tools: { soffice: null, browser: null } };

describe('audit trail', () => {
  it('records client events and job submissions, restricts reading to administrators and verifies the chain', async () => {
    const app = buildServer({ ...base, apiKeys: ['user-key'], adminKeys: ['admin-key'] });
    const user = { authorization: 'Bearer user-key' };
    const admin = { authorization: 'Bearer admin-key' };
    const sha = 'a'.repeat(64);
    const post = (body: unknown, headers: Record<string, string> = user) => app.inject({ method: 'POST', url: '/v1/audit', payload: body as object, headers });

    expect((await post({ action: 'document.redact', doc: { name: '..\\x/y.pdf', sha256: sha }, details: { glyphs: 12, note: 'ok', bad: { nested: 1 } } })).statusCode).toBe(201);
    expect((await post({ action: 'Bad Action!' })).statusCode).toBe(400);
    expect((await post({ action: 'document.open' }, {})).statusCode).toBe(401);

    const m = multipart({ name: 'a.pdf', data: await bigImagePdf() }, { options: JSON.stringify({ preset: 'low' }) });
    expect((await app.inject({ method: 'POST', url: '/v1/jobs/compress', payload: m.payload, headers: { ...m.headers, ...user } })).statusCode).toBe(202);

    expect((await app.inject({ method: 'GET', url: '/v1/audit', headers: user })).statusCode).toBe(403); // ordinary keys cannot read
    expect((await app.inject({ method: 'GET', url: '/v1/audit' })).statusCode).toBe(403);
    let list = (await app.inject({ method: 'GET', url: '/v1/audit', headers: admin })).json();
    for (let i = 0; i < 40 && list.total < 2; i++) {
      await new Promise((r) => setTimeout(r, 50)); // the job event is recorded asynchronously
      list = (await app.inject({ method: 'GET', url: '/v1/audit', headers: admin })).json();
    }
    expect(list.total).toBe(2);
    expect(list.entries[0]).toMatchObject({ seq: 1, action: 'document.redact', doc: { name: 'y.pdf', sha256: sha }, details: { glyphs: 12, note: 'ok' } });
    expect(list.entries[0].details.bad).toBeUndefined();
    expect(list.entries[0].user).toMatch(/^[0-9a-f]{16}$/);
    expect(list.entries[1]).toMatchObject({ seq: 2, action: 'job.compress' });
    expect((await app.inject({ method: 'GET', url: '/v1/audit/verify', headers: admin })).json()).toMatchObject({ ok: true, entries: 2 });
    await app.close();
  });

  it('persists to a JSON-lines file and detects tampering after a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'audit-')), 'audit.jsonl');
    const admin = { authorization: 'Bearer k' };
    const first = buildServer({ ...base, adminKeys: ['k'], auditFile: file });
    for (const action of ['document.open', 'document.sign']) await first.inject({ method: 'POST', url: '/v1/audit', payload: { action } });
    await first.close();

    const second = buildServer({ ...base, adminKeys: ['k'], auditFile: file });
    expect((await second.inject({ method: 'GET', url: '/v1/audit/verify', headers: admin })).json()).toMatchObject({ ok: true, entries: 2 });
    await second.close();

    writeFileSync(file, readFileSync(file, 'utf8').replace('document.sign', 'document.open'));
    const third = buildServer({ ...base, adminKeys: ['k'], auditFile: file });
    expect((await third.inject({ method: 'GET', url: '/v1/audit/verify', headers: admin })).json()).toMatchObject({ ok: false, brokenAt: 2 });
    await third.close();
  });
});
