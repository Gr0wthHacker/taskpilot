/**
 * Graph view (Wave 17) — the cross-task knowledge graph.
 *
 * Shows how tasks relate: parent/child, blocks/related/duplicate links, and
 * chains to external artifacts (PRs, issues, calendar events) plus optional
 * goal membership. The canvas is a hand-rolled SVG force layout (no graph
 * library); clicking a task node navigates to its detail view, clicking an
 * artifact node with a URL opens it externally.
 *
 * Scope is driven by the URL query string so the "View in graph" link from
 * TaskDetail (`/graph?root=<id>`) deep-links into a focused neighborhood:
 *   - `?root=<task-id>`  → root scope (task + ancestors + descendants + links)
 *   - `?workspace=<id>`  → workspace scope
 *   - `?tag=<tag>`       → tag scope
 *   - (none)             → all
 */

import { useMemo } from 'react';
import { Share2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { GraphCanvas } from '@/renderer/components/graph/GraphCanvas';
import { GraphLegend } from '@/renderer/components/graph/GraphLegend';
import { useTaskGraph, useTasksList } from '@/renderer/lib/query';
import { useWorkspaceStore } from '@/renderer/store/workspace';
import { cn } from '@/renderer/lib/utils';
import type { GraphNode, GraphScope } from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  External-link helper                                                       */
/* -------------------------------------------------------------------------- */

interface OpenExternalBridge {
  openExternal?: (url: string) => Promise<unknown> | void;
  shell?: { openExternal?: (url: string) => Promise<void> | void };
}

async function openExternal(url: string): Promise<void> {
  const bridge = (window as unknown as { taskpilot?: OpenExternalBridge })
    .taskpilot;
  if (bridge?.openExternal) {
    await bridge.openExternal(url);
    return;
  }
  if (bridge?.shell?.openExternal) {
    await bridge.shell.openExternal(url);
    return;
  }
  // Browser fallback (dev preview).
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* -------------------------------------------------------------------------- */
/*  Scope parsing                                                              */
/* -------------------------------------------------------------------------- */

function parseScope(params: URLSearchParams): GraphScope {
  const root = params.get('root');
  if (root) return { kind: 'root', value: root };
  const workspace = params.get('workspace');
  if (workspace) return { kind: 'workspace', value: workspace };
  const tag = params.get('tag');
  if (tag) return { kind: 'tag', value: tag };
  return { kind: 'all' };
}

/* -------------------------------------------------------------------------- */
/*  View                                                                       */
/* -------------------------------------------------------------------------- */

export default function Graph(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const scope = useMemo(() => parseScope(params), [params]);
  const graphQuery = useTaskGraph(scope);

  // Tag options — derive from the full task list so the picker reflects what
  // actually exists.
  const tasksQuery = useTasksList();
  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasksQuery.data?.tasks ?? []) {
      for (const tag of t.tags) set.add(tag);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [tasksQuery.data]);

  const setScope = (next: GraphScope): void => {
    const p = new URLSearchParams();
    if (next.kind === 'workspace' && next.value) p.set('workspace', next.value);
    else if (next.kind === 'tag' && next.value) p.set('tag', next.value);
    else if (next.kind === 'root' && next.value) p.set('root', next.value);
    setParams(p);
  };

  const handleNodeClick = (node: GraphNode): void => {
    if (node.kind === 'task') {
      navigate(`/task/${node.id}`);
      return;
    }
    if (node.url) {
      void openExternal(node.url);
    }
  };

  const graph = graphQuery.data;
  const isEmpty =
    !graphQuery.isLoading && graph !== undefined && graph.nodes.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Share2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Graph</h1>
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">
          How your work connects — parents, blocks, related tasks, and the PRs,
          issues, and events they produce.
        </p>

        {/* Scope selector */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ScopeButton
            label="All"
            active={scope.kind === 'all'}
            onClick={() => setScope({ kind: 'all' })}
          />
          {scope.kind === 'root' && (
            <ScopeButton label="Focused task" active onClick={() => undefined} />
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Workspace
            <select
              aria-label="graph-scope-workspace"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={scope.kind === 'workspace' ? (scope.value ?? '') : ''}
              onChange={(e) => {
                if (e.target.value) setScope({ kind: 'workspace', value: e.target.value });
                else setScope({ kind: 'all' });
              }}
            >
              <option value="">—</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Tag
            <select
              aria-label="graph-scope-tag"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={scope.kind === 'tag' ? (scope.value ?? '') : ''}
              onChange={(e) => {
                if (e.target.value) setScope({ kind: 'tag', value: e.target.value });
                else setScope({ kind: 'all' });
              }}
            >
              <option value="">—</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
        </div>

        {graph?.truncated && (
          <div
            className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
            aria-label="graph-truncated-warning"
          >
            Showing the first {graph.node_cap} tasks. Narrow the scope (by
            workspace, tag, or focus a task) to see the rest.
          </div>
        )}
      </header>

      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        <div className="relative flex-1">
          {graphQuery.isLoading && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Building graph…
            </div>
          )}
          {graphQuery.isError && (
            <div className="flex h-full items-center justify-center text-sm text-red-600">
              Failed to load the graph.
            </div>
          )}
          {isEmpty && (
            <div
              className="flex h-full flex-col items-center justify-center gap-1 text-center"
              aria-label="graph-empty-state"
            >
              <Share2 className="h-8 w-8 text-muted-foreground/50" />
              <div className="text-sm font-medium">No tasks in this scope</div>
              <div className="text-xs text-muted-foreground">
                Create tasks and link them to see how your work connects.
              </div>
            </div>
          )}
          {!graphQuery.isLoading && !isEmpty && graph && (
            <GraphCanvas graph={graph} onNodeClick={handleNodeClick} />
          )}
        </div>
        <GraphLegend />
      </div>
    </div>
  );
}

interface ScopeButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function ScopeButton({ label, active, onClick }: ScopeButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-transparent bg-accent text-accent-foreground'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
