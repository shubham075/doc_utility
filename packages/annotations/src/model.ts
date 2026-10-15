/**
 * Annotation model. All geometry is in *page display space*: PDF points, origin top-left, y grows
 * downward, after page rotation — i.e. the same space the viewer lays pages out in.
 * Conversion to/from PDF user space happens only in reader.ts / writer.ts (see geometry.ts).
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ReviewStatus = 'none' | 'accepted' | 'rejected' | 'completed' | 'cancelled';
export const REVIEW_STATUSES: ReviewStatus[] = ['none', 'accepted', 'rejected', 'completed', 'cancelled'];

export type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';
export type AnnotationType = MarkupType | 'note' | 'freetext' | 'ink' | 'square' | 'circle' | 'line' | 'stamp' | 'redact' | 'reply';

export interface BaseAnnotation {
  /** Stable id; written to the PDF as /NM. Foreign annotations without /NM get `ref:<obj>-<gen>`. */
  id: string;
  type: AnnotationType;
  /** Zero-based page index. */
  page: number;
  author: string;
  /** ISO-8601. */
  createdAt: string;
  modifiedAt: string;
  /** Comment text. */
  contents: string;
  /** Primary colour as #rrggbb (markup colour, stroke colour, text colour for free text). */
  color: string;
  /** 0..1 */
  opacity: number;
  status: ReviewStatus;
}

export interface MarkupAnnotation extends BaseAnnotation {
  type: MarkupType;
  /** One rect per text line. */
  quads: Rect[];
}

export interface NoteAnnotation extends BaseAnnotation {
  type: 'note';
  /** Top-left of the (fixed size) icon. */
  x: number;
  y: number;
}
export const NOTE_SIZE = 20;

export interface FreeTextAnnotation extends BaseAnnotation {
  type: 'freetext';
  rect: Rect;
  fontSize: number;
  /** Background fill or null for transparent. */
  fill: string | null;
  /** Border width in points (0 = none). The border is drawn in the text colour. */
  borderWidth: number;
}

export interface InkAnnotation extends BaseAnnotation {
  type: 'ink';
  strokes: Point[][];
  width: number;
}

export interface ShapeAnnotation extends BaseAnnotation {
  type: 'square' | 'circle';
  rect: Rect;
  width: number;
  fill: string | null;
}

export type LineEnd = 'none' | 'arrow';
export interface LineAnnotation extends BaseAnnotation {
  type: 'line';
  p1: Point;
  p2: Point;
  width: number;
  startStyle: LineEnd;
  endStyle: LineEnd;
}

/** Area marked for permanent removal. Nothing is removed until the redactions are applied. */
export interface RedactAnnotation extends BaseAnnotation {
  type: 'redact';
  quads: Rect[];
  /** Colour of the box painted over the removed content (#rrggbb). */
  overlayColor: string;
}

/** Image stamp (signature, initials, logo). PNG or JPEG as a data URL. */
export interface StampAnnotation extends BaseAnnotation {
  type: 'stamp';
  rect: Rect;
  dataUrl: string;
}
/** NM prefix that marks stamps written by this app (they are managed on save but left as page content on reopen). */
export const STAMP_ID_PREFIX = 'ps-stamp:';

export interface ReplyAnnotation extends BaseAnnotation {
  type: 'reply';
  parentId: string;
}

export type Annotation =
  | MarkupAnnotation
  | NoteAnnotation
  | FreeTextAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | LineAnnotation
  | StampAnnotation
  | RedactAnnotation
  | ReplyAnnotation;

export const MARKUP_TYPES: MarkupType[] = ['highlight', 'underline', 'strikeout', 'squiggly'];
export const isMarkup = (a: { type: AnnotationType }): a is MarkupAnnotation => MARKUP_TYPES.includes(a.type as MarkupType);

export const TYPE_LABELS: Record<AnnotationType, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  squiggly: 'Squiggly',
  note: 'Note',
  freetext: 'Text box',
  ink: 'Drawing',
  square: 'Rectangle',
  circle: 'Ellipse',
  line: 'Line',
  stamp: 'Signature / image',
  redact: 'Redaction',
  reply: 'Reply',
};

export function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function baseFields(
  page: number,
  author: string,
  color: string,
  opacity = 1,
): Omit<BaseAnnotation, 'type'> {
  const now = new Date().toISOString();
  return { id: newId(), page, author, createdAt: now, modifiedAt: now, contents: '', color, opacity, status: 'none' };
}
