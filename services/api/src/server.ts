import { createHash, timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ConversionError, OFFICE_EXTENSIONS, htmlToPdf, isPdf, officeToPdf } from './converters';
import { JobQueue, QueueFullError, type JobResult } from './jobs';
import { compressJob, ocrJob } from './pdfJobs';
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

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof ConversionError) return reply.code(err.status).send({ error: err.message });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? 'Internal error' : err.message });
  });

  return app as unknown as ApiServer;
}
