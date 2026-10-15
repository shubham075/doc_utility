import { describe, expect, it, vi } from 'vitest';
import { baseFields, type Annotation, type NoteAnnotation, type ReplyAnnotation } from './model';
import { AnnotationStore } from './store';

const note = (id: string, x = 0): NoteAnnotation => ({ ...baseFields(0, 'me', '#ffeb3b'), id, type: 'note', x, y: 0 });
const reply = (id: string, parentId: string): ReplyAnnotation => ({ ...baseFields(0, 'me', '#000000'), id, type: 'reply', parentId });

describe('AnnotationStore', () => {
  it('adds, updates and removes with undo/redo', () => {
    const s = new AnnotationStore();
    s.add(note('a'));
    s.update('a', { contents: 'hi' } as Partial<Annotation>);
    expect(s.get('a')!.contents).toBe('hi');
    s.undo();
    expect(s.get('a')!.contents).toBe('');
    s.undo();
    expect(s.getAll()).toHaveLength(0);
    s.redo();
    s.redo();
    expect(s.get('a')!.contents).toBe('hi');
    s.remove('a');
    expect(s.getAll()).toHaveLength(0);
    s.undo();
    expect(s.get('a')).toBeDefined();
  });

  it('removes replies together with their parent in one undo step', () => {
    const s = new AnnotationStore([note('p'), reply('r1', 'p'), reply('r2', 'p'), note('other')]);
    s.remove('p');
    expect(s.getAll().map((a) => a.id)).toEqual(['other']);
    s.undo();
    expect(s.getAll().map((a) => a.id)).toEqual(['p', 'r1', 'r2', 'other']); // original order restored
    expect(s.repliesOf('p')).toHaveLength(2);
  });

  it('groups transactions into a single undo step', () => {
    const s = new AnnotationStore();
    s.transact('batch', () => {
      s.add(note('a'));
      s.add(note('b'));
    });
    expect(s.getAll()).toHaveLength(2);
    s.undo();
    expect(s.getAll()).toHaveLength(0);
  });

  it('coalesces rapid edits with the same key', () => {
    const s = new AnnotationStore([note('a')]);
    s.update('a', { contents: 'h' } as Partial<Annotation>, { coalesceKey: 'type:a' });
    s.update('a', { contents: 'he' } as Partial<Annotation>, { coalesceKey: 'type:a' });
    s.update('a', { contents: 'hel' } as Partial<Annotation>, { coalesceKey: 'type:a' });
    s.undo();
    expect(s.get('a')!.contents).toBe('');
    expect(s.canUndo).toBe(false);
  });

  it('clears redo on a new edit and tracks dirty/touched state', () => {
    const s = new AnnotationStore([note('a')]);
    expect(s.isDirty).toBe(false);
    s.update('a', { contents: 'x' } as Partial<Annotation>);
    expect(s.isDirty).toBe(true);
    expect([...s.touchedIds]).toEqual(['a']);
    s.markSaved();
    expect(s.isDirty).toBe(false);
    expect(s.touchedIds.size).toBe(0);
    s.undo();
    expect(s.isDirty).toBe(true);
    expect(s.canRedo).toBe(true);
    s.add(note('b'));
    expect(s.canRedo).toBe(false);
  });

  it('notifies subscribers once per transaction and exposes stable snapshots', () => {
    const s = new AnnotationStore();
    const fn = vi.fn();
    s.subscribe(fn);
    const before = s.getAll();
    expect(s.getAll()).toBe(before);
    s.transact('x', () => {
      s.add(note('a'));
      s.add(note('b'));
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.getAll()).not.toBe(before);
  });
});
