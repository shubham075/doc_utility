import type { Annotation } from '@pdfsuite/annotations';
import { PALETTE, TOOL_LABELS, TOOL_TITLES, type Tool, type ToolStyle } from './annotationTools';

const TOOLS: Tool[] = ['select', 'highlight', 'underline', 'strikeout', 'squiggly', 'note', 'textbox', 'ink', 'rect', 'ellipse', 'line', 'arrow'];
const WIDTHS = [1, 2, 3, 5, 8];
const FONT_SIZES = [10, 12, 14, 18, 24, 36];

interface Props {
  tool: Tool;
  onTool(t: Tool): void;
  /** Style being edited: the selected annotation's, or the active tool's. */
  style: ToolStyle;
  onStyle(patch: Partial<ToolStyle>): void;
  selected: Annotation | undefined;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  saving: boolean;
  onUndo(): void;
  onRedo(): void;
  onDelete(): void;
  onSave(): void;
}

export function AnnotationToolbar(p: Props) {
  const t = p.selected?.type;
  const showWidth = p.selected ? ['ink', 'square', 'circle', 'line'].includes(t!) : ['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(p.tool);
  const showFont = p.selected ? t === 'freetext' : p.tool === 'textbox';
  const redacting = p.selected ? t === 'redact' : p.tool === 'redact' || p.tool === 'redactArea';
  const showOpacity = !redacting && (p.selected ? t !== 'note' && t !== 'reply' : p.tool !== 'select' && p.tool !== 'note');
  const showColor = !redacting && (p.selected ? t !== 'reply' : p.tool !== 'select');

  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Annotation toolbar">
      {TOOLS.map((tool) => (
        <button key={tool} aria-pressed={p.tool === tool} title={TOOL_TITLES[tool]} onClick={() => p.onTool(tool)}>
          {TOOL_LABELS[tool]}
        </button>
      ))}
      <span className="pv-sep" />
      {showColor && (
        <span className="pv-palette" role="group" aria-label="Colour">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={p.style.color.toLowerCase() === c ? 'pv-color pv-color-on' : 'pv-color'}
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              onClick={() => p.onStyle({ color: c })}
            />
          ))}
          <input type="color" aria-label="Custom colour" value={p.style.color} onChange={(e) => p.onStyle({ color: e.target.value })} />
        </span>
      )}
      {showOpacity && (
        <label className="pv-muted pv-inline">
          Opacity
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={p.style.opacity}
            onChange={(e) => p.onStyle({ opacity: Number(e.target.value) })}
            aria-label="Opacity"
          />
        </label>
      )}
      {showWidth && (
        <select aria-label="Line width" value={p.style.width} onChange={(e) => p.onStyle({ width: Number(e.target.value) })}>
          {WIDTHS.map((w) => (
            <option key={w} value={w}>
              {w} pt
            </option>
          ))}
        </select>
      )}
      {showFont && (
        <select aria-label="Font size" value={p.style.fontSize} onChange={(e) => p.onStyle({ fontSize: Number(e.target.value) })}>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s} pt
            </option>
          ))}
        </select>
      )}
      <span className="pv-spacer" />
      <button onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
        Undo
      </button>
      <button onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Y)">
        Redo
      </button>
      <button onClick={p.onDelete} disabled={!p.selected} title="Delete selected (Del)">
        Delete
      </button>
      <button className="pv-primary" onClick={p.onSave} disabled={p.saving} title="Save a copy with annotations (Ctrl+S)">
        {p.saving ? 'Saving…' : p.dirty ? 'Save ●' : 'Save'}
      </button>
    </div>
  );
}
