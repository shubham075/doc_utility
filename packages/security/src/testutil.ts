import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string) => new Uint8Array(readFileSync(join(here, '..', 'fixtures', `${name}.pdf`)));

export async function makeEngines(): Promise<PdfEngine[]> {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  return [
    await createPdfiumEngine(),
    await createPdfjsEngine({
      pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs' as string),
      createCanvas: (w, h) => createCanvas(w, h) as never,
      documentParams: { standardFontDataUrl: join(root, 'standard_fonts') + '/' },
    }),
  ];
}

export async function pageTexts(engine: PdfEngine, bytes: Uint8Array, password?: string): Promise<string[]> {
  const doc = await engine.open(bytes, { password });
  const out: string[] = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const p = await doc.getPage(i);
    out.push((await p.getText()).replace(/\s+/g, ' ').trim());
    p.close();
  }
  doc.close();
  return out;
}

/** Whether python + pikepdf (qpdf) are available for independent cross-checks. */
export const hasPikepdf = spawnSync('python', ['-c', 'import pikepdf'], { encoding: 'utf8' }).status === 0;

export function pikepdfCheck(path: string, password = ''): Record<string, any> {
  const r = spawnSync('python', [join(here, '..', 'tools', 'check_pdf.py'), path, password], { encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
}
