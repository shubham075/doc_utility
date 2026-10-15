import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  /** Cap captured output so a chatty tool cannot exhaust memory. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Run an external program WITHOUT a shell (arguments are never interpreted), with a hard timeout.
 * On timeout/abort the whole process tree is killed.
 */
export function runTool(command: string, args: readonly string[], opts: RunOptions): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const max = opts.maxOutputBytes ?? 1_000_000;
    const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (cur: string, chunk: Buffer) => (cur.length >= max ? cur : cur + chunk.toString('utf8').slice(0, max - cur.length));
    child.stdout.on('data', (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = take(stderr, c)));

    const kill = () => {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

/** First existing executable among explicit candidates, then PATH lookups. */
export function locate(names: readonly string[], candidates: readonly string[] = [], override?: string): string | null {
  if (override) return existsSync(override) ? override : null;
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) for (const e of exts) {
      const p = join(dir, n + e);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export interface Tools {
  soffice: string | null;
  browser: string | null;
}

export function findTools(env: NodeJS.ProcessEnv = process.env): Tools {
  const pf = env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return {
    soffice: locate(['soffice', 'libreoffice'], [join(pf, 'LibreOffice', 'program', 'soffice.exe'), '/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'], env.SOFFICE_PATH),
    browser: locate(
      ['chromium', 'chromium-browser', 'google-chrome', 'chrome', 'msedge'],
      [
        join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
      env.CHROME_PATH,
    ),
  };
}
