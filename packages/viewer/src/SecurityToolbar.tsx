import type { Tool } from './annotationTools';
import type { SecurityDialogKind, SecurityTools } from './SecurityDialogs';

interface Props {
  tools: SecurityTools;
  tool: Tool;
  onTool(t: Tool): void;
  markCount: number;
  onDialog(k: SecurityDialogKind): void;
  /** The file has an annotation store (redaction marks need it). */
  canMark: boolean;
}

export function SecurityToolbar({ tools, tool, onTool, markCount, onDialog, canMark }: Props) {
  const p = tools.permissions;
  const canEdit = p.modify;
  return (
    <div className="pv-toolbar pv-annbar" role="toolbar" aria-label="Security">
      <strong className="pv-muted">Security</strong>
      <button onClick={() => onDialog('protect')} disabled={tools.busy} title="Encrypt with a password and restrict printing, copying and editing">
        {tools.protection ? 'Protected 🔒' : 'Protect'}
      </button>
      <button onClick={() => onDialog('sanitize')} disabled={tools.busy || !canEdit} title="Find and remove hidden data: metadata, scripts, attachments, comments">
        Sanitize
      </button>
      <span className="pv-sep" />
      {canMark && (
        <>
          <button aria-pressed={tool === 'redact'} onClick={() => onTool(tool === 'redact' ? 'select' : 'redact')} disabled={tools.busy || !canEdit} title="Select text to mark for redaction">
            Redact text
          </button>
          <button aria-pressed={tool === 'redactArea'} onClick={() => onTool(tool === 'redactArea' ? 'select' : 'redactArea')} disabled={tools.busy || !canEdit} title="Drag to mark an area (text, images, graphics) for redaction">
            Redact area
          </button>
        </>
      )}
      <button className={markCount ? 'pv-primary' : undefined} onClick={() => onDialog('redact')} disabled={tools.busy || !canEdit} title="Find sensitive text, then permanently remove everything marked">
        {markCount ? `Apply redactions (${markCount})` : 'Redaction…'}
      </button>
      <span className="pv-sep" />
      <button onClick={() => onDialog('sign')} disabled={tools.busy} title="Sign with a digital certificate">
        Sign
      </button>
      <button onClick={() => onDialog('signatures')} title="Verify the signatures in this document">
        {tools.signed ? 'Signatures ✎' : 'Signatures'}
      </button>
      <span className="pv-spacer" />
      <button onClick={() => onDialog('audit')} title="Record of what was done with documents on this device">
        Audit log
      </button>
    </div>
  );
}
