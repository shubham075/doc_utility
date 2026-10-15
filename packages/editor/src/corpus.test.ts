import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { diffFraction, fallbackFont, makeEngines, pageText, render } from './testutil';
import { scanPage } from './scan';
import { commit, editText, openForEdit } from './edit';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'fixtures', 'corpus');
const web = join(here, '..', '..', '..', 'apps', 'web', 'public');
const files: { name: string; bytes: Uint8Array }[] = [
  ...readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(dir, f))) })),
  ...['sample.pdf', 'form.pdf'].map((f) => ({ name: f, bytes: new Uint8Array(readFileSync(join(web, f))) })),
];

let engines: Awaited<ReturnType<typeof makeEngines>>;
beforeAll(async () => {
  engines = await makeEngines();
});

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const isAscii = (s: string) => /^[\x20-\x7e]+$/.test(s);

/** The strip of the page that holds the edited line: everything else must stay pixel-identical. */
const band = (bm: { width: number }, bbox: { y: number; height: number }) => ({ x: 0, y: Math.max(0, Math.floor(bbox.y) - 4), width: bm.width, height: Math.ceil(bbox.height) + 8 });

describe(`text editing round trips on ${files.length} documents`, () => {
  it('rewriting the page without changes looks identical', async () => {
    const worst: [string, number][] = [];
    for (const f of files) {
      const doc = await openForEdit(f.bytes);
      const scan = await scanPage(doc, 0);
      const out = await commit(doc, scan, scan.ops);
      const d = diffFraction(await render(engines.pdfium, f.bytes), await render(engines.pdfium, out));
      worst.push([f.name, d]);
    }
    worst.sort((a, b) => b[1] - a[1]);
    console.log('no-op rewrite, largest differences:', worst.slice(0, 4).map(([n, d]) => `${n} ${(d * 100).toFixed(3)}%`).join(', '));
    for (const [n, d] of worst) expect(d, n).toBeLessThan(0.001);
  });

  it('editing a run changes only that line (reverse + title case, original and fallback fonts)', async () => {
    const rows: string[] = [];
    let editedDocs = 0;
    for (const f of files) {
      const scan = await scanPage(await openForEdit(f.bytes), 0);
      const candidates = scan.objects.filter((o) => o.kind === 'text' && o.editable && (o.text ?? '').replace(/\s/g, '').length >= 5);
      if (!candidates.length) {
        rows.push(`${f.name}: no editable text`);
        continue;
      }
      editedDocs++;
      // the second candidate when available, so we are not always editing a heading
      const target = candidates[Math.min(1, candidates.length - 1)]!;
      const before = await render(engines.pdfium, f.bytes);

      // 1. reverse the characters: only glyphs the run already uses
      const reversed = Array.from(target.text!).reverse().join('');
      const a = await editText(f.bytes, 0, target.id, reversed, { fallbackFont });
      const bmA = await render(engines.pdfium, a.bytes);
      const dA = diffFraction(before, bmA, [band(before, target.bbox)]);
      expect(a.usedFallback, `${f.name} reverse should not need the fallback font`).toBe(false);
      expect(dA, `${f.name} reverse diff outside line`).toBeLessThan(0.005);
      if (isAscii(reversed.trim())) expect(norm(await pageText(engines.pdfjs, a.bytes))).toContain(norm(reversed));

      // 2. Title Case: capital letters the subset may lack (about the same width, so nothing runs off the page)
      const upper = target.text!.replace(/\p{Ll}/gu, (c) => c.toUpperCase());
      const b = await editText(f.bytes, 0, target.id, upper, { fallbackFont });
      const dB = diffFraction(before, await render(engines.pdfium, b.bytes), [band(before, target.bbox)]);
      expect(dB, `${f.name} title-case diff outside line`).toBeLessThan(0.005);
      if (isAscii(upper.trim())) expect(norm(await pageText(engines.pdfjs, b.bytes))).toContain(norm(upper));
      rows.push(`${f.name}: reverse ${(dA * 100).toFixed(3)}%, title ${(dB * 100).toFixed(3)}%${b.usedFallback ? ' (fallback font)' : ''}`);
    }
    console.log(rows.join('\n'));
    expect(editedDocs).toBeGreaterThanOrEqual(files.length - 3);
  });

  it('needs and uses the fallback font in subset documents, and the edit really changes the line', async () => {
    for (const name of ['lib-liberation-subset.pdf', 'edge-arial-paragraphs.pdf', 'edge-times-serif.pdf']) {
      const f = files.find((x) => x.name === name)!;
      const scan = await scanPage(await openForEdit(f.bytes), 0);
      const target = scan.objects.find((o) => o.kind === 'text' && o.editable && (o.text ?? '').length > 12)!;
      const r = await editText(f.bytes, 0, target.id, 'ZQXJ € test', { fallbackFont });
      expect(r.usedFallback, name).toBe(true);
      const before = await render(engines.pdfium, f.bytes);
      const after = await render(engines.pdfium, r.bytes);
      expect(diffFraction(before, after), `${name} the line must change`).toBeGreaterThan(0.0002);
      const txt = norm(await pageText(engines.pdfjs, r.bytes));
      expect(txt, name).toContain('ZQXJ');
      expect(txt, name).toContain('test');
    }
  });
});
