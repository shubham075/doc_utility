/**
 * A page plan is the desired final page list. Each item points at a source page (of the document being
 * edited or of an extra document) or is a blank page, with an extra rotation. The organizer UI edits the
 * plan with the pure helpers below; `assemble` turns it into a PDF.
 */
export interface PlanItem {
  /** Stable key for UI lists. */
  id: string;
  /** 0 = the document being edited, 1.. = additional source documents. */
  src: number;
  /** Zero-based source page, or 'blank'. */
  page: number | 'blank';
  /** Extra clockwise rotation in degrees (multiple of 90). */
  rotate: number;
  /** Size of a blank page in points. */
  blank?: { width: number; height: number };
}

let counter = 0;
export const newItemId = () => `p${Date.now().toString(36)}${(counter++).toString(36)}`;

export const identityPlan = (pageCount: number): PlanItem[] =>
  Array.from({ length: pageCount }, (_, i) => ({ id: newItemId(), src: 0, page: i, rotate: 0 }));

export const normaliseTurn = (deg: number): number => ((Math.round(deg / 90) * 90) % 360 + 360) % 360;

export const isIdentity = (items: readonly PlanItem[], pageCount: number): boolean =>
  items.length === pageCount && items.every((it, i) => it.src === 0 && it.page === i && normaliseTurn(it.rotate) === 0);

export function rotateItems(items: PlanItem[], ids: ReadonlySet<string>, delta: number): PlanItem[] {
  return items.map((it) => (ids.has(it.id) ? { ...it, rotate: normaliseTurn(it.rotate + delta) } : it));
}

export const deleteItems = (items: PlanItem[], ids: ReadonlySet<string>): PlanItem[] => items.filter((it) => !ids.has(it.id));

/** Copy the given items right after their last member (Acrobat's "duplicate"). */
export function duplicateItems(items: PlanItem[], ids: ReadonlySet<string>): PlanItem[] {
  const picked = items.filter((it) => ids.has(it.id));
  if (!picked.length) return items;
  const lastIndex = items.reduce((acc, it, i) => (ids.has(it.id) ? i : acc), -1);
  const copies = picked.map((it) => ({ ...it, id: newItemId() }));
  return [...items.slice(0, lastIndex + 1), ...copies, ...items.slice(lastIndex + 1)];
}

/**
 * Move the selected items (keeping their relative order) so they start at `toIndex`, where `toIndex`
 * counts positions among the items that are NOT being moved (0 = very front, n = very end).
 */
export function moveItems(items: PlanItem[], ids: ReadonlySet<string>, toIndex: number): PlanItem[] {
  const moving = items.filter((it) => ids.has(it.id));
  const rest = items.filter((it) => !ids.has(it.id));
  const at = Math.max(0, Math.min(toIndex, rest.length));
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

export function insertBlank(items: PlanItem[], afterIndex: number, size: { width: number; height: number }, count = 1): PlanItem[] {
  const blanks: PlanItem[] = Array.from({ length: count }, () => ({ id: newItemId(), src: 0, page: 'blank', rotate: 0, blank: size }));
  return [...items.slice(0, afterIndex + 1), ...blanks, ...items.slice(afterIndex + 1)];
}

/** Items for pages `indices` of source `src` (used for merge / insert-from-file). */
export const itemsFromSource = (src: number, indices: readonly number[]): PlanItem[] =>
  indices.map((page) => ({ id: newItemId(), src, page, rotate: 0 }));
