import { createPdfiumEngine, createPdfjsEngine, type PdfEngine } from '@pdfsuite/engine';
import pdfiumWasmUrl from '@hyzyla/pdfium/pdfium.wasm?url';
import * as pdfjs from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

export type EngineId = 'pdfium' | 'pdfjs';
const cache = new Map<EngineId, Promise<PdfEngine>>();

export function getEngine(id: EngineId): Promise<PdfEngine> {
  let e = cache.get(id);
  if (!e) {
    e =
      id === 'pdfium'
        ? createPdfiumEngine({ wasmUrl: pdfiumWasmUrl })
        : createPdfjsEngine({
            pdfjs,
            createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
          });
    cache.set(id, e);
  }
  return e;
}
