import { createHash, timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ConversionError, OFFICE_EXTENSIONS, htmlToPdf, isPdf, officeToPdf } from './converters';
import { JobQueue, QueueFullError, type JobResult } from './jobs';
import { compressJob, ocrJob } from './pdfJobs';
import { ServerAudit } from './audit';
import { findTools, type Tools } from './tools';

export interface ServerConfig {
  /** Bearer tokens accepted. Empty/undefined = open (development only). */
  apiKeys?: string[];
  maxFileBytes: number;
  /** Wall-clock limit for converter processes. */
  toolTimeoutMs: number;
  concurrency: number;
  maxJobsPerUser: number;
  resultTtlMs: number;
  corsOrigins: string[];
  tools: Tools;
  /** Keys that may read and verify the audit log (separate from ordinary user keys). */
  adminKeys?: string[];
  /** JSON-lines file for the audit trail; in-memory only when unset. */
  auditFile?: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    apiKeys: env.API_KEYS ? env.API_KEYS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    maxFileBytes: Number(env.MAX_FILE_MB ?? 100) * 1024 * 1024,
    toolTimeoutMs: Number(env.TOOL_TIMEOUT_S ?? 120) * 1000,
    concurrency: Number(env.CONCURRENCY ?? 2),
    maxJobsPerUser: Number(env.MAX_JOBS_PER_USER ?? 4),
    resultTtlMs: Number(env.RESULT_TTL_MIN ?? 15) * 60_000,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
    tools: findTools(env),
    adminKeys: env.ADMIN_KEYS ? env.ADMIN_KEYS.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    auditFile: env.AUDIT_FILE || undefined,
  };
}

const KINDS = ['office-to-pdf', 'html-to-pdf', 'compress', 'ocr'] as const;
type Kind = (typeof KINDS)[number];

const safeEqual = (a: string, b: string) => {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
};

/** Strip path components and control characters from a client-supplied file name. */
export const cleanName = (n: string) => n.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f"<>|:*?]/g, '_').slice(0, 120) || 'document';

export type ApiServer = FastifyInstance & { jobs: JobQueue };

export function buildServer(config: ServerConfig): ApiServer {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const jobs = new JobQueue({ concurrency: config.concurrency, ttlMs: config.resultTtlMs, maxPerOwner: config.maxJobsPerUser });
  app.decorate('jobs', jobs);
  const audit = new ServerAudit(config.auditFile);
  app.addHook('onClose', async () => jobs.stop());

  void app.register(cors, { origin: config.corsOrigins, methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['authorization', 'content-type'], exposedHeaders: ['content-disposition'] });
  void app.register(multipart, { limits: { fileSize: config.maxFileBytes, files: 1, fields: 8, fieldSize: 10_000 } });

  /** Returns the job owner id, or null if unauthorised. */
  const authenticate = (req: FastifyRequest): string | null => {
    if (!config.apiKeys?.length) return 'anonymous';
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const key = m?.[1];
    if (!key || !config.apiKeys.some((k) => safeEqual(k, key))) return null;
    return createHash('sha256').update(key).digest('hex').slice(0, 16);
  };

  const isAdmin = (req: FastifyRequest): boolean => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    return !!m?.[1] && !!config.adminKeys?.some((k) => safeEqual(k, m[1]!));
  };

  app.get('/health', async () => ({
    ok: true,
    capabilities: {
      'office-to-pdf': !!config.tools.soffice,
      'html-to-pdf': !!config.tools.browser,
      compress: true,
      ocr: true,
    },
    limits: { maxFileBytes: config.maxFileBytes, extensions: [...OFFICE_EXTENSIONS] },
  }));

  app.post<{ Params: { kind: string } }>('/v1/jobs/:kind', async (req, reply) => {
    const owner = authenticate(req);
    if (!owner) return reply.code(401).send({ error: 'Unauthorized' });
    const kind = req.params.kind as Kind;
    if (!KINDS.includes(kind)) return reply.code(404).send({ error: 'Unknown job type' });
    if (kind === 'office-to-pdf' && !config.tools.soffice) return reply.code(501).send({ error: 'Office conversion is not available on this server (LibreOffice not found)' });
    if (kind === 'html-to-pdf' && !config.tools.browser) return reply.code(501).send({ error: 'HTML conversion is not available on this server (Chrome/Edge not found)' });

    let file: { name: string; data: Uint8Array } | null = null;
    let options: Record<string, unknown> = {};
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (file) continue;
          const buf = await part.toBuffer(); // throws if over the size limit
          file = { name: cleanName(part.filename), data: new Uint8Array(buf) };
        } else if (part.fieldname === 'options') {
          options = JSON.parse(String(part.value)) as Record<string, unknown>;
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: `File exceeds the ${Math.round(config.maxFileBytes / 1048576)} MB limit` });
      return reply.code(400).send({ error: 'Malformed request' });
    }
    if (!file || !file.data.length) return reply.code(400).send({ error: 'A file is required' });
    if ((kind === 'compress' || kind === 'ocr') && !isPdf(file.data)) return reply.code(415).send({ error: 'This job needs a PDF file' });

    const f = file;
    const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    try {
      const job = jobs.submit(kind, owner, async (ctx): Promise<JobResult> => {
        switch (kind) {
          case 'office-to-pdf':
            return { data: await officeToPdf(config.tools.soffice!, f, { timeoutMs: config.toolTimeoutMs, signal: ctx.signal }), filename: f.name.replace(/\.[^.]+$/, '') + '.pdf', mime: 'application/pdf' };
          case 'html-to-pdf':
            return { data: await htmlToPdf(config.tools.browser!, f.data, { background: options.background !== false }, { timeoutMs: config.toolTimeoutMs, signal: ctx.signal }), filename: f.name.replace(/\.[^.]+$/, '') + '.pdf', mime: 'application/pdf' };
          case 'compress': {
            const preset = options.preset === 'low' || options.preset === 'high' ? options.preset : 'medium';
            return compressJob(f.data, f.name, { preset, stripMetadata: options.stripMetadata === true, removeThumbnails: options.removeThumbnails !== false }, ctx);
          }
          case 'ocr':
            return ocrJob(f.data, f.name, { pages: Array.isArray(options.pages) ? options.pages.filter((p): p is number => Number.isInteger(p)) : [], dpi: num(options.dpi, 250, 100, 400), skipPagesWithText: options.skipPagesWithText !== false }, ctx);
        }
      });
      void audit.record({ user: owner, action: `job.${kind}`, details: { bytes: f.data.length, file: f.name } });
      return reply.code(202).send({ id: job.id, state: job.state });
    } catch (e) {
      if (e instanceof QueueFullError) return reply.code(429).send({ error: e.message });
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const owner = authenticate(req);
    if (!owner) return reply.code(401).send({ error: 'Unauthorized' });
    const j = jobs.get(req.params.id, owner);
    if (!j) return reply.code(404).send({ error: 'Job not found' });
    return { id: j.id, kind: j.kind, state: j.state, progress: j.progress, error: j.error, size: j.result?.data.length };
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id/result', async (req, reply) => {
    const owner = authenticate(req);
    if (!owner) return reply.code(401).send({ error: 'Unauthorized' });
    const j = jobs.get(req.params.id, owner);
    if (!j) return reply.code(404).send({ error: 'Job not found' });
    if (j.state !== 'done' || !j.result) return reply.code(409).send({ error: `Job is ${j.state}`, detail: j.error });
    return reply
      .header('content-type', j.result.mime)
      .header('content-disposition', `attachment; filename="${cleanName(j.result.filename).replace(/"/g, '')}"`)
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(j.result.data));
  });

  app.delete<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const owner = authenticate(req);
    if (!owner) return reply.code(401).send({ error: 'Unauthorized' });
    return jobs.cancel(req.params.id, owner) ? reply.code(204).send() : reply.code(404).send({ error: 'Job not found' });
  });

  app.post<{ Body: { action?: unknown; doc?: { name?: unknown; sha256?: unknown }; details?: Record<string, unknown> } }>('/v1/audit', async (req, reply) => {
    const owner = authenticate(req);
    if (!owner) return reply.code(401).send({ error: 'Unauthorized' });
    const b = req.body ?? {};
    if (typeof b.action !== 'string' || !/^[a-z][a-z0-9.]{0,39}$/.test(b.action)) return reply.code(400).send({ error: 'Invalid action' });
    const doc = b.doc && typeof b.doc.name === 'string' && typeof b.doc.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.doc.sha256) ? { name: cleanName(b.doc.name), sha256: b.doc.sha256 } : undefined;
    const details: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(b.details ?? {}).slice(0, 16)) {
      if (/^[A-Za-z0-9_.-]{1,40}$/.test(k) && (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string')) details[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
    const e = await audit.record({ user: owner, action: b.action, doc, details: Object.keys(details).length ? details : undefined });
    return reply.code(201).send({ seq: e.seq, hash: e.hash });
  });

  app.get<{ Querystring: { offset?: string; limit?: string } }>('/v1/audit', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'Administrator key required' });
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    return { total: audit.size, entries: audit.list(offset, limit) };
  });

  app.get('/v1/audit/verify', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'Administrator key required' });
    return { entries: audit.size, ...(await audit.verify()) };
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ConversionError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'Internal error' : err.message });
  });

  return app as unknown as ApiServer;
}
