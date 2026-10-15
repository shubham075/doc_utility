import type { FieldValue, FormField, FormModel } from './model';
import { displayString } from './model';
import type { ScriptField, ScriptRunner } from './script';

export interface CommitResult {
  /** False if a keystroke/validate script rejected the value (the field keeps its previous value). */
  accepted: boolean;
  alerts: string[];
  /** Fields whose stored value changed (the committed field plus any recalculated ones). */
  changed: Map<string, FieldValue>;
  /** Display strings (after format scripts) for fields whose display changed. */
  display: Map<string, string>;
}

const asString = (v: FieldValue): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'Off') : v);

/**
 * Holds live form values and applies Acrobat semantics on commit:
 * keystroke -> validate -> store -> calculate (in /CO order) -> format.
 * All scripts run through the injected sandboxed runner.
 */
export class FormEngine {
  private fields = new Map<string, FormField>();
  private values = new Map<string, FieldValue>();
  private shown = new Map<string, string>();
  private calcOrder: string[];
  private docScripts: string[];
  private busy = false;

  constructor(
    model: Pick<FormModel, 'fields' | 'calculationOrder' | 'documentScripts'>,
    private readonly runner: ScriptRunner | null,
  ) {
    for (const f of model.fields) {
      this.fields.set(f.name, f);
      this.values.set(f.name, f.value);
    }
    this.calcOrder = model.calculationOrder;
    this.docScripts = model.documentScripts;
    this.formatAll();
  }

  getValue(name: string): FieldValue | undefined {
    return this.values.get(name);
  }

  /** What to show in the field when it is not being edited. */
  getDisplay(name: string): string {
    return this.shown.get(name) ?? asString(this.values.get(name) ?? '');
  }

  allValues(): ReadonlyMap<string, FieldValue> {
    return this.values;
  }

  field(name: string): FormField | undefined {
    return this.fields.get(name);
  }

  /** Restore every field to the value it had when the form was loaded. */
  reset(): CommitResult {
    const changed = new Map<string, FieldValue>();
    for (const f of this.fields.values()) {
      if (!sameValue(this.values.get(f.name)!, f.defaultValue)) changed.set(f.name, f.defaultValue);
      this.values.set(f.name, f.defaultValue);
    }
    this.shown.clear();
    this.formatAll();
    const display = new Map<string, string>();
    for (const f of this.fields.values()) display.set(f.name, this.getDisplay(f.name));
    return { accepted: true, alerts: [], changed, display };
  }

  /** Commit a user edit. */
  commit(name: string, input: FieldValue): CommitResult {
    const field = this.fields.get(name);
    const result: CommitResult = { accepted: true, alerts: [], changed: new Map(), display: new Map() };
    if (!field || this.busy) return { ...result, accepted: false };
    this.busy = true;
    try {
      let value = input;
      const text = asString(input);

      if (field.type === 'text' || field.type === 'dropdown') {
        // Keystroke then validate scripts may reject (event.rc = false) or rewrite the value.
        for (const [kind, src] of [
          ['Keystroke', field.actions.keystroke],
          ['Validate', field.actions.validate],
        ] as const) {
          if (!src || !this.runner) continue;
          const r = this.runner.run(src, {
            fields: this.snapshot(name, value),
            thisField: name,
            event: { name: kind, value: typeof value === 'string' ? value : text, change: text, willCommit: true },
            documentScripts: this.docScripts,
          });
          result.alerts.push(...r.alerts);
          if (!r.rc) return { ...result, accepted: false };
          if (!r.error && typeof value === 'string') value = r.value;
          this.applyPatch(r.patch, result, name);
        }
      }

      if (!sameValue(this.values.get(name)!, value)) result.changed.set(name, value);
      this.values.set(name, value);

      this.calculate(result, name);
      // Refresh displays of everything that changed.
      const touched = new Set<string>([name, ...result.changed.keys()]);
      for (const n of touched) {
        this.shown.delete(n);
        this.formatOne(n);
        result.display.set(n, this.getDisplay(n));
      }
      return result;
    } finally {
      this.busy = false;
    }
  }

  // ---- internals

  private snapshot(override?: string, value?: FieldValue): Record<string, ScriptField> {
    const out: Record<string, ScriptField> = {};
    for (const [n, f] of this.fields) {
      const v = n === override && value !== undefined ? value : this.values.get(n)!;
      out[n] = { value: typeof v === 'boolean' ? (v ? (f.widgets[0]?.exportValue ?? 'Yes') : 'Off') : v, readonly: f.readOnly, required: f.required, type: f.type };
    }
    return out;
  }

  private applyPatch(patch: Record<string, unknown>, result: CommitResult, except?: string) {
    for (const [n, v] of Object.entries(patch)) {
      const f = this.fields.get(n);
      if (!f || n === except) continue;
      const next: FieldValue =
        f.type === 'checkbox' ? v === true || (typeof v === 'string' && v !== 'Off' && v !== '') : f.type === 'list' ? (Array.isArray(v) ? v.map(String) : [String(v)]) : String(v ?? '');
      if (!sameValue(this.values.get(n)!, next)) result.changed.set(n, next);
      this.values.set(n, next);
    }
  }

  private calculate(result: CommitResult, except: string) {
    if (!this.runner) return;
    for (const n of this.calcOrder) {
      if (n === except) continue;
      const f = this.fields.get(n);
      const src = f?.actions.calculate;
      if (!f || !src || f.readOnly === undefined) continue;
      const current = this.values.get(n)!;
      const r = this.runner.run(src, {
        fields: this.snapshot(),
        thisField: n,
        event: { name: 'Calculate', value: asString(current), willCommit: true },
        documentScripts: this.docScripts,
      });
      result.alerts.push(...r.alerts);
      if (r.error || !r.rc) continue;
      const next = f.type === 'text' || f.type === 'dropdown' ? r.value : current;
      if (!sameValue(current, next)) result.changed.set(n, next);
      this.values.set(n, next);
      this.applyPatch(r.patch, result, n);
    }
  }

  private formatOne(name: string) {
    const f = this.fields.get(name);
    if (!f?.actions.format || !this.runner) return;
    const raw = asString(this.values.get(name) ?? '');
    const r = this.runner.run(f.actions.format, {
      fields: this.snapshot(),
      thisField: name,
      event: { name: 'Format', value: raw },
      documentScripts: this.docScripts,
    });
    if (!r.error) this.shown.set(name, r.value);
  }

  private formatAll() {
    for (const f of this.fields.values()) this.formatOne(f.name);
  }
}

export const sameValue = (a: FieldValue, b: FieldValue): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

export { displayString };
