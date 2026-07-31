/**
 * CommandPalette — the ⌘K/Ctrl-K spotlight modal.
 *
 * Behavior:
 *   - Substring match on label + keywords (case-insensitive). Task commands
 *     additionally match against the task id substring so e.g. typing the
 *     first few hex chars of a task ID jumps straight to it.
 *   - ↑/↓ (or J/K) navigates the result list.
 *   - Enter runs the highlighted command then closes the palette.
 *   - Escape closes (handled by the shadcn Dialog).
 *   - Selection always clamps to a valid row when the result list changes.
 *
 * Data flow: the palette pulls the live task list once when mounted so task
 * commands stay fresh. The static command list is built locally; both lists
 * are concatenated and filtered together so the user sees one ranked list.
 *
 * Content search (Wave 17): once the query reaches 3+ chars the palette also
 * hits `GET /api/search` (debounced 200ms, limit 6) and renders the content
 * matches — task descriptions, decisions, execution outputs, attachment
 * filenames — in a dedicated "Search results" group below the command/task
 * matches, plus a "See all N results →" entry that deep-links to `/search`.
 */
import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { SearchResult } from '@/renderer/components/search/SearchResult';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';
import {
  getStaticCommands,
  getTaskCommands,
  type CommandContext,
  type CommandGroup,
  type PaletteCommand,
} from '@/renderer/lib/commands';
import { useSearch, useTasksList } from '@/renderer/lib/query';
import type { SearchResult as SearchResultData } from '@/shared/api-contract';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenNewTaskDialog: () => void;
}

/**
 * Hash-based navigation. Matches the navigation strategy in
 * `KeyboardShortcutsProvider` so the palette can be mounted outside the
 * react-router context — required because the palette is rendered as a
 * sibling of `<RouterProvider>` in `App.tsx`.
 */
function navigateHash(to: string): void {
  if (typeof window === 'undefined') return;
  const normalized = to.startsWith('/') ? to : `/${to}`;
  window.location.hash = `#${normalized}`;
}

const GROUP_LABELS: Record<CommandGroup, string> = {
  navigate: 'Navigate',
  create: 'Create',
  action: 'Action',
  task: 'Task',
};

const GROUP_ORDER: Record<CommandGroup, number> = {
  create: 0,
  navigate: 1,
  action: 2,
  task: 3,
};

/** Lowercase + keyword index used for filtering. */
interface IndexedCommand {
  command: PaletteCommand;
  haystack: string;
}

function buildIndex(command: PaletteCommand): IndexedCommand {
  const parts = [command.label, ...(command.keywords ?? [])];
  return {
    command,
    haystack: parts.join(' ').toLowerCase(),
  };
}

function filterAndRank(
  commands: IndexedCommand[],
  rawQuery: string,
): PaletteCommand[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    // No query → show everything, ordered by group then label.
    return [...commands]
      .map((c) => c.command)
      .sort((a, b) => {
        const ga = GROUP_ORDER[a.group];
        const gb = GROUP_ORDER[b.group];
        if (ga !== gb) return ga - gb;
        return a.label.localeCompare(b.label);
      });
  }

  // Split into tokens so multi-word queries match in any order.
  const tokens = query.split(/\s+/).filter(Boolean);
  const matched: Array<{ command: PaletteCommand; score: number }> = [];
  for (const entry of commands) {
    let allMatch = true;
    let score = 0;
    for (const token of tokens) {
      const idx = entry.haystack.indexOf(token);
      if (idx === -1) {
        allMatch = false;
        break;
      }
      // Earlier match → lower score (better). Bonus for label-prefix hit.
      score += idx;
      if (entry.command.label.toLowerCase().startsWith(token)) score -= 100;
    }
    if (allMatch) matched.push({ command: entry.command, score });
  }
  matched.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const ga = GROUP_ORDER[a.command.group];
    const gb = GROUP_ORDER[b.command.group];
    if (ga !== gb) return ga - gb;
    return a.command.label.localeCompare(b.command.label);
  });
  return matched.map((m) => m.command);
}

/**
 * One navigable row in the palette. A row is either a command, a content
 * search hit, or the "see all results" deep-link. Keyboard navigation runs
 * over the flat `rows` array regardless of kind.
 */
type PaletteRow =
  | { kind: 'command'; command: PaletteCommand }
  | { kind: 'result'; result: SearchResultData }
  | { kind: 'see-all'; query: string; total: number };

/** Minimum query length before we hit the content-search endpoint. */
const SEARCH_MIN_CHARS = 3;
/** How many content matches to surface inline in the palette. */
const SEARCH_PALETTE_LIMIT = 6;

export function CommandPalette({
  open,
  onClose,
  onOpenNewTaskDialog,
}: CommandPaletteProps): JSX.Element {
  const { toast } = useToast();
  const tasksQ = useTasksList({});
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Debounce the query (200ms) before it reaches the content-search endpoint.
  // The command/task filtering still uses the live `query` so navigation feels
  // instant; only the network search waits.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(id);
  }, [query]);

  // Content search — only enabled at 3+ chars. The hook itself also guards on
  // length, but gating `enabled` avoids a wasted render cycle.
  const trimmedQuery = debouncedQuery.trim();
  const searchEnabled = open && trimmedQuery.length >= SEARCH_MIN_CHARS;
  const searchQ = useSearch(debouncedQuery, [], {
    limit: SEARCH_PALETTE_LIMIT,
    enabled: searchEnabled,
  });

  // Build the indexed command list. Static commands are pure; task commands
  // depend on the live list, so we memoize on the array reference.
  const indexedCommands = useMemo<IndexedCommand[]>(() => {
    const tasks = tasksQ.data?.tasks ?? [];
    const all: PaletteCommand[] = [
      ...getStaticCommands(),
      ...getTaskCommands(tasks),
    ];
    return all.map(buildIndex);
  }, [tasksQ.data]);

  const filtered = useMemo(
    () => filterAndRank(indexedCommands, query),
    [indexedCommands, query],
  );

  // Task ids already surfaced as command rows — so a content hit on a task's
  // OWN title/description doesn't show twice in the same list.
  const commandTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of filtered) {
      if (c.id.startsWith('task.')) ids.add(c.id.slice('task.'.length));
    }
    return ids;
  }, [filtered]);

  const searchResults = useMemo<SearchResultData[]>(() => {
    if (!searchEnabled) return [];
    const results = searchQ.data?.results ?? [];
    // Drop content hits whose task already appears as a command/task row.
    return results.filter((r) => !commandTaskIds.has(r.task_id));
  }, [searchEnabled, searchQ.data, commandTaskIds]);

  // Flatten everything into one navigable list: commands first, then content
  // search hits, then the "see all" deep-link when there are hits.
  const rows = useMemo<PaletteRow[]>(() => {
    const out: PaletteRow[] = filtered.map((command) => ({
      kind: 'command' as const,
      command,
    }));
    for (const result of searchResults) {
      out.push({ kind: 'result', result });
    }
    if (searchEnabled && searchResults.length > 0) {
      out.push({
        kind: 'see-all',
        query: trimmedQuery,
        total: searchQ.data?.total ?? searchResults.length,
      });
    }
    return out;
  }, [filtered, searchResults, searchEnabled, trimmedQuery, searchQ.data]);

  // Index of the first content-search row, used to render the group header.
  const firstResultRow = filtered.length;

  // Reset query + selection when the palette opens. Don't reset on close
  // because the dialog fade-out would briefly flash empty state.
  useEffect(() => {
    if (open) {
      setQuery('');
      setDebouncedQuery('');
      setSelectedIndex(0);
      // Defer focus until Radix has mounted the content.
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [open]);

  // Clamp selection when the row list shrinks.
  useEffect(() => {
    if (selectedIndex >= rows.length) {
      setSelectedIndex(rows.length > 0 ? rows.length - 1 : 0);
    }
  }, [rows.length, selectedIndex]);

  // Keep the highlighted row scrolled into view as the user arrows around.
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const row = container.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, rows.length]);

  const runCommand = (command: PaletteCommand): void => {
    const ctx: CommandContext = {
      navigate: navigateHash,
      openNewTaskDialog: onOpenNewTaskDialog,
      toast: ({ title, description, variant }) => {
        toast({ title, description, variant });
      },
    };
    // Close before invoking — most commands navigate, and we want the
    // dialog dismissed before route transition triggers re-renders.
    onClose();
    try {
      const maybe = command.run(ctx);
      if (maybe instanceof Promise) {
        // Surface async failures via toast — the command's own handler may
        // already have one, but a stray throw shouldn't go unnoticed.
        maybe.catch((cause) => {
          // eslint-disable-next-line no-console
          console.error('command failed', cause);
        });
      }
    } catch (cause) {
      // eslint-disable-next-line no-console
      console.error('command failed', cause);
    }
  };

  /** Run whatever a given row points at, then close the palette. */
  const runRow = (row: PaletteRow): void => {
    if (row.kind === 'command') {
      runCommand(row.command);
      return;
    }
    if (row.kind === 'result') {
      onClose();
      navigateHash(`/task/${row.result.task_id}`);
      return;
    }
    // see-all → deep-link to the full /search view with the query preserved.
    onClose();
    navigateHash(`/search?q=${encodeURIComponent(row.query)}`);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || (event.key === 'j' && event.ctrlKey)) {
      event.preventDefault();
      setSelectedIndex((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'k' && event.ctrlKey)) {
      event.preventDefault();
      setSelectedIndex((i) =>
        rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[selectedIndex];
      if (row) runRow(row);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-label="command-palette"
        className="max-w-2xl gap-0 p-0"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command palette</DialogTitle>
          <DialogDescription>
            Type to search commands, then press Enter to run.
          </DialogDescription>
        </DialogHeader>
        <div className="border-b border-border px-3 py-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a command or search…"
            aria-label="command-palette-input"
            className="h-9 border-0 bg-transparent px-2 shadow-none focus-visible:ring-0"
          />
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="command-palette-results"
          className="max-h-[60vh] overflow-y-auto py-1"
        >
          {rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              No commands match. Type to search or navigate.
            </div>
          ) : (
            rows.map((row, index) => {
              const isSelected = index === selectedIndex;

              // Group header above the first content-search result.
              const header =
                row.kind === 'result' && index === firstResultRow ? (
                  <div
                    key="search-results-header"
                    className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    aria-label="command-palette-search-group"
                  >
                    Search results
                  </div>
                ) : null;

              if (row.kind === 'command') {
                const Icon = row.command.icon;
                return (
                  <button
                    key={row.command.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-index={index}
                    onClick={() => runRow(row)}
                    onMouseMove={() => setSelectedIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                      isSelected
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-accent/50',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{row.command.label}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                        isSelected
                          ? 'border-accent-foreground/30 text-accent-foreground/80'
                          : 'border-border text-muted-foreground',
                      )}
                    >
                      {GROUP_LABELS[row.command.group]}
                    </span>
                  </button>
                );
              }

              if (row.kind === 'result') {
                return (
                  <div key={`${row.result.entity_type}:${row.result.entity_id}`}>
                    {header}
                    <SearchResult
                      result={row.result}
                      selected={isSelected}
                      compact
                      dataIndex={index}
                      onSelect={() => runRow(row)}
                      onHover={() => setSelectedIndex(index)}
                    />
                  </div>
                );
              }

              // see-all
              return (
                <button
                  key="see-all-results"
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-label="command-palette-see-all"
                  data-index={index}
                  onClick={() => runRow(row)}
                  onMouseMove={() => setSelectedIndex(index)}
                  className={cn(
                    'flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium transition-colors',
                    isSelected
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50',
                  )}
                >
                  <ArrowRight className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">
                    See all {row.total} result{row.total === 1 ? '' : 's'} →
                  </span>
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
