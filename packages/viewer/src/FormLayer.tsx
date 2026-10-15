import { memo, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { Rect } from '@pdfsuite/annotations';
import type { FieldValue, FormField, FormStore, Widget } from '@pdfsuite/forms';
import type { Size } from './layout';

export interface WidgetRef {
  field: string;
  widget: number;
}

interface Props {
  page: number;
  size: Size;
  zoom: number;
  store: FormStore;
  /** Fields that have at least one widget on this page. */
  fields: FormField[];
  highlight: boolean;
  /** Focus this widget as soon as it is mounted (Tab navigation across pages). */
  focusTarget: WidgetRef | null;
  onFocused(): void;
  onTab(from: WidgetRef, backwards: boolean): void;
  onAlerts(alerts: string[]): void;
  /** Click on an unsigned signature field. */
  onSign(page: number, rect: Rect): void;
}

/**
 * Live inputs for AcroForm widgets, positioned in page space. Text is edited in raw form and shown
 * formatted (per the field's format script) when the field is not focused, like Acrobat.
 */
export const FormLayer = memo(function FormLayer(p: Props) {
  useSyncExternalStore(p.store.subscribe, p.store.getVersion, p.store.getVersion);
  return (
    <div className={`pv-forms${p.highlight ? ' pv-forms-hl' : ''}`} style={{ width: p.size.width, height: p.size.height, transform: `scale(${p.zoom})` }}>
      {p.fields.flatMap((f) =>
        f.widgets.map((w, wi) =>
          w.page === p.page ? <WidgetView key={`${f.name}:${wi}`} field={f} wi={wi} w={w} {...p} /> : null,
        ),
      )}
    </div>
  );
});

type ViewProps = Props & { field: FormField; wi: number; w: Widget };

function WidgetView(p: ViewProps) {
  const { field: f, w, wi } = p;
  const ref = { field: f.name, widget: wi };
  const style: React.CSSProperties = {
    left: w.rect.x,
    top: w.rect.y,
    width: w.rect.width,
    height: w.rect.height,
    background: w.background ?? undefined,
    border: w.borderWidth > 0 ? `${w.borderWidth}px solid ${w.borderColor ?? '#000'}` : undefined,
  };
  const focusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const t = p.focusTarget;
    if (t && t.field === f.name && t.widget === wi && focusRef.current) {
      focusRef.current.focus();
      p.onFocused();
    }
  });

  const commit = (value: FieldValue) => {
    const r = p.store.commit(f.name, value);
    if (r.alerts.length) p.onAlerts(r.alerts);
    return r.accepted;
  };
  const onTabKey = (e: RKeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      p.onTab(ref, e.shiftKey);
    }
  };
  const common = { 'data-field': f.name, 'data-widget': wi, title: f.tooltip, disabled: f.readOnly } as const;
  const required = f.required && isEmpty(p.store.value(f.name));
  const cls = `pv-widget pv-w-${f.type}${required ? ' pv-w-required' : ''}${f.readOnly ? ' pv-w-readonly' : ''}`;

  switch (f.type) {
    case 'text':
      return <TextWidget {...p} cls={cls} style={style} common={common} focusRef={focusRef} onTabKey={onTabKey} commit={commit} />;
    case 'checkbox': {
      const on = p.store.value(f.name) === true;
      return (
        <button
          {...common}
          ref={(el) => void (focusRef.current = el)}
          className={cls}
          style={style}
          role="checkbox"
          aria-checked={on}
          onClick={() => commit(!on)}
          onKeyDown={onTabKey}
        >
          {on && (
            <svg viewBox="0 0 10 10" width="100%" height="100%" preserveAspectRatio="none" aria-hidden>
              <path d="M1.5 5.5 L4 8 L8.5 2" fill="none" stroke="#111" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      );
    }
    case 'radio': {
      const on = p.store.value(f.name) === w.exportValue;
      return (
        <button
          {...common}
          ref={(el) => void (focusRef.current = el)}
          className={cls}
          style={{ ...style, borderRadius: '50%' }}
          role="radio"
          aria-checked={on}
          onClick={() => w.exportValue !== undefined && commit(w.exportValue)}
          onKeyDown={onTabKey}
        >
          {on && <span className="pv-radio-dot" />}
        </button>
      );
    }
    case 'dropdown': {
      const v = String(p.store.value(f.name) ?? '');
      const known = f.options.some((o) => o.value === v);
      return (
        <select
          {...common}
          ref={(el) => void (focusRef.current = el)}
          className={cls}
          style={{ ...style, fontSize: fontSizeOf(f, w) }}
          value={v}
          onChange={(e) => commit(e.target.value)}
          onKeyDown={onTabKey}
        >
          <option value="" />
          {!known && v && <option value={v}>{v}</option>}
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case 'list': {
      const v = (p.store.value(f.name) as string[]) ?? [];
      return (
        <select
          {...common}
          ref={(el) => void (focusRef.current = el)}
          className={cls}
          style={{ ...style, fontSize: fontSizeOf(f, w) }}
          multiple={f.multiSelect}
          size={f.multiSelect ? Math.max(2, Math.floor(w.rect.height / 14)) : undefined}
          value={f.multiSelect ? v : (v[0] ?? '')}
          onChange={(e) => commit(Array.from(e.target.selectedOptions, (o) => o.value))}
          onKeyDown={onTabKey}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    case 'signature':
      return (
        <button className="pv-widget pv-w-signature" style={{ ...style, border: style.border ?? '1px dashed #2563eb' }} onClick={() => p.onSign(w.page, w.rect)} title="Click to sign">
          Sign
        </button>
      );
    default:
      return null;
  }
}

const isEmpty = (v: FieldValue | undefined) => v === undefined || v === '' || v === false || (Array.isArray(v) && !v.length);

function fontSizeOf(f: FormField, w: Widget): number {
  return f.fontSize > 0 ? f.fontSize : Math.max(6, Math.min(f.multiline ? 12 : 14, w.rect.height * 0.7));
}

function TextWidget(
  p: ViewProps & {
    cls: string;
    style: React.CSSProperties;
    common: Record<string, unknown>;
    focusRef: React.MutableRefObject<HTMLElement | null>;
    onTabKey(e: RKeyboardEvent): void;
    commit(v: FieldValue): boolean;
  },
) {
  const { field: f, w, store } = p;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const raw = String(store.value(f.name) ?? '');
  const shown = editing ? text : f.password ? raw : store.display(f.name);
  const font = fontSizeOf(f, w);
  const props = {
    ...p.common,
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => void (p.focusRef.current = el),
    className: p.cls,
    style: { ...p.style, fontSize: font, textAlign: (['left', 'center', 'right'] as const)[f.align] },
    value: shown,
    maxLength: f.maxLength,
    readOnly: f.readOnly,
    spellCheck: false,
    onFocus: () => {
      setText(raw);
      setEditing(true);
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => {
      setEditing(false);
      if (text !== raw) p.commit(text); // a rejected commit simply keeps the old value
    },
    onKeyDown: (e: RKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        setText(raw);
        e.currentTarget.blur();
      } else if (e.key === 'Enter' && !f.multiline) {
        e.currentTarget.blur();
      } else p.onTabKey(e);
    },
  };
  return f.multiline ? <textarea {...props} /> : <input {...props} type={f.password ? 'password' : 'text'} />;
}
