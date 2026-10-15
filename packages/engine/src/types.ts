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

/** A run of text positioned in page space (points, origin top-left, y grows downward). */
export interface TextItem {
  str: string;
  /** Baseline origin of the run. */
  x: number;
  y: number;
  fontSize: number;
  /** Advance width of the run in points. */
  width: number;
  /** Rotation in radians (clockwise on screen). */
  angle: number;
  /** Ascent as a fraction of fontSize (distance from baseline up to the top of the em box). */
  ascent: number;
  fontFamily: string;
  /** True if a line break follows this run. */
  hasEOL: boolean;
}

export interface PdfPage {
  readonly index: number;
  /** Page size in PDF points at rotation applied. */
  readonly width: number;
  readonly height: number;
  render(options: RenderOptions): Promise<RenderedBitmap>;
  getText(): Promise<string>;
  /** Positioned text runs (text layer + search). Not every engine implements it. */
  getTextItems?(): Promise<TextItem[]>;
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
