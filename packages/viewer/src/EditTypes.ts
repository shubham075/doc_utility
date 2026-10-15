import type { LinkInfo, LinkTarget, PageObject, ShapeSpec, TextSpec } from '@pdfsuite/editor';
import type { Rect } from '@pdfsuite/annotations';

/** Everything content editing needs from the host application. Every change reloads the document. */
export interface EditTools {
  busy: boolean;
  listObjects(page: number): Promise<PageObject[]>;
  listLinks(page: number): Promise<LinkInfo[]>;
  onMove(page: number, changes: { id: string; bbox: Rect }[]): Promise<void>;
  onDelete(page: number, ids: string[]): Promise<void>;
  /** Returns warnings to show (substituted fonts, missing glyphs). */
  onEditText(page: number, id: string, text: string): Promise<string[]>;
  onAddText(page: number, spec: TextSpec): Promise<string[]>;
  onAddImage(page: number, rect: Rect, file: File): Promise<void>;
  onAddShape(page: number, spec: ShapeSpec): Promise<void>;
  onReplaceImage(page: number, id: string, file: File): Promise<void>;
  onCropImage(page: number, id: string, area: Rect): Promise<void>;
  onExportImage(page: number, id: string): Promise<void>;
  onAddLink(page: number, rect: Rect, target: LinkTarget): Promise<void>;
  onUpdateLink(page: number, index: number, target: LinkTarget): Promise<void>;
  onDeleteLink(page: number, index: number): Promise<void>;
}

export type EditMode = 'select' | 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'link' | 'crop';

export interface TextStyle {
  family: TextSpec['family'];
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

export interface ShapeStyle {
  stroke: string;
  fill: string | null;
  width: number;
}

/** A picture waiting to be placed. */
export interface PlaceImage {
  file: File;
  aspect: number;
}

export const SHAPE_MODES: EditMode[] = ['rect', 'ellipse', 'line', 'arrow'];
