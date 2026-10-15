export type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'textbox'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  // Fill & Sign
  | 'date'
  | 'check'
  | 'cross'
  | 'dot'
  | 'hline'
  | 'stamp'
  // Redaction
  | 'redact'
  | 'redactArea';

export interface ToolStyle {
  color: string;
  opacity: number;
  /** Stroke width in points (ink, shapes, lines). */
  width: number;
  /** Text box font size in points. */
  fontSize: number;
}

export const MARKUP_TOOLS: Tool[] = ['highlight', 'underline', 'strikeout', 'squiggly', 'redact'];
/** Tools that capture pointer drags/clicks on the page itself. */
export const DRAW_TOOLS: Tool[] = ['note', 'textbox', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'date', 'check', 'cross', 'dot', 'hline', 'stamp', 'redactArea'];
/** Tools that stay active after one use. */
export const STICKY_TOOLS: Tool[] = [...MARKUP_TOOLS, 'ink', 'rect', 'ellipse', 'line', 'arrow', 'check', 'cross', 'dot', 'hline', 'redactArea'];

export const TOOL_LABELS: Record<Tool, string> = {
  select: 'Select',
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strike',
  squiggly: 'Squiggly',
  note: 'Note',
  textbox: 'Text',
  ink: 'Draw',
  rect: 'Rect',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  date: 'Date',
  check: '✓',
  cross: '✗',
  dot: '●',
  hline: '—',
  stamp: 'Place',
  redact: 'Redact text',
  redactArea: 'Redact area',
};

export const TOOL_TITLES: Record<Tool, string> = {
  select: 'Select / move annotations (Esc)',
  highlight: 'Highlight text — select text, then release',
  underline: 'Underline text',
  strikeout: 'Strikethrough text',
  squiggly: 'Squiggly underline',
  note: 'Add a sticky note — click on the page',
  textbox: 'Add a text box — drag on the page',
  ink: 'Freehand drawing',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  date: "Insert today's date — click on the page",
  check: 'Check mark — click to place',
  cross: 'Cross mark — click to place',
  dot: 'Dot — click to place',
  hline: 'Horizontal line — click to place',
  stamp: 'Place the signature — click on the page',
  redact: 'Mark selected text for redaction',
  redactArea: 'Mark an area for redaction — drag on the page',
};

export const PALETTE = ['#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#4caf50', '#2196f3', '#9c27b0', '#111111'];

const base: ToolStyle = { color: '#f44336', opacity: 1, width: 2, fontSize: 14 };

export const TOOL_DEFAULTS: Record<Tool, ToolStyle> = {
  select: base,
  highlight: { ...base, color: '#ffeb3b', opacity: 1 },
  underline: { ...base, color: '#f44336' },
  strikeout: { ...base, color: '#f44336' },
  squiggly: { ...base, color: '#f44336' },
  note: { ...base, color: '#ffeb3b' },
  textbox: { ...base, color: '#111111' },
  ink: { ...base },
  rect: { ...base },
  ellipse: { ...base },
  line: { ...base },
  arrow: { ...base },
  date: { ...base, color: '#111111', fontSize: 12 },
  check: { ...base, color: '#111111' },
  cross: { ...base, color: '#111111' },
  dot: { ...base, color: '#111111' },
  hline: { ...base, color: '#111111', width: 1.2 },
  stamp: base,
  redact: { ...base, color: '#ff0000' },
  redactArea: { ...base, color: '#ff0000' },
};

/** An image waiting to be placed on a page (signature, initials). */
export interface StampArm {
  dataUrl: string;
  /** width / height of the image. */
  aspect: number;
  /** Placement width in points. */
  width: number;
}
