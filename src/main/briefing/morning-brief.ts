/**
 * Morning brief — a one-page CEO update written to
 * `~/.taskpilot/morning-brief.md` once per day.
 *
 * Generates from data already in the system:
 *   • Per-business overview (vitality at a glance via the businesses module)
 *   • Your Move queue equivalent — overdue + blocked + needs-review tasks
 *   • Pending updates drafts queued by SessionEnd hooks
 *   • Anything overdue, sorted by how late
 *
 * Pure read; doesn't mutate any underlying data. Two write side-effects:
 *  - `morning-brief.md` on disk
 *  - `morning_brief_last_run` in the settings table (date string)
 *
 * On-demand: HTTP/MCP/UI callers can force a regen any time. Boot-side:
 * called once per day on first launch if the date has rolled over.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { computeOverview } from '@/main/businesses';
import { listTasks } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { Task } from '@/shared/types';

const BRIEF_PATH = path.join(TASKPILOT_HOME, 'morning-brief.md');
const UPDATES_DRAFTS_DIR = path.join(TASKPILOT_HOME, 'io', 'updates_drafts');

export const BRIEF_LAST_RUN_KEY = 'morning_brief_last_run';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface PendingDraft {
  filename: string;
  business: string | null;
  headline: string;
}

async function readPendingDrafts(): Promise<PendingDraft[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(UPDATES_DRAFTS_DIR);
  } catch {
    return [];
  }
  const out: PendingDraft[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(
        path.join(UPDATES_DRAFTS_DIR, name),
        'utf8',
      );
      const parsed = JSON.parse(raw) as {
        business?: string;
        headline?: string;
      };
      out.push({
        filename: name,
        business: parsed.business ?? null,
        headline: parsed.headline ?? '(no headline)',
      });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function overdueTasks(): Task[] {
  const now = Date.now();
  const open = listTasks({
    status: ['inbox', 'queued', 'in_progress', 'blocked'],
  });
  return open
    .filter((t) => {
      if (!t.due) return false;
      const ms = Date.parse(t.due);
      return Number.isFinite(ms) && ms < now;
    })
    .sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
}

const STALE_THRESHOLD_DAYS = 30;

/**
 * Open tasks untouched for `STALE_THRESHOLD_DAYS` — abandonment candidates.
 * The morning brief surfaces these under "what to stop" so the user can
 * archive, snooze, or kill without manually trawling the inbox.
 */
function staleTasks(): Task[] {
  const cutoff = Date.now() - STALE_THRESHOLD_DAYS * 86_400_000;
  const open = listTasks({
    status: ['inbox', 'queued', 'blocked'],
  });
  return open
    .filter((t) => {
      const ms = Date.parse(t.updated_at);
      return Number.isFinite(ms) && ms < cutoff;
    })
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
}

function needsReviewTasks(): Task[] {
  return listTasks({ status: ['blocked'] }).filter(
    (t) => t.agent_status === 'needs_review',
  );
}

function daysSince(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor((Date.now() - ms) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/*  Render                                                                    */
/* -------------------------------------------------------------------------- */

export interface MorningBriefResult {
  date: string;
  markdown: string;
  path: string;
  bytes: number;
}

export async function generateMorningBrief(): Promise<MorningBriefResult> {
  const date = todayLocalDate();
  const lines: string[] = [];

  lines.push(`# Morning brief — ${date}`);
  lines.push('');
  lines.push(
    '_Generated automatically on first launch. Use as the orientation pass — what shipped, what needs you, what to do first._',
  );
  lines.push('');

  // --- Businesses --------------------------------------------------------
  const overview = await computeOverview();
  if (overview.length > 0) {
    lines.push('## Businesses at a glance');
    lines.push('');
    for (const b of overview) {
      const touched = b.last_touched_at
        ? `${daysSince(b.last_touched_at)}d ago`
        : 'never';
      const overdueChunk =
        b.overdue_task_count > 0 ? ` · **${b.overdue_task_count} overdue**` : '';
      const draftChunk =
        b.recent_update_count > 0
          ? ` · ${b.recent_update_count} update${b.recent_update_count === 1 ? '' : 's'} on feed`
          : '';
      lines.push(`- **${b.name}** _(${b.tag})_ — last touched ${touched} · ${b.open_task_count} open${overdueChunk}${draftChunk}`);
      lines.push(`  - ${b.headline}`);
    }
    lines.push('');
  }

  // --- Your move ---------------------------------------------------------
  const review = needsReviewTasks();
  const overdue = overdueTasks();
  if (review.length > 0 || overdue.length > 0) {
    lines.push('## Needs you today');
    lines.push('');
    if (review.length > 0) {
      lines.push(`### Awaiting review (${review.length})`);
      for (const t of review.slice(0, 8)) {
        lines.push(`- [${t.priority}] ${t.title} _(\`${t.id}\`)_`);
      }
      lines.push('');
    }
    if (overdue.length > 0) {
      lines.push(`### Overdue (${overdue.length})`);
      for (const t of overdue.slice(0, 8)) {
        const days = t.due ? daysSince(t.due) : 0;
        lines.push(
          `- [${t.priority}] **${t.title}** — ${days}d late _(\`${t.id}\`)_`,
        );
      }
      lines.push('');
    }
  }

  // --- What to stop -----------------------------------------------------
  // Abandonment radar — the subtractive counterpart to "what needs you."
  // Surfaces open tasks untouched for 30+ days so the user can decide:
  // archive, snooze, kill. Most productivity tools only show "what to do
  // next"; this section is "what to stop pretending you're doing."
  const stale = staleTasks();
  if (stale.length > 0) {
    lines.push(`## What to stop (${stale.length})`);
    lines.push('');
    lines.push(
      `Open tasks untouched for ${STALE_THRESHOLD_DAYS}+ days. Pick one ` +
        `action each: **archive**, **snooze 7d**, or **kill** (sends to the ` +
        `decision graveyard so you stop re-proposing).`,
    );
    lines.push('');
    for (const t of stale.slice(0, 10)) {
      const days = daysSince(t.updated_at);
      lines.push(
        `- [${t.priority}] **${t.title}** — ${days}d stale _(\`${t.id}\`)_`,
      );
    }
    lines.push('');
  }

  // --- Pending update drafts --------------------------------------------
  const drafts = await readPendingDrafts();
  if (drafts.length > 0) {
    lines.push(`## Pending update drafts (${drafts.length})`);
    lines.push('');
    lines.push(
      'These were queued by SessionEnd hooks. Each one is a shipped change ' +
        'waiting to be written up for the public updates log.',
    );
    lines.push('');
    for (const d of drafts.slice(0, 8)) {
      const biz = d.business ? `_${d.business}_ · ` : '';
      lines.push(`- ${biz}${d.headline} _(\`${d.filename}\`)_`);
    }
    lines.push('');
    lines.push(
      '_Open a Claude session and call `taskpilot_list_update_drafts` to drain the queue._',
    );
    lines.push('');
  }

  // --- Recommended first move -------------------------------------------
  lines.push('## Recommended first move');
  lines.push('');
  const firstMove = pickFirstMove({ overdue, review, drafts });
  lines.push(firstMove);
  lines.push('');

  lines.push('---');
  lines.push(
    '_Live status per business is at `~/.taskpilot/businesses/<tag>/STATUS.md`. ' +
      'Need depth on one? Open Claude in that repo — SessionStart will inject the full picture._',
  );
  lines.push('');

  const markdown = lines.join('\n');
  await fs.mkdir(path.dirname(BRIEF_PATH), { recursive: true });
  await fs.writeFile(BRIEF_PATH, markdown, 'utf8');
  try {
    settingsRepository.set(BRIEF_LAST_RUN_KEY, date);
  } catch {
    /* non-fatal — the brief still got written */
  }
  return {
    date,
    markdown,
    path: BRIEF_PATH,
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };
}

function pickFirstMove(args: {
  overdue: Task[];
  review: Task[];
  drafts: PendingDraft[];
}): string {
  if (args.overdue.length > 0) {
    const t = args.overdue[0]!;
    const days = t.due ? daysSince(t.due) : 0;
    return `**Resolve the ${days}-day overdue task** — "${t.title}". Either ship it, snooze it, or kill it. Stale overdues drag everything.`;
  }
  if (args.review.length > 0) {
    return `**Drain the review queue (${args.review.length} item${args.review.length === 1 ? '' : 's'}).** Quick approvals first — anything that has been waiting on you blocks downstream agent work.`;
  }
  if (args.drafts.length > 0) {
    return `**Publish the pending updates (${args.drafts.length}).** Open Claude, call \`taskpilot_list_update_drafts\`, draft each in voice, push via \`taskpilot_publish_update\`. 15 min of focused work clears the public-facing log backlog.`;
  }
  return `**Open the business with the longest "last touched" gap** and decide whether to invest in it this week or let it sit. Don't start the day on whatever's loudest — start on whatever's quietest but still mattering.`;
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

/** Read the cached brief from disk, or null if it doesn't exist. */
export async function readMorningBrief(): Promise<string | null> {
  try {
    return await fs.readFile(BRIEF_PATH, 'utf8');
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

/** True when today's brief hasn't been generated yet. */
export function isMorningBriefDue(): boolean {
  try {
    const raw = settingsRepository.get(BRIEF_LAST_RUN_KEY);
    if (typeof raw !== 'string') return true;
    return raw !== todayLocalDate();
  } catch {
    return true;
  }
}

/** Public path so callers can show "open this file" in the UI. */
export function morningBriefPath(): string {
  return BRIEF_PATH;
}
