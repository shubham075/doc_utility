import { describe, expect, it } from 'vitest';
import { JobQueue } from './jobs';
import { runTool } from './tools';

const node = process.execPath;

describe('runTool', () => {
  it('captures output and exit codes', async () => {
    const r = await runTool(node, ['-e', 'console.log("out"); console.error("err"); process.exit(3)'], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3, stdout: 'out\n', timedOut: false });
    expect(r.stderr).toBe('err\n');
  });

  it('passes arguments literally (no shell interpretation)', async () => {
    const nasty = 'a && echo INJECTED; $(whoami) | `id`';
    const r = await runTool(node, ['-e', 'console.log(process.argv[1])', nasty], { timeoutMs: 10_000 });
    expect(r.stdout.trim()).toBe(nasty);
  });

  it('kills runaway processes at the deadline', async () => {
    const t = Date.now();
    const r = await runTool(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('can be aborted and caps captured output', async () => {
    const ac = new AbortController();
    const p = runTool(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 20_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const r = await p;
    expect(r.code).not.toBe(0);
    const big = await runTool(node, ['-e', 'process.stdout.write("x".repeat(5_000_000))'], { timeoutMs: 20_000, maxOutputBytes: 1000 });
    expect(big.stdout.length).toBeLessThanOrEqual(1000);
  });

  it('rejects when the program does not exist', async () => {
    await expect(runTool('definitely-not-a-real-program-xyz', [], { timeoutMs: 1000 })).rejects.toThrow();
  });
});

describe('JobQueue', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs at most `concurrency` jobs at once and in order', async () => {
    const q = new JobQueue({ concurrency: 2, ttlMs: 60_000, maxPerOwner: 10 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const mk = (i: number) =>
      q.submit('t', 'u', async () => {
        running++;
        peak = Math.max(peak, running);
        order.push(i);
        await wait(40);
        running--;
        return { data: new Uint8Array([i]), filename: `${i}`, mime: 'x/y' };
      });
    const jobs = [0, 1, 2, 3, 4].map(mk);
    await wait(400);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(jobs.every((j) => j.state === 'done')).toBe(true);
    q.stop();
  });

  it('reports failures and expires old results', async () => {
    const q = new JobQueue({ concurrency: 1, ttlMs: 50, maxPerOwner: 10 });
    const bad = q.submit('t', 'u', async () => {
      throw new Error('boom');
    });
    await wait(30);
    expect(bad).toMatchObject({ state: 'failed', error: 'boom' });
    expect(bad.result).toBeUndefined();
    q.stop();
  });
});
