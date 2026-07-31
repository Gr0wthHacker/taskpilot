/**
 * Cross-task knowledge graph builder (Wave 17).
 *
 * Pure aggregation. Given the full task set (plus the workspace config for the
 * `workspace` scope), produces a {@link GraphResponse} of nodes + edges that
 * the renderer lays out with a hand-rolled force simulation.
 *
 * Node taxonomy:
 *   - `task`  — one per task in scope. Carries status/priority for coloring.
 *   - `pr`    — a GitHub pull request referenced by `context.github_pr`.
 *   - `issue` — a GitHub issue referenced by `context.github_issue`.
 *   - `event` — a calendar event referenced by `task.calendar_event_id`.
 *   - `goal`  — optional goal membership (only when the goals module exists;
 *               see {@link GoalMembershipLoader}). Defensive — never a hard dep.
 *
 * Edge taxonomy:
 *   - `parent`    — parent_id chain (parent → child).
 *   - `blocks`    — context.links.blocks (this task → blocked task).
 *   - `related`   — context.links.related (bidirectional; emitted once).
 *   - `duplicate` — context.links.duplicate_of (this task → original).
 *   - `produces`  — task → external artifact node.
 *   - `member_of` — task → goal node.
 *
 * Scopes:
 *   - `{ kind: 'all' }`       — every non-archived task, capped at 200 nodes.
 *   - `{ kind: 'workspace' }` — tasks whose tags intersect the workspace tags.
 *   - `{ kind: 'tag' }`       — tasks carrying the given tag.
 *   - `{ kind: 'root' }`      — a focus task plus its ancestors, descendants,
 *                               and 2-hop linked tasks.
 *
 * The module is deliberately free of I/O beyond the injected loaders so it can
 * be unit-tested against in-memory fixtures. The default loaders read from the
 * tasks + settings repositories.
 */

import { readTaskLinks } from '@/main/links';
import { listTasks } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type {
  GraphEdge,
  GraphNode,
  GraphResponse,
  GraphScope,
} from '@/shared/api-contract';
import type { Task, Workspace } from '@/shared/types';

/** Hard cap on the number of nodes for the unbounded `all` scope. */
export const GRAPH_NODE_CAP = 200;

/* -------------------------------------------------------------------------- */
/*  Loaders (injectable for tests)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Optional goal-membership resolver. Returns the goal id a task belongs to, or
 * `null`. Defaults to a no-op so the builder never hard-depends on the goals
 * module (Wave 17G) existing yet. When the goals module lands it can wire a
 * real resolver here without touching the graph code.
 */
export type GoalMembershipLoader = (task: Task) => { id: string; label: string } | null;

export interface BuildGraphDeps {
  /** Returns every task (archived included) the graph may draw from. */
  loadAllTasks: () => Task[];
  /** Returns the configured workspaces (for the `workspace` scope). */
  loadWorkspaces: () => Workspace[];
  /** Optional goal membership resolver. Defaults to "no goals". */
  loadGoal?: GoalMembershipLoader;
}

/**
 * Default goal loader. Reads `task.context.goal_id` defensively — if the goals
 * module (Wave 17G) writes that field we surface a goal node; otherwise this
 * returns null and no goal edges are emitted. Never throws.
 */
function defaultLoadGoal(task: Task): { id: string; label: string } | null {
  const ctx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : null;
  if (!ctx) return null;
  const goalId = ctx['goal_id'];
  if (typeof goalId !== 'string' || goalId.length === 0) return null;
  const goalTitle = ctx['goal_title'];
  return {
    id: goalId,
    label: typeof goalTitle === 'string' && goalTitle.length > 0 ? goalTitle : goalId,
  };
}

function readWorkspaces(): Workspace[] {
  try {
    const raw = settingsRepository.get<unknown>('workspaces');
    if (!Array.isArray(raw)) return [];
    const out: Workspace[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as Workspace).id === 'string' &&
        Array.isArray((entry as Workspace).tags)
      ) {
        const w = entry as Workspace;
        out.push({
          id: w.id,
          name: typeof w.name === 'string' ? w.name : w.id,
          tags: w.tags.filter((t) => typeof t === 'string'),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Default dependency wiring — reads from the live repositories. */
export const defaultBuildGraphDeps: BuildGraphDeps = {
  loadAllTasks: () => listTasks({ include_archived: true }),
  loadWorkspaces: readWorkspaces,
  loadGoal: defaultLoadGoal,
};

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface BuildGraphOptions {
  scope: GraphScope;
  /** Node cap for the `all` scope. Defaults to {@link GRAPH_NODE_CAP}. */
  nodeCap?: number;
}

/**
 * Build the cross-task knowledge graph for the given scope.
 *
 * Returns a fully materialized {@link GraphResponse}. The function is total —
 * an unknown scope value, a missing workspace, or a missing root task all
 * yield an empty graph rather than throwing.
 */
export function buildGraph(
  options: BuildGraphOptions,
  deps: BuildGraphDeps = defaultBuildGraphDeps,
): GraphResponse {
  const nodeCap = options.nodeCap ?? GRAPH_NODE_CAP;
  const loadGoal = deps.loadGoal ?? defaultLoadGoal;
  const allTasks = deps.loadAllTasks();
  const byId = new Map<string, Task>();
  for (const t of allTasks) byId.set(t.id, t);

  // 1. Select the in-scope task set.
  const { tasks: scopedTasks, truncated } = selectScope(
    options.scope,
    allTasks,
    byId,
    deps.loadWorkspaces,
    nodeCap,
  );

  const scopedIds = new Set(scopedTasks.map((t) => t.id));

  // 2. Emit task nodes.
  const nodes = new Map<string, GraphNode>();
  for (const t of scopedTasks) {
    nodes.set(t.id, {
      id: t.id,
      kind: 'task',
      label: t.title,
      status: t.status,
      priority: t.priority,
    });
  }

  // 3. Walk edges. Only edges where BOTH endpoints are in-scope tasks are
  //    drawn (so a `blocks` edge to a task outside the scope is dropped).
  //    Artifact + goal edges hang off in-scope tasks only.
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  const pushEdge = (e: GraphEdge): void => {
    const key = `${e.kind}:${e.source}->${e.target}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push(e);
  };

  for (const t of scopedTasks) {
    // parent_id → parent edge (parent → child). Only when the parent is in
    // scope, so the focus stays clean.
    if (t.parent_id && scopedIds.has(t.parent_id)) {
      pushEdge({ source: t.parent_id, target: t.id, kind: 'parent' });
    }

    const links = readTaskLinks(t);
    for (const other of links.blocks) {
      if (scopedIds.has(other)) {
        pushEdge({ source: t.id, target: other, kind: 'blocks' });
      }
    }
    for (const other of links.related) {
      if (!scopedIds.has(other)) continue;
      // `related` is symmetric and we don't auto-mirror in storage; dedupe by
      // ordering the pair so A↔B yields a single edge regardless of direction.
      const [a, b] = t.id < other ? [t.id, other] : [other, t.id];
      pushEdge({ source: a, target: b, kind: 'related' });
    }
    if (links.duplicate_of && scopedIds.has(links.duplicate_of)) {
      pushEdge({ source: t.id, target: links.duplicate_of, kind: 'duplicate' });
    }

    // External artifacts → artifact node + `produces` edge.
    for (const artifact of readArtifactNodes(t)) {
      if (!nodes.has(artifact.id)) nodes.set(artifact.id, artifact);
      pushEdge({ source: t.id, target: artifact.id, kind: 'produces' });
    }

    // Goal membership → goal node + `member_of` edge (defensive).
    const goal = safeLoadGoal(loadGoal, t);
    if (goal) {
      const goalNodeId = `goal:${goal.id}`;
      if (!nodes.has(goalNodeId)) {
        nodes.set(goalNodeId, {
          id: goalNodeId,
          kind: 'goal',
          label: goal.label,
        });
      }
      pushEdge({ source: t.id, target: goalNodeId, kind: 'member_of' });
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
    scope: options.scope,
    truncated,
    node_cap: nodeCap,
  };
}

/* -------------------------------------------------------------------------- */
/*  Scope selection                                                            */
/* -------------------------------------------------------------------------- */

interface ScopeResult {
  tasks: Task[];
  truncated: boolean;
}

function selectScope(
  scope: GraphScope,
  allTasks: Task[],
  byId: Map<string, Task>,
  loadWorkspaces: () => Workspace[],
  nodeCap: number,
): ScopeResult {
  switch (scope.kind) {
    case 'all':
      return capTasks(nonArchived(allTasks), nodeCap);
    case 'workspace':
      return { tasks: selectWorkspace(scope.value, allTasks, loadWorkspaces), truncated: false };
    case 'tag':
      return { tasks: selectTag(scope.value, allTasks), truncated: false };
    case 'root':
      return { tasks: selectRoot(scope.value, byId), truncated: false };
    default:
      return { tasks: [], truncated: false };
  }
}

function nonArchived(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status !== 'archived');
}

function capTasks(tasks: Task[], nodeCap: number): ScopeResult {
  if (tasks.length <= nodeCap) return { tasks, truncated: false };
  return { tasks: tasks.slice(0, nodeCap), truncated: true };
}

function selectWorkspace(
  value: string | undefined,
  allTasks: Task[],
  loadWorkspaces: () => Workspace[],
): Task[] {
  if (!value) return [];
  const ws = loadWorkspaces().find((w) => w.id === value);
  if (!ws || ws.tags.length === 0) return [];
  const allowed = new Set(ws.tags.map((t) => t.toLowerCase()));
  return nonArchived(allTasks).filter((t) =>
    t.tags.some((tag) => allowed.has(tag.toLowerCase())),
  );
}

function selectTag(value: string | undefined, allTasks: Task[]): Task[] {
  if (!value) return [];
  const needle = value.toLowerCase();
  return nonArchived(allTasks).filter((t) =>
    t.tags.some((tag) => tag.toLowerCase() === needle),
  );
}

/**
 * Build the focused neighborhood of a root task: the task itself, its full
 * ancestor chain, all transitive descendants, and any task reachable within
 * two link/parent hops. Archived tasks are kept here — when you focus a task
 * you want its whole story, even the cold parts.
 */
function selectRoot(value: string | undefined, byId: Map<string, Task>): Task[] {
  if (!value) return [];
  const root = byId.get(value);
  if (!root) return [];

  const included = new Set<string>([root.id]);

  // Ancestors — walk parent_id up to the top.
  let cursor: Task | undefined = root;
  const guard = new Set<string>();
  while (cursor && cursor.parent_id && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    const parent = byId.get(cursor.parent_id);
    if (!parent) break;
    included.add(parent.id);
    cursor = parent;
  }

  // Descendants — BFS down the parent_id tree (children point up via parent_id).
  const childrenOf = new Map<string, string[]>();
  for (const t of byId.values()) {
    if (t.parent_id) {
      const arr = childrenOf.get(t.parent_id) ?? [];
      arr.push(t.id);
      childrenOf.set(t.parent_id, arr);
    }
  }
  const descQueue: string[] = [root.id];
  while (descQueue.length > 0) {
    const id = descQueue.shift() as string;
    for (const child of childrenOf.get(id) ?? []) {
      if (!included.has(child)) {
        included.add(child);
        descQueue.push(child);
      }
    }
  }

  // Linked tasks — 2 hops out along blocks/related/duplicate AND parent edges.
  // Start frontier is everything gathered so far.
  let frontier = Array.from(included);
  for (let hop = 0; hop < 2; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const task = byId.get(id);
      if (!task) continue;
      for (const neighbor of neighborsOf(task, byId)) {
        if (!included.has(neighbor)) {
          included.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const out: Task[] = [];
  for (const id of included) {
    const t = byId.get(id);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Every other task id directly connected to `task` via parent (either
 * direction), blocks (either direction), related, or duplicate_of.
 */
function neighborsOf(task: Task, byId: Map<string, Task>): string[] {
  const out = new Set<string>();
  if (task.parent_id && byId.has(task.parent_id)) out.add(task.parent_id);

  const links = readTaskLinks(task);
  for (const id of links.blocks) if (byId.has(id)) out.add(id);
  for (const id of links.related) if (byId.has(id)) out.add(id);
  if (links.duplicate_of && byId.has(links.duplicate_of)) out.add(links.duplicate_of);

  // Reverse direction: tasks that name `task` as a child / blocker / dup.
  for (const other of byId.values()) {
    if (other.id === task.id) continue;
    if (other.parent_id === task.id) {
      out.add(other.id);
      continue;
    }
    const otherLinks = readTaskLinks(other);
    if (
      otherLinks.blocks.includes(task.id) ||
      otherLinks.related.includes(task.id) ||
      otherLinks.duplicate_of === task.id
    ) {
      out.add(other.id);
    }
  }
  return Array.from(out);
}

/* -------------------------------------------------------------------------- */
/*  Artifact extraction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pull the external artifact nodes off a task's context. Mirrors the field
 * names the outputs collector reads (`@/main/outputs/collector#readArtifacts`)
 * but emits {@link GraphNode}s rather than the richer OutputArtifact union —
 * the graph only needs id / label / url per node.
 *
 * Synthetic ids collapse shared artifacts: two tasks pointing at PR #42 in the
 * same repo produce a single `artifact:pr:<url>` node with two `produces`
 * edges.
 */
export function readArtifactNodes(task: Task): GraphNode[] {
  const out: GraphNode[] = [];
  const ctx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};

  // GitHub PR — structured form first, then a couple of legacy aliases.
  for (const key of ['github_pr', 'github_pull_request', 'pr'] as const) {
    const raw = ctx[key];
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      const number = obj['number'];
      const url = obj['url'] ?? obj['html_url'];
      if (typeof number === 'number' && typeof url === 'string') {
        out.push({
          id: `artifact:pr:${url}`,
          kind: 'pr',
          label: `PR #${number}`,
          url,
        });
        break;
      }
    }
  }

  // GitHub issue.
  const issue = ctx['github_issue'];
  if (issue && typeof issue === 'object') {
    const obj = issue as Record<string, unknown>;
    const number = obj['number'];
    const url = obj['url'];
    if (typeof number === 'number' && typeof url === 'string') {
      out.push({
        id: `artifact:issue:${url}`,
        kind: 'issue',
        label: `Issue #${number}`,
        url,
      });
    }
  }

  // Calendar event — the canonical home is the top-level column.
  if (typeof task.calendar_event_id === 'string' && task.calendar_event_id.length > 0) {
    const summary = ctx['calendar_event_summary'];
    out.push({
      id: `artifact:event:${task.calendar_event_id}`,
      kind: 'event',
      label:
        typeof summary === 'string' && summary.length > 0
          ? summary
          : 'Calendar event',
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                  */
/* -------------------------------------------------------------------------- */

function safeLoadGoal(
  loadGoal: GoalMembershipLoader,
  task: Task,
): { id: string; label: string } | null {
  try {
    return loadGoal(task);
  } catch {
    return null;
  }
}
