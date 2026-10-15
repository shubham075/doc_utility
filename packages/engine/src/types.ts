/** Engine-agnostic PDF API. The UI talks only to these interfaces. */

export interface RenderOptions {
  /** 1 = 72 DPI (1 CSS px per PDF point). */
  scale: number;
}

export interface RenderedBitmap {
  width: number;
  height: number;
  /** Tightly packed RGBA, length = width * height * 4. */
  data: Uint8ClampedArray;
}

export interface PdfPage {
  readonly index: number;
  /** Page size in PDF points at rotation applied. */
  readonly width: number;
  readonly height: number;
  render(options: RenderOptions): Promise<RenderedBitmap>;
  getText(): Promise<string>;
  close(): void;
}

export interface PdfDocument {
  readonly pageCount: number;
  getPage(index: number): Promise<PdfPage>;
  close(): void;
}

export interface OpenOptions {
  password?: string;
}

export interface PdfEngine {
  readonly id: 'pdfium' | 'pdfjs';
  readonly name: string;
  open(data: Uint8Array, options?: OpenOptions): Promise<PdfDocument>;
  dispose(): Promise<void>;
}
