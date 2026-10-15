export interface RenderJob {
  /** Lower runs first. Evaluated each time the queue picks its next job, so it can track scroll position. */
  priority: () => number;
  run: (signal: AbortSignal) => Promise<void>;
}

/**
 * Serial, cancellable, priority-ordered job runner. One job at a time keeps the main thread
 * responsive while engines render on it; swap for a worker pool later.
 */
export class RenderQueue {
  private jobs = new Set<{ job: RenderJob; ac: AbortController }>();
  private running = false;

  /** Returns a cancel function. */
  enqueue(job: RenderJob): () => void {
    const entry = { job, ac: new AbortController() };
    this.jobs.add(entry);
    void this.pump();
    return () => {
      entry.ac.abort();
      this.jobs.delete(entry);
    };
  }

  /** Abort and drop everything pending. The queue stays usable (React StrictMode re-runs effects). */
  dispose() {
    for (const e of this.jobs) e.ac.abort();
    this.jobs.clear();
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.size) {
        let best: { job: RenderJob; ac: AbortController } | undefined;
        let bestP = Infinity;
        for (const e of this.jobs) {
          const p = e.job.priority();
          if (p < bestP) {
            best = e;
            bestP = p;
          }
        }
        if (!best) break;
        this.jobs.delete(best);
        if (best.ac.signal.aborted) continue;
        try {
          await best.job.run(best.ac.signal);
        } catch (e) {
          if (!best.ac.signal.aborted) console.warn('render job failed', e);
        }
        // Let input events and paints through between jobs.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.running = false;
    }
  }
}
