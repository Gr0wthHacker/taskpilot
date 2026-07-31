/**
 * Outcome reverse-engineer.
 *
 * When you log a milestone — revenue, deal closed, ship — this module
 * traces back through the data to surface what contributed: decisions,
 * tasks completed in the window, conversations in the matched repo,
 * status deltas. The output is a causal map you can read at end of week
 * (or before a VP+ interview where you need to actually explain "how did
 * you grow X").
 *
 * Milestones are stored append-only at `~/.taskpilot/outcomes/<biz>/milestones.jsonl`.
 * The trace is computed on demand — no separate index — over the existing
 * decisions / tasks / conversations / updates feeds.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { getBusiness, listBusinesses, readUpdates } from '@/main/businesses';
import { listConversations } from '@/main/db/repositories/conversations';
import { listDecisions } from '@/main/db/repositories/decisions';
import { listTasks } from '@/main/db/repositories/tasks';
import type { Conversation, DecisionEntry, Task } from '@/shared/types';

const OUTCOMES_DIR = path.join(TASKPILOT_HOME, 'outcomes');

export type MilestoneKind =
  | 'revenue'
  | 'deal'
  | 'ship'
  | 'launch'
  | 'press'
  | 'hire'
  | 'milestone';

export interface Milestone {
  id: string;
  business: string;
  at: string;
  kind: MilestoneKind;
  /** Human title — "Hit $50k MRR", "Closed Acme contract", "Shipped v2 deck". */
  headline: string;
  /** Optional structured value: dollar amount, count, or freeform note. */
  value?: string;
  /** Optional URL pointer to the artifact (press link, deal doc, etc). */
  link?: string;
  /**
   * Default 14d. The trace window — how many days back we search for
   * contributing decisions/tasks/sessions.
   */
  window_days?: number;
}

const DEFAULT_WINDOW_DAYS = 14;
const ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function assertId(id: string): void {
  if (!ID_REGEX.test(id)) {
    throw new Error(`Invalid milestone id: ${JSON.stringify(id)}`);
  }
}

function businessDir(tag: string): string {
  return path.join(OUTCOMES_DIR, tag);
}

function milestonesFilePath(tag: string): string {
  return path.join(businessDir(tag), 'milestones.jsonl');
}

async function ensureDir(tag: string): Promise<void> {
  await fs.mkdir(businessDir(tag), { recursive: true });
}

/* -------------------------------------------------------------------------- */
/*  Storage                                                                   */
/* -------------------------------------------------------------------------- */

export async function recordMilestone(m: Milestone): Promise<Milestone> {
  if (!getBusiness(m.business)) {
    throw new Error(
      `No business configured for tag ${JSON.stringify(m.business)}`,
    );
  }
  assertId(m.id);
  await ensureDir(m.business);
  await fs.appendFile(
    milestonesFilePath(m.business),
    `${JSON.stringify(m)}\n`,
    'utf8',
  );
  return m;
}

export async function listMilestones(tag: string): Promise<Milestone[]> {
  let text: string;
  try {
    text = await fs.readFile(milestonesFilePath(tag), 'utf8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: Milestone[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Milestone;
      if (parsed?.id && parsed?.business) out.push(parsed);
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/* -------------------------------------------------------------------------- */
/*  Trace                                                                     */
/* -------------------------------------------------------------------------- */

export interface OutcomeTraceItem {
  source: 'task' | 'decision' | 'conversation' | 'status_delta';
  at: string;
  title: string;
  /** Why this item was picked — short reason. */
  why: string;
  ref?: {
    task_id?: string;
    decision_id?: string;
    conversation_id?: string;
  };
}

export interface OutcomeTrace {
  milestone: Milestone;
  window_start: string;
  window_end: string;
  contributing_tasks: OutcomeTraceItem[];
  contributing_decisions: OutcomeTraceItem[];
  contributing_conversations: OutcomeTraceItem[];
  contributing_status_deltas: OutcomeTraceItem[];
  summary: string;
}

/**
 * Walk back N days from the milestone and pull every plausible contributing
 * artifact. Cheap heuristics — no LLM in the loop here. The caller (or a
 * future Claude session) can read the trace and write the actual narrative.
 */
export async function traceMilestone(args: {
  business: string;
  milestoneId: string;
}): Promise<OutcomeTrace | null> {
  const milestones = await listMilestones(args.business);
  const m = milestones.find((x) => x.id === args.milestoneId);
  if (!m) return null;

  const windowDays = m.window_days ?? DEFAULT_WINDOW_DAYS;
  const endMs = Date.parse(m.at);
  if (!Number.isFinite(endMs)) {
    return null;
  }
  const startMs = endMs - windowDays * 86_400_000;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  // Tasks — closed inside the window AND tagged with the business.
  const allTasks = listTasks({});
  const taskItems: OutcomeTraceItem[] = [];
  for (const t of allTasks) {
    if (!t.tags?.includes(m.business)) continue;
    const updatedMs = Date.parse(t.updated_at);
    if (
      !Number.isFinite(updatedMs) ||
      updatedMs < startMs ||
      updatedMs > endMs
    ) {
      continue;
    }
    if (t.status === 'done') {
      taskItems.push(buildTaskItem(t, 'shipped in window'));
    } else if (t.status === 'in_progress') {
      taskItems.push(buildTaskItem(t, 'in-progress in window'));
    }
  }

  // Decisions — created inside the window for any task tagged with the
  // business. Cheap: filter the decision list by the contributing task ids.
  const decisionItems: OutcomeTraceItem[] = [];
  if (taskItems.length > 0) {
    const taskIds = taskItems
      .map((t) => t.ref?.task_id)
      .filter((id): id is string => Boolean(id));
    const decisions = listDecisions({ task_ids: taskIds, limit: 50 });
    for (const d of decisions) {
      const createdMs = Date.parse(d.created_at);
      if (!Number.isFinite(createdMs)) continue;
      if (createdMs < startMs || createdMs > endMs) continue;
      decisionItems.push(buildDecisionItem(d));
    }
  }

  // Conversations — matched by repo CWD.
  const businessCfg = getBusiness(m.business);
  const conversationItems: OutcomeTraceItem[] = [];
  if (businessCfg && businessCfg.repos.length > 0) {
    const wantedTails = new Set(
      businessCfg.repos
        .map((r) => (r.split('/').pop() ?? '').toLowerCase())
        .filter(Boolean),
    );
    const recent = listConversations({ limit: 500 });
    for (const c of recent) {
      const endedMs = Date.parse(c.ended_at);
      if (!Number.isFinite(endedMs)) continue;
      if (endedMs < startMs || endedMs > endMs) continue;
      if (!c.project_path) continue;
      const tail = path
        .basename(c.project_path.replace(/\\/g, '/'))
        .toLowerCase();
      if (!wantedTails.has(tail)) continue;
      conversationItems.push(buildConversationItem(c));
    }
  }

  // Status deltas — pull anything in the business's updates.jsonl that's
  // within the window.
  const updates = await readUpdates(m.business, 100);
  const statusItems: OutcomeTraceItem[] = [];
  for (const u of updates) {
    const ms = Date.parse(u.at);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs) continue;
    statusItems.push({
      source: 'status_delta',
      at: u.at,
      title: u.headline,
      why: u.what_changed ? u.what_changed.slice(0, 200) : 'status logged',
    });
  }

  const summary = buildSummary({
    milestone: m,
    windowDays,
    tasks: taskItems,
    decisions: decisionItems,
    conversations: conversationItems,
    statusDeltas: statusItems,
  });

  return {
    milestone: m,
    window_start: startIso,
    window_end: endIso,
    contributing_tasks: taskItems.sort((a, b) => a.at.localeCompare(b.at)),
    contributing_decisions: decisionItems.sort((a, b) => a.at.localeCompare(b.at)),
    contributing_conversations: conversationItems.sort((a, b) =>
      a.at.localeCompare(b.at),
    ),
    contributing_status_deltas: statusItems.sort((a, b) =>
      a.at.localeCompare(b.at),
    ),
    summary,
  };
}

function buildTaskItem(t: Task, why: string): OutcomeTraceItem {
  return {
    source: 'task',
    at: t.updated_at,
    title: t.title,
    why,
    ref: { task_id: t.id },
  };
}

function buildDecisionItem(d: DecisionEntry): OutcomeTraceItem {
  return {
    source: 'decision',
    at: d.created_at,
    title: `[${d.category}] ${d.text.slice(0, 120)}`,
    why: `decision logged on task ${d.task_id}`,
    ref: { decision_id: d.id, task_id: d.task_id },
  };
}

function buildConversationItem(c: Conversation): OutcomeTraceItem {
  return {
    source: 'conversation',
    at: c.ended_at,
    title: c.title ?? `(conversation ${c.id})`,
    why: c.topics.length > 0 ? `topics: ${c.topics.slice(0, 4).join(', ')}` : 'session in matched repo',
    ref: { conversation_id: c.id },
  };
}

function buildSummary(args: {
  milestone: Milestone;
  windowDays: number;
  tasks: OutcomeTraceItem[];
  decisions: OutcomeTraceItem[];
  conversations: OutcomeTraceItem[];
  statusDeltas: OutcomeTraceItem[];
}): string {
  const parts: string[] = [];
  parts.push(
    `In the ${args.windowDays} days leading up to "${args.milestone.headline}"`,
  );
  const counts: string[] = [];
  if (args.tasks.length > 0) {
    counts.push(`${args.tasks.length} task${args.tasks.length === 1 ? '' : 's'}`);
  }
  if (args.decisions.length > 0) {
    counts.push(
      `${args.decisions.length} decision${args.decisions.length === 1 ? '' : 's'}`,
    );
  }
  if (args.conversations.length > 0) {
    counts.push(
      `${args.conversations.length} session${args.conversations.length === 1 ? '' : 's'}`,
    );
  }
  if (args.statusDeltas.length > 0) {
    counts.push(
      `${args.statusDeltas.length} status update${args.statusDeltas.length === 1 ? '' : 's'}`,
    );
  }
  if (counts.length === 0) {
    parts.push(', nothing in the system contributed (or it happened entirely off-app).');
  } else {
    parts.push(`, ${counts.join(', ')} fed into it.`);
  }
  return parts.join('');
}

/* -------------------------------------------------------------------------- */
/*  Aggregations                                                              */
/* -------------------------------------------------------------------------- */

/** Total milestone count across every configured business. */
export async function countMilestones(): Promise<number> {
  let total = 0;
  for (const b of listBusinesses()) {
    const list = await listMilestones(b.tag);
    total += list.length;
  }
  return total;
}
