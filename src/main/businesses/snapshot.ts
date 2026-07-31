/**
 * Per-business status snapshot.
 *
 * Computed on demand — every HTTP/MCP read recomputes from live DB state
 * plus the on-disk updates feed. The two persistent artifacts (`status.json`,
 * `STATUS.md`) are caches keyed off `computed_at`; nothing reads them as
 * truth — they exist so other tools (memory subsystems, the SessionEnd hook,
 * `grep STATUS.md`) can see the same view without going through the API.
 *
 * Feed mix (per the locked decision card):
 *   • Conversation rollup mapped to the business via its repo list (matched
 *     on the CWD path's trailing repo-name segment).
 *   • Open tasks per linked goal, recent decisions across those tasks, recent
 *     journal entries.
 *   • Explicit deltas from `<tag>/updates.jsonl` — the cross-session feed.
 *
 * NOTE: the user opted out of GitHub polling, so this module never touches
 * the github integration. Repos are surfaced from `projects.json` only.
 */

import path from 'node:path';

import { getGoal } from '@/main/db/repositories/goals';
import { listDecisions } from '@/main/db/repositories/decisions';
import { listTasks } from '@/main/db/repositories/tasks';
import { listConversations } from '@/main/db/repositories/conversations';
import { listGoalTasks } from '@/main/goals';
import type { Conversation, Task } from '@/shared/types';

import {
  type BusinessConfig,
  getBusiness,
  listBusinesses,
} from './loader';
import { readUpdates, type StatusUpdate } from './storage';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface BusinessTaskSummary {
  id: string;
  title: string;
  status: Task['status'];
  priority: Task['priority'];
  due: string | null;
  updated_at: string;
}

export interface BusinessDecisionSummary {
  id: string;
  task_id: string;
  category: string;
  text: string;
  created_at: string;
}

export interface BusinessConversationSummary {
  id: string;
  title: string | null;
  project_path: string | null;
  topics: string[];
  ended_at: string;
}

export interface NextStep {
  /** Short, imperative phrase. */
  text: string;
  /** Where the suggestion came from — for explainability. */
  source: 'open_task' | 'overdue_task' | 'recent_delta' | 'no_activity';
  /** Optional task id when the suggestion references a specific task. */
  task_id?: string;
}

/**
 * What kind of activity drove `last_touched_at`. Lets the renderer + the
 * morning brief surface whether you've been *talking* about a business
 * (conversations), *building* on it (tasks/decisions/code), or just *logging*
 * updates without doing either.
 */
export type LastInteractionKind =
  | 'chat'
  | 'code'
  | 'status_delta'
  | 'decision'
  | 'task'
  | 'none';

export interface BusinessSnapshot {
  tag: string;
  name: string;
  goal_id: string | null;
  /** Stable repo list from projects.json. */
  repos: string[];
  /** Single-line headline derived from the most recent update or task. */
  headline: string;
  /** ISO timestamp of most recent meaningful activity, or null. */
  last_touched_at: string | null;
  /** What drove `last_touched_at` — chat / code / status delta / etc. */
  last_interaction_kind: LastInteractionKind;
  /** ISO timestamp the snapshot was computed at. */
  computed_at: string;
  /** Open / in-progress / blocked task counts. */
  task_counts: {
    total: number;
    inbox: number;
    queued: number;
    in_progress: number;
    blocked: number;
    done: number;
    overdue: number;
  };
  /** Up to 10 most recent open tasks (newest first). */
  open_tasks: BusinessTaskSummary[];
  /** Up to 5 most recent decisions across linked tasks. */
  recent_decisions: BusinessDecisionSummary[];
  /** Up to 10 conversations whose CWD matched a repo for this business. */
  recent_conversations: BusinessConversationSummary[];
  /** Up to 20 most recent explicit deltas (newest first). */
  recent_updates: StatusUpdate[];
  /** Derived suggested next steps — 1 to 5 entries. */
  next_steps: NextStep[];
}

export interface BusinessOverviewEntry {
  tag: string;
  name: string;
  goal_id: string | null;
  headline: string;
  last_touched_at: string | null;
  last_interaction_kind: LastInteractionKind;
  open_task_count: number;
  overdue_task_count: number;
  recent_update_count: number;
  /** Most recent update's headline, when any. Useful for the list view. */
  latest_update_headline: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compute a full snapshot for one business. Returns null when the tag isn't
 * configured in `projects.json`.
 */
export async function computeSnapshot(
  tag: string,
): Promise<BusinessSnapshot | null> {
  const cfg = getBusiness(tag);
  if (!cfg) return null;

  const tasks = collectTasks(cfg);
  const decisions = collectDecisions(tasks);
  const conversations = collectConversations(cfg);
  const updates = await readUpdates(tag, 20);

  const taskCounts = countTasks(tasks);
  const openTasks = pickOpenTasks(tasks).slice(0, 10).map(toTaskSummary);

  const lastTouchedFull = pickLastTouchedWithKind(
    tasks,
    decisions,
    conversations,
    updates,
  );
  const lastTouched = lastTouchedFull.at;
  const headline = pickHeadline(cfg, openTasks, updates);
  const nextSteps = deriveNextSteps(openTasks, updates, lastTouched);

  return {
    tag: cfg.tag,
    name: cfg.name,
    goal_id: cfg.goal_id ?? null,
    repos: [...cfg.repos],
    headline,
    last_touched_at: lastTouched,
    last_interaction_kind: lastTouchedFull.kind,
    computed_at: new Date().toISOString(),
    task_counts: taskCounts,
    open_tasks: openTasks,
    recent_decisions: decisions.slice(0, 5).map((d) => ({
      id: d.id,
      task_id: d.task_id,
      category: d.category,
      text: d.text,
      created_at: d.created_at,
    })),
    recent_conversations: conversations.slice(0, 10).map((c) => ({
      id: c.id,
      title: c.title,
      project_path: c.project_path,
      topics: c.topics,
      ended_at: c.ended_at,
    })),
    recent_updates: updates,
    next_steps: nextSteps,
  };
}

/**
 * Compute a thin per-business entry suitable for the index/list endpoint.
 * Avoids the heavy conversation lookup so listing 6 businesses stays cheap.
 */
export async function computeOverview(): Promise<BusinessOverviewEntry[]> {
  const out: BusinessOverviewEntry[] = [];
  for (const cfg of listBusinesses()) {
    const tasks = collectTasks(cfg);
    const updates = await readUpdates(cfg.tag, 5);
    const counts = countTasks(tasks);
    const lastFull = pickLastTouchedWithKind(tasks, [], [], updates);
    const latestUpdate = updates[0] ?? null;
    const headline = pickHeadline(cfg, pickOpenTasks(tasks).slice(0, 1).map(toTaskSummary), updates);
    out.push({
      tag: cfg.tag,
      name: cfg.name,
      goal_id: cfg.goal_id ?? null,
      headline,
      last_touched_at: lastFull.at,
      last_interaction_kind: lastFull.kind,
      open_task_count: counts.inbox + counts.queued + counts.in_progress + counts.blocked,
      overdue_task_count: counts.overdue,
      recent_update_count: updates.length,
      latest_update_headline: latestUpdate?.headline ?? null,
    });
  }
  // Sort by most-recently-touched, so the businesses you're actively in
  // float to the top of the list.
  return out.sort((a, b) => {
    const at = a.last_touched_at ?? '';
    const bt = b.last_touched_at ?? '';
    return bt.localeCompare(at);
  });
}

/* -------------------------------------------------------------------------- */
/*  Feed collectors                                                           */
/* -------------------------------------------------------------------------- */

function collectTasks(cfg: BusinessConfig): Task[] {
  const byId = new Map<string, Task>();
  // Linked goal members — explicit attachments + tag membership.
  if (cfg.goal_id && getGoal(cfg.goal_id)) {
    for (const t of listGoalTasks(cfg.goal_id)) byId.set(t.id, t);
  }
  // Tag membership directly off the business tag — covers tasks tagged with
  // the business slug even when no goal is attached.
  for (const t of listTasks({ tag: cfg.tag })) byId.set(t.id, t);
  return [...byId.values()];
}

interface RawDecision {
  id: string;
  task_id: string;
  category: string;
  text: string;
  created_at: string;
}

function collectDecisions(tasks: Task[]): RawDecision[] {
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const rows = listDecisions({ task_ids: ids, limit: 50 });
  return rows.map((r) => ({
    id: r.id,
    task_id: r.task_id,
    category: r.category,
    text: r.text,
    created_at: r.created_at,
  }));
}

/**
 * Map conversations to this business via the trailing path segment of each
 * conversation's CWD matching any of the business's repo names.
 */
function collectConversations(cfg: BusinessConfig): Conversation[] {
  if (cfg.repos.length === 0) return [];
  const wantedNames = new Set(
    cfg.repos.map((r) => (r.split('/').pop() ?? '').toLowerCase()).filter(Boolean),
  );
  if (wantedNames.size === 0) return [];
  // Pull a healthy slice and filter in memory — listConversations doesn't
  // support a suffix LIKE and the catalog isn't huge (< 5k typically).
  const recent = listConversations({ limit: 500 });
  const out: Conversation[] = [];
  for (const c of recent) {
    if (!c.project_path) continue;
    const tail = path.basename(c.project_path.replace(/\\/g, '/')).toLowerCase();
    if (wantedNames.has(tail)) out.push(c);
    if (out.length >= 25) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Derivations                                                               */
/* -------------------------------------------------------------------------- */

function countTasks(tasks: Task[]): BusinessSnapshot['task_counts'] {
  const counts = {
    total: tasks.length,
    inbox: 0,
    queued: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    overdue: 0,
  };
  const now = Date.now();
  for (const t of tasks) {
    if (t.status === 'inbox') counts.inbox += 1;
    else if (t.status === 'queued') counts.queued += 1;
    else if (t.status === 'in_progress') counts.in_progress += 1;
    else if (t.status === 'blocked') counts.blocked += 1;
    else if (t.status === 'done') counts.done += 1;
    if (t.status !== 'done' && t.due) {
      const ms = Date.parse(t.due);
      if (Number.isFinite(ms) && ms < now) counts.overdue += 1;
    }
  }
  return counts;
}

function pickOpenTasks(tasks: Task[]): Task[] {
  const open = tasks.filter(
    (t) =>
      t.status === 'inbox' ||
      t.status === 'queued' ||
      t.status === 'in_progress' ||
      t.status === 'blocked',
  );
  return open.sort((a, b) => {
    // p0 before p1 before p2 before p3, then most recently updated first.
    if (a.priority !== b.priority) return a.priority.localeCompare(b.priority);
    return b.updated_at.localeCompare(a.updated_at);
  });
}

function toTaskSummary(t: Task): BusinessTaskSummary {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: t.due,
    updated_at: t.updated_at,
  };
}

function pickLastTouched(
  tasks: Task[],
  decisions: RawDecision[],
  conversations: Conversation[],
  updates: StatusUpdate[],
): string | null {
  return pickLastTouchedWithKind(tasks, decisions, conversations, updates).at;
}

/**
 * Same as {@link pickLastTouched} but also returns which source produced
 * the winning timestamp. Used by snapshot to populate `last_interaction_kind`
 * so the UI can show "code change" vs "chat" vs "status delta" instead of
 * a bare timestamp.
 */
function pickLastTouchedWithKind(
  tasks: Task[],
  decisions: RawDecision[],
  conversations: Conversation[],
  updates: StatusUpdate[],
): { at: string | null; kind: LastInteractionKind } {
  type Candidate = { at: string; kind: LastInteractionKind };
  const candidates: Candidate[] = [];
  for (const t of tasks) {
    // Heuristic: a task tied to a github_repo / has been executed → code;
    // otherwise task. The full classifier is too much; this is the cheap one.
    const ctx = (t.context ?? {}) as Record<string, unknown>;
    const looksCodey =
      typeof ctx['github_repo'] === 'string' ||
      typeof ctx['github_branch'] === 'string' ||
      typeof ctx['branch_policy'] === 'string';
    candidates.push({
      at: t.updated_at,
      kind: looksCodey ? 'code' : 'task',
    });
  }
  for (const d of decisions) candidates.push({ at: d.created_at, kind: 'decision' });
  for (const c of conversations) candidates.push({ at: c.ended_at, kind: 'chat' });
  for (const u of updates) candidates.push({ at: u.at, kind: 'status_delta' });
  let winner: Candidate | null = null;
  for (const c of candidates) {
    if (!c.at) continue;
    if (winner === null || c.at > winner.at) winner = c;
  }
  if (!winner) return { at: null, kind: 'none' };
  return { at: winner.at, kind: winner.kind };
}

function pickHeadline(
  cfg: BusinessConfig,
  openTasks: BusinessTaskSummary[],
  updates: StatusUpdate[],
): string {
  // Most recent explicit update wins — it's the "what I told this business
  // about" line, and that's what a future session most wants to see first.
  if (updates.length > 0) return updates[0]!.headline;
  if (openTasks.length > 0) {
    const top = openTasks[0]!;
    return `${top.status === 'in_progress' ? 'In progress' : 'Up next'}: ${top.title}`;
  }
  return `${cfg.name} — no recent activity logged.`;
}

function deriveNextSteps(
  openTasks: BusinessTaskSummary[],
  updates: StatusUpdate[],
  lastTouchedAt: string | null,
): NextStep[] {
  const out: NextStep[] = [];

  // Overdue first — these need attention.
  const now = Date.now();
  const overdue = openTasks.filter(
    (t) => t.due && Date.parse(t.due) < now,
  );
  for (const t of overdue.slice(0, 2)) {
    out.push({
      text: `Resolve overdue: ${t.title}`,
      source: 'overdue_task',
      task_id: t.id,
    });
  }

  // Top open tasks by priority.
  for (const t of openTasks.slice(0, 3)) {
    if (out.some((s) => s.task_id === t.id)) continue;
    out.push({
      text: t.status === 'in_progress' ? `Continue: ${t.title}` : `Start: ${t.title}`,
      source: 'open_task',
      task_id: t.id,
    });
    if (out.length >= 5) break;
  }

  // If the most recent delta hints at a follow-up, surface it verbatim.
  if (out.length < 5 && updates.length > 0) {
    const u = updates[0]!;
    if (u.what_changed && u.what_changed.length > 0) {
      out.push({
        text: u.what_changed.slice(0, 200),
        source: 'recent_delta',
      });
    }
  }

  // No activity at all — say so explicitly rather than returning an empty list.
  if (out.length === 0 && lastTouchedAt === null) {
    out.push({
      text: 'No activity logged for this business yet. Add a task or post a status update to start the feed.',
      source: 'no_activity',
    });
  }

  return out;
}
