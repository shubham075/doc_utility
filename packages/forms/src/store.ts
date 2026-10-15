import { FormEngine, type CommitResult } from './engine';
import type { FieldValue, FormModel } from './model';
import type { ScriptRunner } from './script';

/** Observable wrapper around FormEngine for UI binding (useSyncExternalStore) and save bookkeeping. */
export class FormStore {
  readonly engine: FormEngine;
  private listeners = new Set<() => void>();
  private version = 0;
  private touched = new Set<string>();
  private dirtyFlag = false;

  constructor(
    readonly model: FormModel,
    runner: ScriptRunner | null,
  ) {
    this.engine = new FormEngine(model, runner);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = (): number => this.version;

  get isDirty(): boolean {
    return this.dirtyFlag;
  }
  get hasFields(): boolean {
    return this.model.fields.length > 0;
  }

  value(name: string): FieldValue | undefined {
    return this.engine.getValue(name);
  }
  display(name: string): string {
    return this.engine.getDisplay(name);
  }

  commit(name: string, value: FieldValue): CommitResult {
    const r = this.engine.commit(name, value);
    if (r.accepted) {
      for (const n of r.changed.keys()) this.touched.add(n);
      if (r.changed.size) this.dirtyFlag = true;
      this.bump();
    }
    return r;
  }

  reset(): CommitResult {
    const r = this.engine.reset();
    for (const n of r.changed.keys()) this.touched.add(n);
    if (r.changed.size) this.dirtyFlag = true;
    this.bump();
    return r;
  }

  /** Values changed since load/save plus the formatted text to draw for them. */
  pendingWrite(): { values: Map<string, FieldValue>; display: Map<string, string> } {
    const values = new Map<string, FieldValue>();
    const display = new Map<string, string>();
    for (const n of this.touched) {
      const v = this.engine.getValue(n);
      if (v === undefined) continue;
      values.set(n, v);
      const shown = this.engine.getDisplay(n);
      if (typeof v === 'string' && shown !== v) display.set(n, shown);
    }
    return { values, display };
  }

  markSaved() {
    this.touched.clear();
    this.dirtyFlag = false;
    this.bump();
  }

  /** All values as a plain object (for JSON export). */
  exportData(): Record<string, FieldValue> {
    const out: Record<string, FieldValue> = {};
    for (const f of this.model.fields) {
      if (f.type === 'pushbutton' || f.type === 'signature') continue;
      out[f.name] = this.engine.getValue(f.name) ?? '';
    }
    return out;
  }

  private bump() {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}
