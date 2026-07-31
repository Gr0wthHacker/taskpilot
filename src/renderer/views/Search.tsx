/**
 * Search view (`/search`) — the deep, filterable full-text search results page
 * (Wave 17).
 *
 * - Autofocused, debounced search box. The query is mirrored into the URL
 *   (`?q=...`) so the palette's "See all results →" deep-links here and the
 *   page is shareable / reloadable.
 * - Entity-type filter chips (All / Tasks / Decisions / Outputs / Attachments).
 * - Ranked results list with `<mark>` snippet highlights + entity badges;
 *   clicking a result navigates to its owning task.
 * - Result count, loading + empty states.
 *
 * The command-palette path reuses the same `useSearch` hook + `SearchResult`
 * row component, so ranking and rendering stay consistent across both.
 */

import { Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { SearchResult } from '@/renderer/components/search/SearchResult';
import { VirtualList } from '@/renderer/components/shared/VirtualList';
import { Input } from '@/renderer/components/ui/input';
import { cn } from '@/renderer/lib/utils';
import { useSearch } from '@/renderer/lib/query';
import type { SearchEntityType } from '@/shared/api-contract';

/** Filter chips. `null` value = "All" (no type restriction). */
const FILTERS: Array<{ label: string; value: SearchEntityType | null }> = [
  { label: 'All', value: null },
  { label: 'Tasks', value: 'task' },
  { label: 'Decisions', value: 'decision' },
  { label: 'Outputs', value: 'execution' },
  { label: 'Attachments', value: 'attachment' },
];

/** Debounce a value by `delayMs`. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export default function Search(): JSX.Element {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const initialQuery = params.get('q') ?? '';

  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<SearchEntityType | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQuery = useDebounced(query, 200);

  // Autofocus on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Sync the (debounced) query into the URL so the page is reloadable +
  // deep-linkable. Replace (not push) so typing doesn't spam history.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debouncedQuery.trim().length > 0) {
      next.set('q', debouncedQuery.trim());
    } else {
      next.delete('q');
    }
    setParams(next, { replace: true });
    // params intentionally omitted: we only want to react to the query value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  const types = useMemo<SearchEntityType[]>(
    () => (filter === null ? [] : [filter]),
    [filter],
  );

  const searchQ = useSearch(debouncedQuery, types, { limit: 50 });
  const results = searchQ.data?.results ?? [];
  const hasQuery = debouncedQuery.trim().length >= 2;

  const [selectedIndex, setSelectedIndex] = useState(0);
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery, filter]);

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (results.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const r = results[selectedIndex];
      if (r) navigate(`/task/${r.task_id}`);
    }
  };

  return (
    <div
      aria-label="view-search"
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 p-6"
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">
          Tasks, decisions, execution outputs, and attachments.
        </p>
      </div>

      {/* Search box */}
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search everything…"
          aria-label="search-input"
          className="h-11 pl-9 text-base"
        />
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="search-filters">
        {FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <button
              key={f.label}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={`search-filter-${f.label.toLowerCase()}`}
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-accent/50',
              )}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Result count */}
      {hasQuery && (
        <div className="text-xs text-muted-foreground" aria-label="search-result-count">
          {searchQ.isLoading
            ? 'Searching…'
            : `${results.length} result${results.length === 1 ? '' : 's'}`}
          {searchQ.data && !searchQ.data.fts_available && (
            <span className="ml-2 italic">(basic match — FTS unavailable)</span>
          )}
        </div>
      )}

      {/* Results */}
      <div
        role="listbox"
        aria-label="search-results"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
      >
        {!hasQuery ? (
          <div className="flex flex-1 items-center justify-center py-16 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search.
          </div>
        ) : searchQ.isError ? (
          <div className="flex flex-1 items-center justify-center py-16 text-center text-sm text-destructive">
            Search failed. Is the local API running?
          </div>
        ) : results.length === 0 && !searchQ.isLoading ? (
          <div
            className="flex flex-1 items-center justify-center py-16 text-center text-sm text-muted-foreground"
            aria-label="search-empty"
          >
            No results for “{debouncedQuery.trim()}”.
          </div>
        ) : (
          <VirtualList
            items={results}
            estimateSize={() => 88}
            getKey={(r) => `${r.entity_type}:${r.entity_id}`}
            className="flex-1 min-h-[200px]"
            ariaLabel="search-results-virtual"
            renderRow={(result, index) => (
              <div className="pb-1">
                <SearchResult
                  result={result}
                  selected={index === selectedIndex}
                  dataIndex={index}
                  onSelect={(r) => navigate(`/task/${r.task_id}`)}
                  onHover={() => setSelectedIndex(index)}
                />
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
