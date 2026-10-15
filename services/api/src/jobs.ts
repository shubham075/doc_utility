import { randomUUID } from 'node:crypto';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobResult {
  data: Uint8Array;
  filename: string;
  mime: string;
}

export interface Job {
  id: string;
  kind: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  result?: JobResult;
  owner: string;
}

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number): void;
}

type Work = (ctx: JobContext) => Promise<JobResult>;

export interface JobQueueOptions {
  concurrency: number;
  /** How long finished jobs (and their result bytes) are kept. */
  ttlMs: number;
  /** Maximum queued + running jobs per owner. */
  maxPerOwner: number;
}

/** Small in-memory job queue: bounded concurrency, cancellation, expiry. Swap for BullMQ/Redis when scaling out. */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private work = new Map<string, { run: Work; ac: AbortController }>();
  private waiting: string[] = [];
  private running = 0;
  private sweeper: NodeJS.Timeout;

  constructor(private readonly opts: JobQueueOptions) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1000, opts.ttlMs / 4)));
    this.sweeper.unref();
  }

  stop() {
    clearInterval(this.sweeper);
    for (const w of this.work.values()) w.ac.abort();
  }

  submit(kind: string, owner: string, run: Work): Job {
    const active = [...this.jobs.values()].filter((j) => j.owner === owner && (j.state === 'queued' || j.state === 'running')).length;
    if (active >= this.opts.maxPerOwner) throw new QueueFullError();
    const job: Job = { id: randomUUID(), kind, state: 'queued', progress: 0, createdAt: Date.now(), owner };
    this.jobs.set(job.id, job);
    this.work.set(job.id, { run, ac: new AbortController() });
    this.waiting.push(job.id);
    queueMicrotask(() => this.pump());
    return job;
  }

  get(id: string, owner: string): Job | undefined {
    const j = this.jobs.get(id);
    return j && j.owner === owner ? j : undefined;
  }

  cancel(id: string, owner: string): boolean {
    const job = this.get(id, owner);
    if (!job) return false;
    if (job.state === 'queued' || job.state === 'running') {
      this.work.get(id)?.ac.abort();
      if (job.state === 'queued') {
        this.waiting = this.waiting.filter((w) => w !== id);
        this.finish(job, 'canceled');
      }
    } else {
      this.jobs.delete(id);
    }
    return true;
  }

  private pump() {
    while (this.running < this.opts.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      const w = this.work.get(id);
      if (!job || !w) continue;
      this.running++;
      job.state = 'running';
      w.run({ signal: w.ac.signal, progress: (f) => (job.progress = Math.max(0, Math.min(1, f))) })
        .then((result) => {
          job.result = result;
          job.progress = 1;
          this.finish(job, w.ac.signal.aborted ? 'canceled' : 'done');
        })
        .catch((e: unknown) => {
          job.error = w.ac.signal.aborted ? 'Cancelled' : e instanceof Error ? e.message : String(e);
          this.finish(job, w.ac.signal.aborted ? 'canceled' : 'failed');
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private finish(job: Job, state: JobState) {
    job.state = state;
    job.finishedAt = Date.now();
    if (state !== 'done') delete job.result;
    this.work.delete(job.id);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (j.finishedAt && now - j.finishedAt > this.opts.ttlMs) this.jobs.delete(id);
  }
}

export class QueueFullError extends Error {
  constructor() {
    super('Too many active jobs for this user');
  }
}
