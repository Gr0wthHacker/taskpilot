/**
 * "Brief me on yourself" — weekly private profile derived from observable
 * patterns. No telemetry phoning home; everything is computed locally from
 * the DB + on-disk feeds.
 *
 * The point is a confronting mirror, not a flattering dashboard. It surfaces
 * things you wouldn't notice yourself:
 *   • Sharpest hours (when sessions ship vs stall)
 *   • Businesses you actually invest in (by time + spend) vs claim to
 *   • Stall ratio — tasks created vs completed per business
 *   • Pet-topic drift — what you keep returning to, even when it's not on
 *     the goal list
 *   • Velocity changes week-over-week
 *
 * The renderer/MCP exposes this as plain markdown. The doc is written to
 * `~/.taskpilot/self-profile.md` for grep / external editor access.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import {
  listConversations,
  rollupByDay,
  rollupByProject,
} from '@/main/db/repositories/conversations';
import { listTasks } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import { listBusinesses } from '@/main/businesses';
import type { Conversation, Task } from '@/shared/types';

const PROFILE_PATH = path.join(TASKPILOT_HOME, 'self-profile.md');
export const PROFILE_LAST_RUN_KEY = 'self_profile_last_run';

function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/* -------------------------------------------------------------------------- */
/*  Analyzers — pure functions over rows                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bucket conversations into hour-of-day buckets and find where activity
 * (token spend) concentrates. Returns the top 3 hours by total tokens —
 * useful for "when am I actually shipping vs just clicking around."
 */
export function sharpestHours(conversations: Conversation[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const c of conversations) {
    const ms = Date.parse(c.ended_at);
    if (!Number.isFinite(ms)) continue;
    const h = new Date(ms).getHours();
    const tokens =
      (c.input_tokens ?? 0) +
      (c.output_tokens ?? 0) +
      (c.cache_read_tokens ?? 0) +
      (c.cache_creation_tokens ?? 0);
    buckets[h]! += tokens;
  }
  return buckets
    .map((tokens, hour) => ({ hour, tokens }))
    .filter((b) => b.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map((b) => b.hour);
}

export interface BusinessInvestment {
  tag: string;
  name: string;
  conversation_count: number;
  total_tokens: number;
  total_cost_usd: number;
  open_task_count: number;
  done_last_30d: number;
  created_last_30d: number;
  /** done / max(1, created) — a quick proxy for "stuff actually finishes". */
  completion_ratio: number;
}

/**
 * Compute per-business invest-vs-claim signals. Combines token spend
 * (proxy for time spent in Claude), open tasks (claimed work), and
 * done-vs-created ratio (whether claimed work actually ships).
 */
export function businessInvestment(
  conversations: Conversation[],
  tasks: Task[],
): BusinessInvestment[] {
  const businesses = listBusinesses();
  const cutoff = Date.now() - 30 * 86_400_000;
  const byProject = rollupByProject();
  const out: BusinessInvestment[] = [];
  for (const b of businesses) {
    // Map this business's repos to CWD tails for conversation matching.
    const wanted = new Set(
      b.repos
        .map((r) => (r.split('/').pop() ?? '').toLowerCase())
        .filter(Boolean),
    );
    const matchedProjects = byProject.filter((p) => {
      if (!p.project_path) return false;
      const tail = path
        .basename(p.project_path.replace(/\\/g, '/'))
        .toLowerCase();
      return wanted.has(tail);
    });
    const conversationCount = matchedProjects.reduce((s, p) => s + p.sessions, 0);
    const totalTokens = matchedProjects.reduce((s, p) => s + p.total_tokens, 0);
    const totalCost = matchedProjects.reduce((s, p) => s + p.total_cost_usd, 0);

    // Per-business task slice: tagged with the business tag.
    const bizTasks = tasks.filter((t) => t.tags?.includes(b.tag));
    const open = bizTasks.filter(
      (t) =>
        t.status === 'inbox' ||
        t.status === 'queued' ||
        t.status === 'in_progress' ||
        t.status === 'blocked',
    ).length;
    let done30 = 0;
    let created30 = 0;
    for (const t of bizTasks) {
      const created = Date.parse(t.created_at);
      if (Number.isFinite(created) && created >= cutoff) created30 += 1;
      if (t.status === 'done') {
        const updated = Date.parse(t.updated_at);
        if (Number.isFinite(updated) && updated >= cutoff) done30 += 1;
      }
    }
    const completion = done30 / Math.max(1, created30);
    // Silence unused var
    void conversations;
    out.push({
      tag: b.tag,
      name: b.name,
      conversation_count: conversationCount,
      total_tokens: totalTokens,
      total_cost_usd: totalCost,
      open_task_count: open,
      done_last_30d: done30,
      created_last_30d: created30,
      completion_ratio: Number.isFinite(completion) ? completion : 0,
    });
  }
  return out.sort((a, b) => b.total_cost_usd - a.total_cost_usd);
}

/** Day-by-day token rollup over the last N days — used for trend math. */
export function weekOverWeekTrend(days = 14): {
  this_week_tokens: number;
  last_week_tokens: number;
  delta_pct: number;
} {
  const rollup = rollupByDay(days);
  const sorted = rollup.sort((a, b) => (a.date < b.date ? -1 : 1));
  const half = Math.floor(sorted.length / 2);
  const lastWeek = sorted.slice(0, half);
  const thisWeek = sorted.slice(half);
  const sum = (rs: typeof sorted): number =>
    rs.reduce((s, r) => s + r.total_tokens, 0);
  const t = sum(thisWeek);
  const l = sum(lastWeek);
  const delta = l === 0 ? 0 : ((t - l) / l) * 100;
  return { this_week_tokens: t, last_week_tokens: l, delta_pct: delta };
}

/* -------------------------------------------------------------------------- */
/*  Render                                                                    */
/* -------------------------------------------------------------------------- */

export interface SelfProfileResult {
  date: string;
  markdown: string;
  path: string;
  bytes: number;
}

function formatHour(h: number): string {
  if (h === 0) return '12am';
  if (h < 12) return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0%';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function pickStallVerdict(b: BusinessInvestment): string {
  if (b.created_last_30d === 0 && b.open_task_count === 0) {
    return 'dormant — nothing created, nothing open';
  }
  if (b.created_last_30d > 0 && b.done_last_30d === 0) {
    return `**all creation, no completion** — ${b.created_last_30d} new, 0 done`;
  }
  if (b.completion_ratio < 0.3 && b.created_last_30d > 5) {
    return `low completion (${Math.round(b.completion_ratio * 100)}%) — work piles up faster than it finishes`;
  }
  if (b.completion_ratio > 0.8 && b.done_last_30d > 5) {
    return `**healthy throughput** — ${b.done_last_30d} done / ${b.created_last_30d} created`;
  }
  return `${b.done_last_30d} done / ${b.created_last_30d} created in 30d`;
}

function pickInvestVsClaimGap(
  rankedByMoney: BusinessInvestment[],
  rankedByTasks: BusinessInvestment[],
): string | null {
  // Which business gets the most $ vs which has the most claimed work?
  const topMoney = rankedByMoney[0];
  const topClaimed = rankedByTasks[0];
  if (!topMoney || !topClaimed) return null;
  if (topMoney.tag === topClaimed.tag) {
    return `**${topMoney.name}** is where time + claimed work line up — you actually invest where you say you do.`;
  }
  return (
    `**Gap detected.** You spend the most Claude time on **${topMoney.name}** ($${topMoney.total_cost_usd.toFixed(0)} in 30d), ` +
    `but your largest open-task pile is **${topClaimed.name}** (${topClaimed.open_task_count} open). ` +
    `Either consolidate, or admit the task pile is a graveyard you should drain.`
  );
}

export async function generateSelfProfile(): Promise<SelfProfileResult> {
  const date = todayLocalDate();
  const conversations = listConversations({ limit: 1000 });
  const tasks = listTasks({});
  const businesses = businessInvestment(conversations, tasks);
  const trend = weekOverWeekTrend(14);
  const hours = sharpestHours(conversations);

  const rankedByTasks = [...businesses].sort(
    (a, b) => b.open_task_count - a.open_task_count,
  );
  const gap = pickInvestVsClaimGap(businesses, rankedByTasks);

  const lines: string[] = [];
  lines.push(`# Brief on yourself — ${date}`);
  lines.push('');
  lines.push(
    `_Private. Not flattering. Derived from the last 30 days of activity._`,
  );
  lines.push('');

  // --- Operating tempo ---------------------------------------------------
  lines.push('## Operating tempo');
  lines.push('');
  if (hours.length > 0) {
    lines.push(
      `Sharpest hours by token spend: ${hours.map(formatHour).join(', ')}. ` +
        `If your real shipping happens outside these hours, you're paying the ` +
        `cognitive tax of context-switching twice.`,
    );
  } else {
    lines.push('Not enough conversation data yet to fingerprint sharpest hours.');
  }
  lines.push('');
  lines.push(
    `Token spend trend (last 14 days): this half ${trend.this_week_tokens.toLocaleString()}, ` +
      `prior half ${trend.last_week_tokens.toLocaleString()} → ${pct(trend.delta_pct)}.`,
  );
  lines.push('');

  // --- Invest vs claim ---------------------------------------------------
  lines.push('## Where you actually invest vs claim');
  lines.push('');
  if (gap) {
    lines.push(gap);
    lines.push('');
  }
  lines.push('| Business | 30d spend | Sessions | Open tasks | 30d done/created |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const b of businesses) {
    lines.push(
      `| ${b.name} | $${b.total_cost_usd.toFixed(2)} | ${b.conversation_count} | ${b.open_task_count} | ${b.done_last_30d}/${b.created_last_30d} |`,
    );
  }
  lines.push('');

  // --- Stall verdicts ----------------------------------------------------
  lines.push('## Per-business verdicts');
  lines.push('');
  for (const b of businesses) {
    lines.push(`- **${b.name}** — ${pickStallVerdict(b)}`);
  }
  lines.push('');

  // --- Confronting close -------------------------------------------------
  lines.push('## The line you might not want to read');
  lines.push('');
  const dormant = businesses.filter(
    (b) => b.created_last_30d === 0 && b.open_task_count === 0,
  );
  const allCreateNoDone = businesses.filter(
    (b) => b.created_last_30d > 0 && b.done_last_30d === 0,
  );
  if (dormant.length > 0) {
    lines.push(
      `${dormant.length} business${dormant.length === 1 ? '' : 'es'} ` +
        `(${dormant.map((d) => d.name).join(', ')}) had ZERO activity in 30 days. ` +
        `That's not a quiet phase — that's a portfolio decision you're avoiding.`,
    );
    lines.push('');
  }
  if (allCreateNoDone.length > 0) {
    lines.push(
      `${allCreateNoDone.length} business${allCreateNoDone.length === 1 ? '' : 'es'} ` +
        `(${allCreateNoDone.map((b) => b.name).join(', ')}) had work CREATED but NONE shipped. ` +
        `You're filing intent without delivering on it.`,
    );
    lines.push('');
  }
  if (dormant.length === 0 && allCreateNoDone.length === 0) {
    lines.push(
      'No glaring stalls this week. Doesn\'t mean nothing\'s drifting — ' +
        'check the trend column for the slow ones.',
    );
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_Generated weekly. Stored at `~/.taskpilot/self-profile.md`. Private._',
  );
  lines.push('');

  const markdown = lines.join('\n');
  await fs.mkdir(path.dirname(PROFILE_PATH), { recursive: true });
  await fs.writeFile(PROFILE_PATH, markdown, 'utf8');
  try {
    settingsRepository.set(PROFILE_LAST_RUN_KEY, date);
  } catch {
    /* non-fatal */
  }
  return {
    date,
    markdown,
    path: PROFILE_PATH,
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };
}

export async function readSelfProfile(): Promise<string | null> {
  try {
    return await fs.readFile(PROFILE_PATH, 'utf8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * True when no profile has been generated in the last 7 days. Used by the
 * weekly cron / boot tick.
 */
export function isSelfProfileDue(): boolean {
  try {
    const raw = settingsRepository.get(PROFILE_LAST_RUN_KEY);
    if (typeof raw !== 'string') return true;
    const ms = Date.parse(`${raw}T00:00:00Z`);
    if (!Number.isFinite(ms)) return true;
    return Date.now() - ms > 7 * 86_400_000;
  } catch {
    return true;
  }
}

export function selfProfilePath(): string {
  return PROFILE_PATH;
}
