import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTool } from './tools';

/** Office formats LibreOffice is asked to convert. Anything else is rejected before a process is started. */
export const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf', '.txt', '.xls', '.xlsx', '.ods', '.csv', '.ppt', '.pptx', '.odp']);

export class ConversionError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pdfsuite-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const isPdf = (b: Uint8Array) => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

export interface ConvertContext {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Convert a Word/Excel/PowerPoint/OpenDocument/RTF/CSV/TXT file to PDF with headless LibreOffice. */
export async function officeToPdf(soffice: string, file: { name: string; data: Uint8Array }, ctx: ConvertContext): Promise<Uint8Array> {
  const ext = extname(file.name).toLowerCase();
  if (!OFFICE_EXTENSIONS.has(ext)) throw new ConversionError(`Unsupported file type "${ext || file.name}"`, 415);
  return withTempDir(async (dir) => {
    const input = join(dir, `input${ext}`); // fixed name: the client-supplied name never reaches the file system
    await writeFile(input, file.data);
    const out = join(dir, 'out');
    const profile = pathToFileURL(join(dir, 'profile')).href; // private profile avoids lock clashes between parallel jobs
    const r = await runTool(
      soffice,
      ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo', `-env:UserInstallation=${profile}`, '--convert-to', 'pdf', '--outdir', out, input],
      { cwd: dir, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    );
    if (r.timedOut) throw new ConversionError('Conversion timed out', 504);
    const produced = await readdir(out).catch(() => [] as string[]);
    const pdfName = produced.find((n) => n.toLowerCase().endsWith('.pdf'));
    if (r.code !== 0 || !pdfName) throw new ConversionError(`LibreOffice could not convert this file${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`);
    const pdf = new Uint8Array(await readFile(join(out, pdfName)));
    if (!isPdf(pdf)) throw new ConversionError('Converter produced an invalid PDF');
    return pdf;
  });
}

export interface HtmlOptions {
  /** US Letter by default; 'A4' also supported. */
  paper?: 'Letter' | 'A4';
  background?: boolean;
}

/** Content-Security-Policy that forbids scripts, frames and every network fetch; only inline CSS and data: images/fonts remain. */
const CSP = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'";

/** Insert the CSP meta tag as early as possible so it covers the whole document (works without HTTP headers on file://). */
export function isolateHtml(html: Uint8Array): Uint8Array {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  const text = new TextDecoder('utf-8').decode(html);
  const head = /<head[^>]*>/i.exec(text);
  const root = /<html[^>]*>/i.exec(text);
  const out = head ? text.slice(0, head.index + head[0].length) + meta + text.slice(head.index + head[0].length) : root ? text.slice(0, root.index + root[0].length) + `<head>${meta}</head>` + text.slice(root.index + root[0].length) : meta + text;
  return new TextEncoder().encode(out);
}

/**
 * Print an HTML document to PDF with headless Chrome/Edge. The page is isolated: a CSP forbids scripts and every
 * subresource fetch, and the resolver refuses all hostnames, so uploads cannot be used for SSRF.
 */
export async function htmlToPdf(browser: string, html: Uint8Array, opts: HtmlOptions, ctx: ConvertContext): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    const input = join(dir, 'input.html');
    await writeFile(input, isolateHtml(html));
    const output = join(dir, 'output.pdf');
    const r = await runTool(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), // containers without user namespaces
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND',
        `--user-data-dir=${join(dir, 'profile')}`,
        '--no-pdf-header-footer',
        ...(opts.background === false ? [] : ['--print-background']),
        `--print-to-pdf=${output}`,
        pathToFileURL(input).href,
      ],
      { cwd: dir, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
    );
    if (r.timedOut) throw new ConversionError('Conversion timed out', 504);
    const pdf = new Uint8Array(await readFile(output).catch(() => new Uint8Array()));
    if (!isPdf(pdf)) throw new ConversionError(`Browser could not print this document${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`);
    return pdf;
  });
}

export { isPdf };
