import { createWorker, type Worker } from 'tesseract.js';
import type { OcrWord } from './textLayer';

export interface Recognizer {
  recognize(png: Uint8Array): Promise<OcrWord[]>;
  terminate(): Promise<void>;
}

export interface TesseractOptions {
  /** e.g. 'eng' or 'eng+fra'. Language data must be available at `langPath`. */
  language?: string;
  /** Directory or URL holding `<lang>.traineddata.gz` (self-host it; nothing is fetched from a CDN by default). */
  langPath: string;
  /** Browser: URL of tesseract.js `worker.min.js`. */
  workerPath?: string;
  /** Browser: URL of the tesseract.js-core directory or file. */
  corePath?: string;
  cachePath?: string;
  /** Data files are gzip-compressed (default true). */
  gzip?: boolean;
}

/** Offline OCR with tesseract.js (WebAssembly). One worker handles pages sequentially. */
export async function createTesseractRecognizer(opts: TesseractOptions): Promise<Recognizer> {
  // Only pass options that are set: tesseract.js treats an explicit `undefined` as "no default".
  const options: Record<string, unknown> = { langPath: opts.langPath, gzip: opts.gzip ?? true };
  if (opts.workerPath) options.workerPath = opts.workerPath;
  if (opts.corePath) options.corePath = opts.corePath;
  if (opts.cachePath) options.cachePath = opts.cachePath;
  const worker: Worker = await createWorker(opts.language ?? 'eng', 1, options);
  return {
    async recognize(png) {
      const { data } = await worker.recognize(png as never, {}, { blocks: true });
      const words: OcrWord[] = [];
      for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
        words.push({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, confidence: w.confidence });
      }
      return words;
    },
    terminate: async () => void (await worker.terminate()),
  };
}
