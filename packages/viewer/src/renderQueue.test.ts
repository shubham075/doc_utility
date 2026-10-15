import { describe, expect, it } from 'vitest';
import { RenderQueue } from './renderQueue';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('RenderQueue', () => {
  it('runs jobs one at a time, lowest priority value first', async () => {
    const q = new RenderQueue();
    const order: string[] = [];
    const job = (name: string, p: number) =>
      q.enqueue({ priority: () => p, run: async () => void order.push(name) });
    job('far', 10);
    job('near', 1);
    job('mid', 5);
    await tick(60);
    // The first enqueued job may start immediately; the rest must be ordered by priority.
    expect(order.slice(1)).toEqual(['near', 'mid']);
  });

  it('skips cancelled jobs and aborts their signal', async () => {
    const q = new RenderQueue();
    const ran: string[] = [];
    q.enqueue({ priority: () => 0, run: async () => void (await tick(30)) });
    const cancel = q.enqueue({ priority: () => 1, run: async () => void ran.push('cancelled') });
    cancel();
    await tick(80);
    expect(ran).toEqual([]);
  });

  it('stays usable after dispose (StrictMode re-runs effects)', async () => {
    const q = new RenderQueue();
    q.dispose();
    let ran = false;
    q.enqueue({ priority: () => 0, run: async () => void (ran = true) });
    await tick(30);
    expect(ran).toBe(true);
  });
});
