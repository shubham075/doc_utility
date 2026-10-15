import { PDFiumLibrary } from '@hyzyla/pdfium';
import type { OpenOptions, PdfDocument, PdfEngine, PdfPage, RenderOptions, RenderedBitmap } from './types.js';

type Lib = Awaited<ReturnType<typeof PDFiumLibrary.init>>;
type Doc = Awaited<ReturnType<Lib['loadDocument']>>;
type Page = ReturnType<Doc['getPage']>;

export interface PdfiumEngineOptions {
  /** Browsers must supply the wasm URL (e.g. via Vite `?url` import) or bytes. */
  wasmUrl?: string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}

class PdfiumPage implements PdfPage {
  readonly width: number;
  readonly height: number;
  constructor(
    readonly index: number,
    private readonly page: Page,
    /** True once the owning document was destroyed: touching the page after that aborts the WASM module. */
    private readonly docClosed: () => boolean,
  ) {
    const s = page.getOriginalSize();
    this.width = s.originalWidth;
    this.height = s.originalHeight;
  }
  async render({ scale }: RenderOptions): Promise<RenderedBitmap> {
    if (this.docClosed()) throw new Error('Document was closed');
    const r = await this.page.render({ scale, render: 'bitmap', renderFormFields: true });
    return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) };
  }
  async getText(): Promise<string> {
    if (this.docClosed()) throw new Error('Document was closed');
    return this.page.getText();
  }
  close(): void {
    if (!this.docClosed()) this.page.close();
  }
}

class PdfiumDocument implements PdfDocument {
  private closed = false;
  constructor(private readonly doc: Doc) {}
  get pageCount(): number {
    if (this.closed) return 0;
    return this.doc.getPageCount();
  }
  async getPage(index: number): Promise<PdfPage> {
    if (this.closed) throw new Error('Document was closed');
    return new PdfiumPage(index, this.doc.getPage(index), () => this.closed);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.doc.destroy();
  }
}

export async function createPdfiumEngine(options: PdfiumEngineOptions = {}): Promise<PdfEngine> {
  const lib = await PDFiumLibrary.init(options);
  return {
    id: 'pdfium',
    name: 'PDFium (WASM)',
    async open(data: Uint8Array, opts?: OpenOptions) {
      return new PdfiumDocument(await lib.loadDocument(data, opts?.password));
    },
    async dispose() {
      lib.destroy();
    },
  };
}
