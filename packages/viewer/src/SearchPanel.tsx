import { forwardRef } from 'react';
import type { SearchState } from './useSearch';

const MAX_LISTED = 500;

export const SearchPanel = forwardRef<HTMLInputElement, { search: SearchState; pageCount: number; textAvailable: boolean }>(
  function SearchPanel({ search: s, pageCount, textAvailable }, inputRef) {
    const count = s.results.length;
    return (
      <div className="pv-search">
        <input
          ref={inputRef}
          className="pv-search-input"
          type="search"
          placeholder="Find in document"
          value={s.query}
          disabled={!textAvailable}
          onChange={(e) => s.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) s.prev();
              else s.next();
            }
          }}
        />
        <div className="pv-search-row">
          <label>
            <input
              type="checkbox"
              checked={s.options.caseSensitive}
              onChange={(e) => s.setOptions({ ...s.options, caseSensitive: e.target.checked })}
            />
            Match case
          </label>
          <label>
            <input
              type="checkbox"
              checked={s.options.wholeWord}
              onChange={(e) => s.setOptions({ ...s.options, wholeWord: e.target.checked })}
            />
            Whole words
          </label>
        </div>
        <div className="pv-search-row">
          <button onClick={s.prev} disabled={!count} aria-label="Previous match">
            ▲
          </button>
          <button onClick={s.next} disabled={!count} aria-label="Next match">
            ▼
          </button>
          <span className="pv-muted" aria-live="polite">
            {!s.query.trim()
              ? ''
              : s.running
                ? `${count} found · searching ${s.pagesDone}/${pageCount}`
                : count
                  ? `${s.active + 1} of ${count}`
                  : 'No results'}
          </span>
        </div>
        {!textAvailable && <p className="pv-muted">Search is unavailable for this engine.</p>}
        <ul className="pv-results">
          {s.results.slice(0, MAX_LISTED).map((r, i) => (
            <li key={`${r.page}-${r.start}`}>
              <button className={i === s.active ? 'pv-result pv-result-active' : 'pv-result'} onClick={() => s.setActive(i)}>
                <span className="pv-result-page">p.{r.page + 1}</span>
                <span className="pv-result-text">
                  …{r.before}
                  <mark>{r.text}</mark>
                  {r.after}…
                </span>
              </button>
            </li>
          ))}
          {count > MAX_LISTED && <li className="pv-muted">Showing first {MAX_LISTED} of {count}</li>}
        </ul>
      </div>
    );
  },
);
