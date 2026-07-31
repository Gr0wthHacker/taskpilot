/**
 * Weekly status report generator (Wave 16E).
 *
 * `generateStatusReport(window)` produces a {@link StatusReport}: a rolled-up
 * snapshot of what happened in a time window, plus a ready-to-publish Markdown
 * body. It is pure read + format — it never mutates a task, never publishes,
 * and never throws on a partially-populated DB (every source defaults to empty
 * rather than blowing up the whole report).
 *
 * The report answers "what got done, what's in flight, what's stuck, and what
 * did it cost" over a window. The default window is the trailing 7 days, which
 * matches the weekly cron cadence (Mondays 8am).
 *
 * Data sources:
 *   - `tasks` table (via raw SQLite) for the status counts, by-tag/by-workspace
 *     rollups, and the completed/in-progress/blocked lists.
 *   - `@/main/cost-tracking` for the window cost figure.
 *   - `@/main/outputs/collector` for output URLs on completed tasks — pulled
 *     through a DEFENSIVE dynamic import so a missing/renamed collector
 *     downgrades the "Notable outputs" section to "no links" rather than
 *     failing the report.
 *
 * Ownership note: this module deliberately stays out of the analytics
 * aggregations in `@/main/reports/aggregations` (the dashboard's domain). It
 * shares only the SQLite handle.
 */

import path from 'node:path';

import { getSqlite } from '@/main/db';
import { settingsRepository } from '@/main/db/repositories/settings';
import { TASKPILOT_HOME } from '@/shared/constants';
import type {
  StatusReport,
  StatusReportHighlight,
  StatusReportMetrics,
  StatusReportTagRow,
  StatusReportWindow,
  StatusReportWorkspaceRow,
} from '@/shared/api-contract';
import type { TaskPriority, TaskStatus, Workspace } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Window resolution                                                          */
/* -------------------------------------------------------------------------- */

export interface ResolvedWindow {
  from: string;
  to: string;
}

const WINDOW_DAYS: Record<StatusReportWindow, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface GenerateStatusReportInput {
  /** Named window. Ignored when `from`/`to` are supplied. Defaults to `7d`. */
  window?: StatusReportWindow;
  /** Explicit ISO bounds. When both are present they win over `window`. */
  from?: string;
  to?: string;
}

/**
 * Resolve the input into a concrete `{ from, to }` ISO pair. Explicit bounds
 * win; otherwise the named window is subtracted from `now`. An invalid
 * explicit bound silently falls back to the 7d default rather than throwing —
 * the route layer validates user input before we get here, so this is purely
 * defensive.
 */
export function resolveWindow(input: GenerateStatusReportInput = {}): ResolvedWindow {
  const now = Date.now();
  if (input.from && input.to) {
    const fromMs = Date.parse(input.from);
    const toMs = Date.parse(input.to);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs >= fromMs) {
      return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    }
  }
  const days = WINDOW_DAYS[input.window ?? '7d'] ?? 7;
  return {
    from: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const PRIORITY_RANK: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due: string | null;
  tags: string | null;
  updated_at: string;
}

function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
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

/**
 * Tasks whose `updated_at` falls in the window. We key on `updated_at`
 * because that's when a task last transitioned (closed, blocked, etc.) — it's
 * the closest proxy the schema gives us for "activity in this window". The
 * `overdue` count is the only metric that ignores the window (a task overdue
 * today is overdue regardless of when it was last touched).
 */
function fetchWindowTasks(win: ResolvedWindow): TaskRow[] {
  const sqlite = getSqlite();
  return sqlite
    .prepare(
      `SELECT id, title, status, priority, due, tags, updated_at
         FROM tasks
        WHERE updated_at >= ? AND updated_at <= ?
        ORDER BY updated_at DESC`,
    )
    .all(win.from, win.to) as TaskRow[];
}

/** Count of non-terminal tasks whose `due` is before `to`. Window-agnostic. */
function countOverdue(toIso: string): number {
  const sqlite = getSqlite();
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n
         FROM tasks
        WHERE due IS NOT NULL
          AND due < ?
          AND status NOT IN ('done','failed','archived')`,
    )
    .get(toIso) as { n: number } | undefined;
  return row ? Number(row.n) || 0 : 0;
}

/** Window cost, via the cost-tracking aggregator. Defensive — 0 on failure. */
async function windowCostUsd(win: ResolvedWindow): Promise<number> {
  try {
    // The aggregator takes a `Nd` window string OR resolves "all". We pass an
    // explicit day span derived from the resolved window so a custom range
    // still maps to a sane figure. Dynamic import so the alias + test DB mock
    // resolve consistently (a CJS `require` of an aliased path bypasses both).
    const cost = (await import(
      '@/main/cost-tracking'
    )) as typeof import('@/main/cost-tracking');
    const spanMs = Date.parse(win.to) - Date.parse(win.from);
    const days = Math.max(1, Math.ceil(spanMs / (24 * 60 * 60 * 1000)));
    const summary = cost.aggregateCost(`${days}d`);
    return Math.round((summary.total_usd ?? 0) * 1_000_000) / 1_000_000;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Output URL resolution (defensive dynamic import)                           */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort: pull the first artifact/file URL the Wave 15B outputs collector
 * surfaces for a task. Returns `null` for any task with no URL-bearing output,
 * and `null` for EVERY task if the collector module can't be loaded (renamed,
 * removed, etc.) — the report still renders, just without links.
 */
async function resolveOutputUrls(
  taskIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const id of taskIds) out.set(id, null);
  if (taskIds.length === 0) return out;

  let collector: typeof import('@/main/outputs/collector') | null = null;
  try {
    collector = (await import(
      '@/main/outputs/collector'
    )) as typeof import('@/main/outputs/collector');
  } catch {
    return out; // collector unavailable — every entry stays null
  }
  if (typeof collector.collectOutputs !== 'function') return out;

  for (const id of taskIds) {
    try {
      const bundle = await collector.collectOutputs(id);
      out.set(id, firstUrlFromBundle(bundle));
    } catch {
      // Per-task failure (unknown id, malformed result) → no URL for that task.
      out.set(id, null);
    }
  }
  return out;
}

/**
 * Pick the single most actionable URL out of an output bundle: prefer an
 * external artifact (PR / page / thread), then fall back to a file path. The
 * artifact shapes differ by `kind`, so we sniff the known URL-bearing fields.
 */
function firstUrlFromBundle(
  bundle: Awaited<ReturnType<typeof import('@/main/outputs/collector').collectOutputs>>,
): string | null {
  for (const art of bundle.artifacts) {
    const a = art as unknown as Record<string, unknown>;
    const url = a['url'] ?? a['permalink'] ?? a['html_url'];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  // No external link — fall back to the first output file path so the report
  // at least points at *something* on disk.
  const file = bundle.files[0];
  if (file && typeof file.path === 'string' && file.path.length > 0) {
    return file.path;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate a status report for the resolved window. Pure: read + format.
 */
export async function generateStatusReport(
  input: GenerateStatusReportInput = {},
): Promise<StatusReport> {
  const win = resolveWindow(input);
  const tasks = fetchWindowTasks(win);

  // Status counts ----------------------------------------------------------
  const metrics: StatusReportMetrics = {
    done: 0,
    in_progress: 0,
    blocked: 0,
    failed: 0,
    overdue: countOverdue(win.to),
    cost_usd: await windowCostUsd(win),
  };
  for (const t of tasks) {
    if (t.status === 'done') metrics.done += 1;
    else if (t.status === 'in_progress') metrics.in_progress += 1;
    else if (t.status === 'blocked') metrics.blocked += 1;
    else if (t.status === 'failed') metrics.failed += 1;
  }

  // By-tag + by-workspace rollups -----------------------------------------
  const byTag = rollupByTag(tasks);
  const byWorkspace = rollupByWorkspace(tasks, readWorkspaces());

  // Highlights — completed tasks with a resolvable output URL --------------
  const completed = tasks.filter((t) => t.status === 'done');
  const urlMap = await resolveOutputUrls(completed.map((t) => t.id));
  const highlights: StatusReportHighlight[] = completed
    .map((t) => ({
      task_id: t.id,
      title: t.title,
      url: urlMap.get(t.id) ?? null,
    }))
    // Highlights lead with tasks that have a shareable URL.
    .sort((a, b) => Number(Boolean(b.url)) - Number(Boolean(a.url)))
    .slice(0, 10);

  const markdown = renderMarkdown({
    win,
    metrics,
    tasks,
    byTag,
    byWorkspace,
    highlights,
  });

  return {
    window: win,
    generated_at: new Date().toISOString(),
    markdown,
    metrics,
    by_tag: byTag,
    by_workspace: byWorkspace,
    highlights,
  };
}

/* -------------------------------------------------------------------------- */
/*  Rollups                                                                    */
/* -------------------------------------------------------------------------- */

function rollupByTag(tasks: TaskRow[]): StatusReportTagRow[] {
  const map = new Map<string, StatusReportTagRow>();
  for (const t of tasks) {
    for (const tag of parseTags(t.tags)) {
      let row = map.get(tag);
      if (!row) {
        row = { tag, done: 0, total: 0 };
        map.set(tag, row);
      }
      row.total += 1;
      if (t.status === 'done') row.done += 1;
    }
  }
  return [...map.values()].sort((a, b) => {
    if (b.done !== a.done) return b.done - a.done;
    if (b.total !== a.total) return b.total - a.total;
    return a.tag.localeCompare(b.tag);
  });
}

function rollupByWorkspace(
  tasks: TaskRow[],
  workspaces: Workspace[],
): StatusReportWorkspaceRow[] {
  if (workspaces.length === 0) return [];
  const map = new Map<string, StatusReportWorkspaceRow>();
  for (const t of tasks) {
    const tags = parseTags(t.tags);
    for (const ws of workspaces) {
      if (tags.some((tag) => ws.tags.includes(tag))) {
        let row = map.get(ws.id);
        if (!row) {
          row = { workspace: ws.name, done: 0, total: 0 };
          map.set(ws.id, row);
        }
        row.total += 1;
        if (t.status === 'done') row.done += 1;
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (b.done !== a.done) return b.done - a.done;
    return b.total - a.total;
  });
}

/* -------------------------------------------------------------------------- */
/*  Markdown rendering                                                         */
/* -------------------------------------------------------------------------- */

interface RenderInput {
  win: ResolvedWindow;
  metrics: StatusReportMetrics;
  tasks: TaskRow[];
  byTag: StatusReportTagRow[];
  byWorkspace: StatusReportWorkspaceRow[];
  highlights: StatusReportHighlight[];
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

/** `2026-05-20` from an ISO timestamp. */
function dateLabel(iso: string): string {
  return iso.slice(0, 10);
}

function priorityLabel(p: TaskPriority): string {
  return p.toUpperCase();
}

function sortByPriority(rows: TaskRow[]): TaskRow[] {
  return [...rows].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority] ?? 9;
    const pb = PRIORITY_RANK[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/**
 * Render the full Markdown body. Sections that have no rows are still printed
 * with an explicit "None" line so the reader knows it wasn't dropped.
 */
export function renderMarkdown(input: RenderInput): string {
  const { win, metrics, tasks, byTag, byWorkspace, highlights } = input;
  const lines: string[] = [];

  // # Header --------------------------------------------------------------
  lines.push(`# TaskPilot Status Report`);
  lines.push('');
  lines.push(
    `**Window:** ${dateLabel(win.from)} → ${dateLabel(win.to)}  `,
  );
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');

  // ## Headline -----------------------------------------------------------
  const pendingReview = tasks.filter(
    (t) => t.status === 'blocked' || t.status === 'failed',
  ).length;
  lines.push('## Headline');
  lines.push('');
  lines.push(
    `${metrics.done} task${metrics.done === 1 ? '' : 's'} closed · ` +
      `${fmtUsd(metrics.cost_usd)} spent · ` +
      `${pendingReview} pending review` +
      (metrics.overdue > 0 ? ` · ${metrics.overdue} overdue` : ''),
  );
  lines.push('');

  // ## Completed ----------------------------------------------------------
  lines.push('## Completed');
  lines.push('');
  const done = sortByPriority(tasks.filter((t) => t.status === 'done'));
  const urlByTask = new Map(highlights.map((h) => [h.task_id, h.url]));
  if (done.length === 0) {
    lines.push('_None._');
  } else {
    for (const t of done) {
      const url = urlByTask.get(t.id);
      const link = url ? ` — [output](${url})` : '';
      lines.push(`- [${priorityLabel(t.priority)}] ${t.title}${link}`);
    }
  }
  lines.push('');

  // ## In progress --------------------------------------------------------
  lines.push('## In progress');
  lines.push('');
  const inProgress = sortByPriority(
    tasks.filter((t) => t.status === 'in_progress'),
  ).slice(0, 10);
  if (inProgress.length === 0) {
    lines.push('_None._');
  } else {
    for (const t of inProgress) {
      lines.push(`- [${priorityLabel(t.priority)}] ${t.title}`);
    }
  }
  lines.push('');

  // ## Blocked / Failed ---------------------------------------------------
  lines.push('## Blocked / Failed');
  lines.push('');
  const stuck = sortByPriority(
    tasks.filter((t) => t.status === 'blocked' || t.status === 'failed'),
  );
  if (stuck.length === 0) {
    lines.push('_None._');
  } else {
    for (const t of stuck) {
      const tag = t.status === 'failed' ? 'FAILED' : 'BLOCKED';
      lines.push(`- [${tag}] ${t.title}`);
    }
  }
  lines.push('');

  // ## By project ---------------------------------------------------------
  lines.push('## By project');
  lines.push('');
  const projectRows = byWorkspace.length > 0 ? byWorkspace : null;
  if (projectRows) {
    lines.push('| Project | Done | Total |');
    lines.push('| --- | ---: | ---: |');
    for (const row of projectRows) {
      lines.push(`| ${row.workspace} | ${row.done} | ${row.total} |`);
    }
  } else if (byTag.length > 0) {
    // No workspaces configured — fall back to a by-tag table so the section
    // still carries signal.
    lines.push('| Tag | Done | Total |');
    lines.push('| --- | ---: | ---: |');
    for (const row of byTag.slice(0, 15)) {
      lines.push(`| ${row.tag} | ${row.done} | ${row.total} |`);
    }
  } else {
    lines.push('_No tagged activity in this window._');
  }
  lines.push('');

  // ## Notable outputs ----------------------------------------------------
  lines.push('## Notable outputs');
  lines.push('');
  const linked = highlights.filter((h) => h.url);
  if (linked.length === 0) {
    lines.push('_No linked outputs in this window._');
  } else {
    for (const h of linked) {
      lines.push(`- [${h.title}](${h.url})`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Reports directory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve `~/.taskpilot/reports/`. Derived from `TASKPILOT_HOME` (which test
 * mocks redirect) rather than a dedicated constant, so we don't have to widen
 * the shared constants module or its test mock.
 */
export function reportsDir(): string {
  return path.join(TASKPILOT_HOME, 'reports');
}

/* -------------------------------------------------------------------------- */
/*  Internal exports (tests)                                                   */
/* -------------------------------------------------------------------------- */

export const __internals = {
  resolveWindow,
  rollupByTag,
  rollupByWorkspace,
  fmtUsd,
  dateLabel,
  firstUrlFromBundle,
  WINDOW_DAYS,
};
