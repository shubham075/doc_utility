import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchDocument, type SearchMatch, type SearchOptions, type TextSource } from './search';

export interface SearchState {
  query: string;
  setQuery(q: string): void;
  options: SearchOptions;
  setOptions(o: SearchOptions): void;
  results: SearchMatch[];
  /** Index into `results`, or -1. */
  active: number;
  setActive(i: number): void;
  next(): void;
  prev(): void;
  running: boolean;
  pagesDone: number;
  byPage: Map<number, SearchMatch[]>;
}

/** Debounced, cancellable whole-document search. Results stream in page order. */
export function useSearch(source: TextSource | null): SearchState {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false });
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [active, setActive] = useState(-1);
  const [running, setRunning] = useState(false);
  const [pagesDone, setPagesDone] = useState(0);

  useEffect(() => {
    setResults([]);
    setActive(-1);
    setPagesDone(0);
    if (!source || !query.trim()) {
      setRunning(false);
      return;
    }
    const ac = new AbortController();
    setRunning(true);
    const timer = setTimeout(() => {
      let buffer: SearchMatch[] = [];
      let lastFlush = 0;
      const flush = (done: number) => {
        if (buffer.length) {
          const add = buffer;
          buffer = [];
          setResults((prev) => prev.concat(add));
          setActive((a) => (a === -1 ? 0 : a));
        }
        setPagesDone(done);
        lastFlush = performance.now();
      };
      searchDocument(source, query, options, {
        signal: ac.signal,
        onPage: (_p, matches, done) => {
          buffer.push(...matches);
          if (done === source.pageCount || performance.now() - lastFlush > 100) flush(done);
        },
      }).finally(() => {
        if (!ac.signal.aborted) {
          flush(source.pageCount);
          setRunning(false);
        }
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [source, query, options]);

  const step = useCallback(
    (d: 1 | -1) => setActive((a) => (results.length ? (a + d + results.length) % results.length : -1)),
    [results.length],
  );

  const byPage = useMemo(() => {
    const m = new Map<number, SearchMatch[]>();
    for (const r of results) {
      const list = m.get(r.page);
      if (list) list.push(r);
      else m.set(r.page, [r]);
    }
    return m;
  }, [results]);

  const nextRef = useRef(step);
  nextRef.current = step;

  return {
    query,
    setQuery,
    options,
    setOptions,
    results,
    active,
    setActive,
    next: () => nextRef.current(1),
    prev: () => nextRef.current(-1),
    running,
    pagesDone,
    byPage,
  };
}
