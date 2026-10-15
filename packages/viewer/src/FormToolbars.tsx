import { TOOL_LABELS, TOOL_TITLES, type Tool } from './annotationTools';
import type { SignatureKind } from './signatures';

interface FillSignProps {
  tool: Tool;
  onTool(t: Tool): void;
  has: Record<SignatureKind, boolean>;
  /** Which saved image is currently armed for placement, if any. */
  armed: SignatureKind | null;
  /** Place the saved signature/initials (opens the creator first if none is saved). */
  onSign(kind: SignatureKind): void;
  /** Always open the creator to replace the saved one. */
  onEdit(kind: SignatureKind): void;
}

const MARKS: Tool[] = ['textbox', 'date', 'check', 'cross', 'dot', 'hline'];

export function FillSignToolbar({ tool, onTool, has, armed, onSign, onEdit }: FillSignProps) {
  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Fill and sign">
      <strong className="pv-muted">Fill &amp; Sign</strong>
      {MARKS.map((t) => (
        <button key={t} aria-pressed={tool === t} title={TOOL_TITLES[t]} onClick={() => onTool(t)}>
          {t === 'textbox' ? 'Add text' : TOOL_LABELS[t]}
        </button>
      ))}
      <span className="pv-sep" />
      {(['signature', 'initials'] as const).map((k) => (
        <span key={k} className="pv-btn-group">
          <button aria-pressed={tool === 'stamp' && armed === k} title={has[k] ? `Place your saved ${k}` : `Create your ${k}`} onClick={() => onSign(k)}>
            {k === 'signature' ? 'Sign' : 'Initials'}
          </button>
          <button aria-label={`Change ${k}`} title={`Create a new ${k}`} onClick={() => onEdit(k)}>
            ✎
          </button>
        </span>
      ))}
    </div>
  );
}

interface FormBarProps {
  fieldCount: number;
  highlight: boolean;
  onHighlight(v: boolean): void;
  onReset(): void;
  onExport(): void;
  onFlatten(): void;
  dirty: boolean;
}

export function FormToolbar(p: FormBarProps) {
  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Form">
      <strong className="pv-muted">Form · {p.fieldCount} fields</strong>
      <button aria-pressed={p.highlight} onClick={() => p.onHighlight(!p.highlight)} title="Highlight fillable fields">
        Highlight fields
      </button>
      <button onClick={p.onReset} disabled={!p.dirty} title="Restore all fields to their original values">
        Reset form
      </button>
      <button onClick={p.onExport} title="Download the field values as JSON">
        Export data
      </button>
      <button onClick={p.onFlatten} title="Save a copy with the form burned into the pages (no longer fillable)">
        Flatten &amp; save…
      </button>
    </div>
  );
}
