import type { Annotation } from './model';

interface Change {
  before?: Annotation;
  after?: Annotation;
  /** Position in the ordered list (for restoring z-order on undo of a removal). */
  index: number;
}

interface Transaction {
  label: string;
  changes: Map<string, Change>;
  coalesceKey?: string;
  time: number;
}

export interface UpdateOptions {
  /** Consecutive updates with the same key within `COALESCE_MS` become one undo step (e.g. typing). */
  coalesceKey?: string;
}

const COALESCE_MS = 1500;
const MAX_HISTORY = 200;

/**
 * Observable annotation collection with transactional undo/redo.
 * Annotations are immutable records; every mutation replaces the record.
 */
export class AnnotationStore {
  private list: Annotation[] = [];
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private current: Transaction | null = null;
  private listeners = new Set<() => void>();
  private snapshot: readonly Annotation[] = [];
  private version = 0;
  private savedVersion = 0;
  private touched = new Set<string>();

  constructor(initial: Annotation[] = []) {
    this.list = [...initial];
    this.snapshot = Object.freeze([...this.list]);
  }

  // ---- reading (stable references for useSyncExternalStore)
  getAll = (): readonly Annotation[] => this.snapshot;
  getVersion = (): number => this.version;
  get(id: string): Annotation | undefined {
    return this.list.find((a) => a.id === id);
  }
  repliesOf(id: string): Annotation[] {
    return this.list.filter((a) => a.type === 'reply' && a.parentId === id);
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get isDirty() {
    return this.version !== this.savedVersion;
  }
  /** Ids added/changed since load or the last save (the writer rewrites only these). */
  get touchedIds(): ReadonlySet<string> {
    return this.touched;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  markSaved() {
    this.savedVersion = this.version;
    this.touched.clear();
    this.emit();
  }

  // ---- mutation
  add(a: Annotation) {
    this.transact('Add ' + a.type, () => {
      this.record(a.id, undefined, a, this.list.length);
      this.list.push(a);
    });
  }

  update(id: string, patch: Partial<Annotation>, opts: UpdateOptions = {}) {
    const idx = this.list.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const before = this.list[idx]!;
    const after = { ...before, ...patch, id, type: before.type, modifiedAt: new Date().toISOString() } as Annotation;
    this.transact(
      'Edit ' + before.type,
      () => {
        this.record(id, before, after, idx);
        this.list[idx] = after;
      },
      opts.coalesceKey,
    );
  }

  /** Removes an annotation and (for comments) its replies. */
  remove(id: string) {
    const target = this.get(id);
    if (!target) return;
    this.transact('Delete ' + target.type, () => {
      // Record original indices first: they shift as items are spliced out.
      const doomed = this.list
        .map((a, index) => ({ a, index }))
        .filter(({ a }) => a.id === id || (a.type === 'reply' && a.parentId === id));
      for (const { a, index } of doomed) this.record(a.id, a, undefined, index);
      this.list = this.list.filter((a) => !doomed.some((d) => d.a === a));
    });
  }

  /** Group several mutations into one undo step. */
  transact(label: string, fn: () => void, coalesceKey?: string) {
    if (this.current) {
      fn();
      return;
    }
    const tx: Transaction = { label, changes: new Map(), coalesceKey, time: Date.now() };
    this.current = tx;
    try {
      fn();
    } finally {
      this.current = null;
    }
    if (!tx.changes.size) return;
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && coalesceKey && last.coalesceKey === coalesceKey && tx.time - last.time < COALESCE_MS) {
      for (const [id, c] of tx.changes) {
        const prev = last.changes.get(id);
        last.changes.set(id, prev ? { ...prev, after: c.after } : c);
      }
      last.time = tx.time;
    } else {
      this.undoStack.push(tx);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
    this.version++;
    this.refresh();
  }

  undo() {
    const tx = this.undoStack.pop();
    if (!tx) return;
    this.apply(tx, 'before');
    this.redoStack.push(tx);
    this.version++;
    this.refresh();
  }

  redo() {
    const tx = this.redoStack.pop();
    if (!tx) return;
    this.apply(tx, 'after');
    this.undoStack.push(tx);
    this.version++;
    this.refresh();
  }

  // ---- internals
  private record(id: string, before: Annotation | undefined, after: Annotation | undefined, index: number) {
    const tx = this.current!;
    const prev = tx.changes.get(id);
    tx.changes.set(id, { before: prev ? prev.before : before, after, index: prev ? prev.index : index });
    this.touched.add(id);
  }

  private apply(tx: Transaction, side: 'before' | 'after') {
    // Remove everything the transaction touched, then re-insert target states by original index.
    const entries = [...tx.changes.entries()];
    for (const [id] of entries) {
      const i = this.list.findIndex((a) => a.id === id);
      if (i >= 0) this.list.splice(i, 1);
    }
    const target = entries
      .map(([id, c]) => ({ id, a: c[side], index: c.index }))
      .filter((e): e is { id: string; a: Annotation; index: number } => !!e.a)
      .sort((x, y) => x.index - y.index);
    for (const e of target) {
      this.list.splice(Math.min(e.index, this.list.length), 0, e.a);
      this.touched.add(e.id);
    }
    for (const [id, c] of entries) if (!c[side]) this.touched.add(id);
  }

  private refresh() {
    this.snapshot = Object.freeze([...this.list]);
    this.emit();
  }

  private emit() {
    for (const l of [...this.listeners]) l();
  }
}
