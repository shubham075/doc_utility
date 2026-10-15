import { useEffect, useMemo, useRef, useState } from 'react';
import {
  REVIEW_STATUSES,
  TYPE_LABELS,
  annotationBounds,
  baseFields,
  type Annotation,
  type AnnotationStore,
  type AnnotationType,
  type ReviewStatus,
} from '@pdfsuite/annotations';

interface Props {
  store: AnnotationStore;
  annotations: readonly Annotation[];
  selectedId: string | null;
  onSelect(id: string): void;
  author: string;
  onAuthorChange(name: string): void;
  /** When set, the matching comment's text box takes focus (e.g. right after creating a note). */
  focusId: string | null;
}

const STATUS_LABEL: Record<ReviewStatus, string> = {
  none: 'No status',
  accepted: 'Accepted',
  rejected: 'Rejected',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.getTime() > 86_400_000 ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
};

export function CommentsPanel({ store, annotations, selectedId, onSelect, author, onAuthorChange, focusId }: Props) {
  const [text, setText] = useState('');
  const [type, setType] = useState<AnnotationType | ''>('');
  const [status, setStatus] = useState<ReviewStatus | ''>('');
  const [who, setWho] = useState('');

  const parents = useMemo(
    () =>
      annotations
        .filter((a) => a.type !== 'reply')
        .sort((a, b) => a.page - b.page || annotationBounds(a).y - annotationBounds(b).y || annotationBounds(a).x - annotationBounds(b).x),
    [annotations],
  );
  const repliesBy = useMemo(() => {
    const m = new Map<string, Annotation[]>();
    for (const a of annotations) {
      if (a.type !== 'reply') continue;
      const l = m.get(a.parentId);
      if (l) l.push(a);
      else m.set(a.parentId, [a]);
    }
    return m;
  }, [annotations]);
  const authors = useMemo(() => [...new Set(annotations.map((a) => a.author).filter(Boolean))].sort(), [annotations]);
  const types = useMemo(() => [...new Set(parents.map((a) => a.type))], [parents]);

  const q = text.trim().toLowerCase();
  const shown = parents.filter(
    (a) =>
      (!type || a.type === type) &&
      (!status || a.status === status) &&
      (!who || a.author === who) &&
      (!q || a.contents.toLowerCase().includes(q) || a.author.toLowerCase().includes(q) || (repliesBy.get(a.id) ?? []).some((r) => r.contents.toLowerCase().includes(q))),
  );

  return (
    <div className="pv-comments">
      <div className="pv-search-row">
        <label className="pv-muted" htmlFor="pv-author">
          Author
        </label>
        <input id="pv-author" className="pv-search-input" value={author} onChange={(e) => onAuthorChange(e.target.value)} />
      </div>
      <input className="pv-search-input" type="search" placeholder="Filter comments" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="pv-search-row">
        <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value as AnnotationType | '')}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as ReviewStatus | '')}>
          <option value="">Any status</option>
          {REVIEW_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        {authors.length > 1 && (
          <select aria-label="Filter by author" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">All authors</option>
            {authors.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        )}
      </div>
      <div className="pv-muted" aria-live="polite">
        {shown.length === parents.length ? `${parents.length} comments` : `${shown.length} of ${parents.length} comments`}
      </div>
      <ul className="pv-comment-list">
        {shown.map((a) => (
          <CommentItem
            key={a.id}
            a={a}
            replies={repliesBy.get(a.id) ?? []}
            selected={a.id === selectedId}
            focus={a.id === focusId}
            store={store}
            author={author}
            onSelect={() => onSelect(a.id)}
          />
        ))}
        {!parents.length && <li className="pv-muted">No comments yet. Pick a tool from the annotation toolbar.</li>}
      </ul>
    </div>
  );
}

function CommentItem({
  a,
  replies,
  selected,
  focus,
  store,
  author,
  onSelect,
}: {
  a: Annotation;
  replies: Annotation[];
  selected: boolean;
  focus: boolean;
  store: AnnotationStore;
  author: string;
  onSelect(): void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [reply, setReply] = useState('');

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  useEffect(() => {
    if (focus) area.current?.focus();
  }, [focus]);

  const sendReply = () => {
    const t = reply.trim();
    if (!t) return;
    store.add({ ...baseFields(a.page, author, '#000000'), type: 'reply', parentId: a.id, contents: t });
    setReply('');
  };

  return (
    <li ref={ref} className={selected ? 'pv-comment pv-comment-selected' : 'pv-comment'} data-comment={a.id}>
      <button className="pv-comment-head" onClick={onSelect}>
        <span className="pv-swatch" style={{ background: a.color }} />
        <strong>{TYPE_LABELS[a.type]}</strong>
        <span className="pv-muted">p.{a.page + 1}</span>
        {a.status !== 'none' && <span className="pv-badge">{STATUS_LABEL[a.status]}</span>}
      </button>
      <div className="pv-muted pv-comment-meta">
        {a.author || 'Unknown'} {fmtDate(a.modifiedAt) && `· ${fmtDate(a.modifiedAt)}`}
      </div>
      <textarea
        ref={area}
        className="pv-comment-text"
        placeholder="Add a comment…"
        rows={selected || a.contents ? 2 : 1}
        value={a.contents}
        onFocus={onSelect}
        onChange={(e) => store.update(a.id, { contents: e.target.value } as Partial<Annotation>, { coalesceKey: `c:${a.id}` })}
      />
      {replies.map((r) => (
        <div key={r.id} className="pv-reply">
          <div className="pv-muted pv-comment-meta">
            {r.author || 'Unknown'} {fmtDate(r.modifiedAt) && `· ${fmtDate(r.modifiedAt)}`}
            <button className="pv-link" onClick={() => store.remove(r.id)} aria-label="Delete reply">
              ✕
            </button>
          </div>
          <div>{r.contents}</div>
        </div>
      ))}
      {selected && (
        <div className="pv-comment-actions">
          <input
            className="pv-search-input"
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendReply()}
          />
          <select
            aria-label="Review status"
            value={a.status}
            onChange={(e) => store.update(a.id, { status: e.target.value as ReviewStatus } as Partial<Annotation>)}
          >
            {REVIEW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button onClick={() => store.remove(a.id)}>Delete</button>
        </div>
      )}
    </li>
  );
}
