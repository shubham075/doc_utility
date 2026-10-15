// Self-host the OCR engine: nothing is fetched from a CDN at runtime.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = new URL('../public/ocr/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(join(out, 'lang'), { recursive: true });

const tess = dirname(require.resolve('tesseract.js/package.json'));
cpSync(join(tess, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));

// Use the core that tesseract.js itself depends on, so worker and wasm always match.
const core = dirname(createRequire(join(tess, 'package.json')).resolve('tesseract.js-core/package.json'));
for (const f of readdirSync(core)) if (/^tesseract-core(-[a-z]+)?-lstm\.(wasm|wasm\.js|js)$/.test(f)) cpSync(join(core, f), join(out, f));

const data = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz');
cpSync(data, join(out, 'lang', 'eng.traineddata.gz'));
console.log('OCR assets copied to', out);

// Fallback fonts for text editing (Liberation Sans, SIL OFL 1.1; licence file is copied next to them).
const pdfjs = dirname(require.resolve('pdfjs-dist/package.json'));
const fonts = new URL('../public/fonts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(fonts, { recursive: true });
for (const f of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf', 'LICENSE_LIBERATION']) cpSync(join(pdfjs, 'standard_fonts', f), join(fonts, f));
console.log('Fonts copied to', fonts);
