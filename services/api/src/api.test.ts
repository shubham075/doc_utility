import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createPdfiumEngine, type PdfEngine } from '@pdfsuite/engine';
import { PDFDocument } from 'pdf-lib';

// Office conversion is faked at the process boundary: the fake "soffice" validates how it is invoked and writes a PDF.
vi.mock('./tools', async (orig) => {
  const real = await orig<typeof import('./tools')>();
  return {
    ...real,
    runTool: vi.fn(async (command: string, args: readonly string[], opts: Parameters<typeof real.runTool>[2]) => {
      if (command !== 'FAKE_SOFFICE') return real.runTool(command, args, opts);
      const a = [...args];
      const calls = ((globalThis as Record<string, unknown>).__sofficeCalls ??= []) as string[][];
      calls.push(a);
      const outdir = a[a.indexOf('--outdir') + 1]!;
      const input = a[a.length - 1]!;
      if ((await readFile(input, 'utf8')) === 'BROKEN') return { code: 1, stdout: '', stderr: 'Error: source file could not be loaded', timedOut: false };
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      await mkdir(outdir, { recursive: true });
      await writeFile(join(outdir, 'input.pdf'), await doc.save());
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }),
  };
});

import { buildServer, cleanName, configFromEnv, type ApiServer, type ServerConfig } from './server';
import { bigImagePdf, multipart, scannedPdf } from './testutil';
import { findTools } from './tools';
import { htmlToPdf, isolateHtml } from './converters';

const base: ServerConfig = { maxFileBytes: 5 * 1024 * 1024, toolTimeoutMs: 20_000, concurrency: 2, maxJobsPerUser: 3, resultTtlMs: 60_000, corsOrigins: ['http://localhost:5173'], tools: { soffice: 'FAKE_SOFFICE', browser: null } };

let pdfium: PdfEngine;
beforeAll(async () => {
  pdfium = await createPdfiumEngine();
});
afterAll(async () => pdfium.dispose());

async function submit(app: ApiServer, kind: string, file: { name: string; data: Uint8Array } | null, options?: object, headers: Record<string, string> = {}) {
  const m = multipart(file, options ? { options: JSON.stringify(options) } : {});
  return app.inject({ method: 'POST', url: `/v1/jobs/${kind}`, payload: m.payload, headers: { ...m.headers, ...headers } });
}

async function finish(app: ApiServer, id: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 400; i++) {
    const r = await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers });
    const j = r.json();
    if (['done', 'failed', 'canceled'].includes(j.state)) return j as { state: string; error?: string; progress: number };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job did not finish');
}

describe('API basics', () => {
  it('reports capabilities and limits', async () => {
    const app = buildServer(base);
    const r = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(r.capabilities).toMatchObject({ 'office-to-pdf': true, 'html-to-pdf': false, compress: true, ocr: true });
    expect(r.limits.extensions).toContain('.docx');
    await app.close();
  });

  it('rejects unknown job types, missing files, wrong file types and unavailable converters', async () => {
    const app = buildServer(base);
    const pdf = await bigImagePdf();
    expect((await submit(app, 'nope', { name: 'a.pdf', data: pdf })).statusCode).toBe(404);
    expect((await submit(app, 'compress', null)).statusCode).toBe(400);
    expect((await submit(app, 'compress', { name: 'a.pdf', data: new TextEncoder().encode('not a pdf') })).statusCode).toBe(415);
    const html = await submit(app, 'html-to-pdf', { name: 'a.html', data: new TextEncoder().encode('<p>x</p>') });
    expect(html.statusCode).toBe(501);
    expect(html.json().error).toMatch(/not available/);
    await app.close();
  });

  it('enforces the upload size limit', async () => {
    const app = buildServer({ ...base, maxFileBytes: 1000 });
    const r = await submit(app, 'compress', { name: 'big.pdf', data: await bigImagePdf() });
    expect(r.statusCode).toBe(413);
    await app.close();
  });

  it('cleans client file names', () => {
    expect(cleanName('..\\..\\evil\\a:b*c.pdf')).toBe('a_b_c.pdf');
    expect(cleanName('/etc/passwd')).toBe('passwd');
    expect(cleanName('')).toBe('document');
  });

  it('reads configuration from the environment', () => {
    const c = configFromEnv({ API_KEYS: 'a, b', MAX_FILE_MB: '3', CONCURRENCY: '5' } as NodeJS.ProcessEnv);
    expect(c).toMatchObject({ apiKeys: ['a', 'b'], maxFileBytes: 3 * 1024 * 1024, concurrency: 5 });
  });
});

describe('authentication and job ownership', () => {
  it('requires a valid bearer token and isolates users', async () => {
    const app = buildServer({ ...base, apiKeys: ['key-one', 'key-two'] });
    const file = { name: 'a.pdf', data: await bigImagePdf() };
    expect((await submit(app, 'compress', file)).statusCode).toBe(401);
    expect((await submit(app, 'compress', file, {}, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    const ok = await submit(app, 'compress', file, { preset: 'low' }, { authorization: 'Bearer key-one' });
    expect(ok.statusCode).toBe(202);
    const id = ok.json().id as string;
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers: { authorization: 'Bearer key-two' } })).statusCode).toBe(404); // another user's job
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${id}` })).statusCode).toBe(401);
    expect((await finish(app, id, { authorization: 'Bearer key-one' })).state).toBe('done');
    await app.close();
  });

  it('limits active jobs per user', async () => {
    const app = buildServer({ ...base, concurrency: 1, maxJobsPerUser: 1 });
    const file = { name: 'a.pdf', data: await scannedPdf('Queue limit') };
    const first = await submit(app, 'ocr', file, { dpi: 100 });
    expect(first.statusCode).toBe(202);
    expect((await submit(app, 'compress', { name: 'b.pdf', data: await bigImagePdf() })).statusCode).toBe(429);
    await finish(app, first.json().id);
    await app.close();
  }, 60_000);
});

describe('jobs', () => {
  it('compresses a PDF and serves the result as a download', async () => {
    const app = buildServer(base);
    const src = await bigImagePdf();
    const sub = await submit(app, 'compress', { name: 'photo scan.pdf', data: src }, { preset: 'low', stripMetadata: true });
    expect(sub.statusCode).toBe(202);
    const id = sub.json().id as string;
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result` })).statusCode).toBeLessThan(500);
    const final = await finish(app, id);
    expect(final).toMatchObject({ state: 'done', progress: 1 });
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('photo scan-optimized.pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.length).toBeLessThan(src.length * 0.5);
    expect((await PDFDocument.load(res.rawPayload)).getPageCount()).toBe(1);
    await app.close();
  });

  it('runs OCR and returns a searchable PDF', async () => {
    const app = buildServer(base);
    const sub = await submit(app, 'ocr', { name: 'scan.pdf', data: await scannedPdf('Purchase Order 7731') }, { dpi: 200 });
    expect(sub.statusCode).toBe(202);
    const id = sub.json().id as string;
    expect((await finish(app, id)).state).toBe('done');
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result` });
    const doc = await pdfium.open(new Uint8Array(res.rawPayload));
    const page = await doc.getPage(0);
    const text = (await page.getText()).replace(/\s+/g, ' ');
    doc.close();
    expect(text).toContain('Purchase');
    expect(text).toContain('7731');
    expect(res.headers['content-disposition']).toContain('scan-ocr.pdf');
    await app.close();
  }, 60_000);

  it('converts Office files through LibreOffice with a locked-down command line', async () => {
    const calls = ((globalThis as Record<string, unknown>).__sofficeCalls ??= []) as string[][];
    calls.length = 0;
    const app = buildServer(base);
    const sub = await submit(app, 'office-to-pdf', { name: '..\\..\\Quarterly Report.docx', data: new TextEncoder().encode('PK fake docx') });
    expect(sub.statusCode).toBe(202);
    const id = sub.json().id as string;
    expect((await finish(app, id)).state).toBe('done');
    const res = await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result` });
    expect(res.headers['content-disposition']).toContain('Quarterly Report.pdf');
    expect(isPdfBytes(res.rawPayload)).toBe(true);

    const args = calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--headless', '--norestore', '--nolockcheck', '--convert-to', 'pdf']));
    expect(args.some((a) => a.startsWith('-env:UserInstallation=file:'))).toBe(true);
    expect(args[args.length - 1]).toMatch(/input\.docx$/); // client file name never reaches the command line
    expect(args.join(' ')).not.toContain('Quarterly');

    // unsupported type is rejected before any process starts
    const calls0 = calls.length;
    const bad = await submit(app, 'office-to-pdf', { name: 'run.exe', data: new TextEncoder().encode('MZ') });
    expect(bad.statusCode).toBe(202);
    const badId = bad.json().id as string;
    const failed = await finish(app, badId);
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/Unsupported file type/);
    expect(calls.length).toBe(calls0);

    // converter failures surface as failed jobs with a useful message
    const broken = await submit(app, 'office-to-pdf', { name: 'broken.docx', data: new TextEncoder().encode('BROKEN') });
    const brokenFinal = await finish(app, broken.json().id);
    expect(brokenFinal.state).toBe('failed');
    expect(brokenFinal.error).toMatch(/could not convert/);
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${broken.json().id}/result` })).statusCode).toBe(409);
    await app.close();
  });

  it('cancels queued jobs and deletes finished ones', async () => {
    const app = buildServer({ ...base, concurrency: 1, maxJobsPerUser: 5 });
    const slow = await submit(app, 'ocr', { name: 'a.pdf', data: await scannedPdf('First job running') }, { dpi: 150 });
    const queued = await submit(app, 'compress', { name: 'b.pdf', data: await bigImagePdf() });
    const qid = queued.json().id as string;
    expect((await app.inject({ method: 'DELETE', url: `/v1/jobs/${qid}` })).statusCode).toBe(204);
    expect((await finish(app, qid)).state).toBe('canceled');
    await finish(app, slow.json().id);
    expect((await app.inject({ method: 'DELETE', url: `/v1/jobs/${slow.json().id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${slow.json().id}` })).statusCode).toBe(404);
    await app.close();
  }, 60_000);
});

const isPdfBytes = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

describe('HTML isolation', () => {
  it('injects a restrictive CSP before any content', () => {
    const out = (s: string) => new TextDecoder().decode(isolateHtml(new TextEncoder().encode(s)));
    expect(out('<html><head><title>x</title></head><body></body></html>')).toMatch(/<head><meta http-equiv="Content-Security-Policy"[^>]*default-src 'none'/);
    expect(out('<html><body>hi</body></html>')).toMatch(/<html><head><meta/);
    expect(out('<p>fragment</p>').startsWith('<meta')).toBe(true);
  });
});

// Real browser, only when Chrome/Edge is installed on the machine running the tests.
const browser = findTools().browser;
describe.skipIf(!browser)('HTML to PDF with a real browser', () => {
  it('prints the document and blocks all network access from it', async () => {
    let hits = 0;
    const probe: Server = createServer((_req, res) => {
      hits++;
      res.end('x');
    });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port;
    const html = `<html><body><h1>Quarterly Hello</h1><img src="http://127.0.0.1:${port}/beacon.png"><script>fetch('http://127.0.0.1:${port}/script')</script></body></html>`;
    const pdf = await htmlToPdf(browser!, new TextEncoder().encode(html), {}, { timeoutMs: 60_000 });
    probe.close();
    const doc = await pdfium.open(pdf);
    const page = await doc.getPage(0);
    expect(await page.getText()).toContain('Quarterly Hello');
    doc.close();
    expect(hits).toBe(0);
  }, 90_000);
});
