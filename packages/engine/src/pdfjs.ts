import type { OpenOptions, PdfDocument, PdfEngine, PdfPage, RenderOptions, RenderedBitmap } from './types.js';

/** Minimal canvas surface needed by the adapter; satisfied by DOM canvas and @napi-rs/canvas. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): any;
}

export interface PdfjsEngineOptions {
  /** The loaded pdfjs-dist module (`pdfjs-dist` in browsers, `pdfjs-dist/legacy/build/pdf.mjs` in Node). */
  pdfjs: any;
  createCanvas(width: number, height: number): CanvasLike;
  /** Optional constructor forwarded to pdf.js `CanvasFactory` option (Node needs one). */
  canvasFactory?: unknown;
  /** Extra getDocument() params, e.g. standardFontDataUrl / cMapUrl (required in Node). */
  documentParams?: Record<string, unknown>;
}

export async function createPdfjsEngine(opts: PdfjsEngineOptions): Promise<PdfEngine> {
  const { pdfjs, createCanvas } = opts;

  class Page implements PdfPage {
    readonly width: number;
    readonly height: number;
    constructor(
      readonly index: number,
      private readonly page: any,
    ) {
      const vp = page.getViewport({ scale: 1 });
      this.width = vp.width;
      this.height = vp.height;
    }
    async render({ scale }: RenderOptions): Promise<RenderedBitmap> {
      const viewport = this.page.getViewport({ scale });
      const w = Math.ceil(viewport.width);
      const h = Math.ceil(viewport.height);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      await this.page.render({ canvasContext: ctx, canvas, viewport, background: 'white' }).promise;
      const img = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, data: new Uint8ClampedArray(img.data) };
    }
    async getText(): Promise<string> {
      const content = await this.page.getTextContent();
      return content.items.map((i: any) => i.str + (i.hasEOL ? '\n' : '')).join('');
    }
    close(): void {
      this.page.cleanup();
    }
  }

  class Doc implements PdfDocument {
    constructor(
      private readonly doc: any,
      private readonly task: any,
    ) {}
    get pageCount(): number {
      return this.doc.numPages;
    }
    async getPage(index: number): Promise<PdfPage> {
      return new Page(index, await this.doc.getPage(index + 1));
    }
    close(): void {
      void (this.task.destroy?.() ?? this.doc.cleanup?.());
    }
  }

  return {
    id: 'pdfjs',
    name: 'PDF.js',
    async open(data: Uint8Array, o?: OpenOptions) {
      // pdf.js transfers/detaches the buffer, so hand it a copy.
      const task = pdfjs.getDocument({
        data: data.slice(),
        password: o?.password,
        ...(opts.canvasFactory ? { CanvasFactory: opts.canvasFactory } : {}),
        isEvalSupported: false,
        ...opts.documentParams,
      });
      return new Doc(await task.promise, task);
    },
    async dispose() {},
  };
}
