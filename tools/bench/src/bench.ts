import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { createNodeEngines } from './node-engines.js';

const corpus = new URL('../../../corpus/', import.meta.url);
const outDir = new URL('./out/', import.meta.url);
const SCALE = 1.5;
const MAX_PAGES = Number(process.env.BENCH_PAGES ?? 20);

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);
const mb = () => Math.round(process.memoryUsage().rss / 1048576);

const files = (await readdir(corpus)).filter((f) => f.toLowerCase().endsWith('.pdf'));
if (!files.length) {
  console.error('No PDFs in corpus/. Run: pnpm --filter @pdfsuite/bench gen-sample');
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
const engines = await createNodeEngines();
const results: unknown[] = [];

for (const file of files) {
  const data = new Uint8Array(await readFile(new URL(file, corpus)));
  for (const engine of engines) {
    try {
      let t = ms();
      const doc = await engine.open(data);
      const open = ms() - t;
      const n = Math.min(doc.pageCount, MAX_PAGES);

      t = ms();
      const p0 = await doc.getPage(0);
      const bmp = await p0.render({ scale: SCALE });
      const first = ms() - t;
      const c = createCanvas(bmp.width, bmp.height);
      c.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
      await writeFile(new URL(`${file}.${engine.id}.png`, outDir), c.toBuffer('image/png'));
      p0.close();

      t = ms();
      for (let i = 0; i < n; i++) {
        const p = await doc.getPage(i);
        await p.render({ scale: SCALE });
        p.close();
      }
      const renderAvg = (ms() - t) / n;

      t = ms();
      let chars = 0;
      for (let i = 0; i < n; i++) {
        const p = await doc.getPage(i);
        chars += (await p.getText()).length;
        p.close();
      }
      const textAvg = (ms() - t) / n;

      const row = { file, engine: engine.id, pages: doc.pageCount, open, first, renderAvg: +renderAvg.toFixed(1), textAvg: +textAvg.toFixed(1), chars, rssMB: mb() };
      results.push(row);
      console.log(row);
      doc.close();
    } catch (e) {
      console.error(file, engine.id, 'FAILED', e);
      results.push({ file, engine: engine.id, error: String(e) });
    }
  }
}
await writeFile(new URL('../results.json', import.meta.url), JSON.stringify(results, null, 2));
for (const e of engines) await e.dispose();
