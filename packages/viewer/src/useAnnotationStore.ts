import { useSyncExternalStore } from 'react';
import type { Annotation, AnnotationStore } from '@pdfsuite/annotations';

/** Subscribes a component to the store; re-renders on every committed change. */
export function useAnnotations(store: AnnotationStore | undefined): readonly Annotation[] {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getAll : emptyAll,
    store ? store.getAll : emptyAll,
  );
}

const EMPTY: readonly Annotation[] = Object.freeze([]);
const emptyAll = () => EMPTY;
const noopSubscribe = () => () => undefined;

/** Tracks undo/redo/dirty flags (they change with the version counter). */
export function useStoreFlags(store: AnnotationStore | undefined) {
  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getVersion : zero,
    store ? store.getVersion : zero,
  );
  return {
    canUndo: !!store?.canUndo,
    canRedo: !!store?.canRedo,
    dirty: !!store?.isDirty,
  };
}
const zero = () => 0;
