/**
 * Output helpers for the TaskPilot CLI.
 *
 * Two output modes:
 *  - JSON (default): a single JSON object on stdout, no decoration, no spinners.
 *  - Pretty: aligned tables and colored output for humans.
 *
 * Pretty mode is opt-in via `--pretty` on any command. `--json` is also accepted
 * for clarity but is the default; the two are mutually exclusive (last one wins
 * via commander).
 */

import chalk from 'chalk';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Output mode (set from a commander hook in index.ts)                       */
/* -------------------------------------------------------------------------- */

let prettyMode = false;

export function setPretty(value: boolean): void {
  prettyMode = value;
}

export function pickPretty(): boolean {
  return prettyMode;
}

/* -------------------------------------------------------------------------- */
/*  JSON                                                                       */
/* -------------------------------------------------------------------------- */

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/* -------------------------------------------------------------------------- */
/*  Plain tables                                                              */
/* -------------------------------------------------------------------------- */

export interface TableColumn<T> {
  header: string;
  get: (row: T) => string;
  width?: number; // max chars before truncation; defaults to natural width
}

export function printTable<T>(rows: T[], columns: TableColumn<T>[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
    return;
  }

  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const valueLens = rows.map((r) => visibleLength(col.get(r)));
    const max = Math.max(headerLen, ...valueLens);
    return col.width !== undefined ? Math.min(max, col.width) : max;
  });

  const headerLine = columns
    .map((col, i) => pad(col.header, widths[i] ?? 0))
    .join('  ');
  const sepLine = widths.map((w) => '-'.repeat(w)).join('  ');

  process.stdout.write(chalk.bold(headerLine) + '\n');
  process.stdout.write(chalk.dim(sepLine) + '\n');

  for (const row of rows) {
    const line = columns
      .map((col, i) => pad(truncate(col.get(row), widths[i] ?? 0), widths[i] ?? 0))
      .join('  ');
    process.stdout.write(line + '\n');
  }
}

function pad(s: string, width: number): string {
  const len = visibleLength(s);
  if (len >= width) return s;
  return s + ' '.repeat(width - len);
}

function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

/** Approximate visible length — strips basic ANSI escapes. */
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/* -------------------------------------------------------------------------- */
/*  Task formatters                                                           */
/* -------------------------------------------------------------------------- */

const statusColor: Record<string, (s: string) => string> = {
  inbox: chalk.gray,
  queued: chalk.blue,
  in_progress: chalk.yellow,
  blocked: chalk.red,
  done: chalk.green,
  failed: chalk.redBright,
};

const priorityColor: Record<string, (s: string) => string> = {
  p0: chalk.redBright,
  p1: chalk.yellow,
  p2: chalk.white,
  p3: chalk.dim,
};

function colorStatus(s: string): string {
  const fn = statusColor[s];
  return fn ? fn(s) : s;
}

function colorPriority(p: string): string {
  const fn = priorityColor[p];
  return fn ? fn(p) : p;
}

function fmtDate(value: string | null): string {
  if (!value) return '-';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  } catch {
    return value;
  }
}

export function printTask(task: Task): void {
  const lines: string[] = [];
  lines.push(chalk.bold(task.title));
  lines.push(chalk.dim(`id: ${task.id}`));
  lines.push(
    `status: ${colorStatus(task.status)}  priority: ${colorPriority(task.priority)}  agent: ${task.agent_method} (${task.agent_status})`,
  );
  if (task.due) lines.push(`due: ${fmtDate(task.due)}`);
  if (task.parent_id) lines.push(chalk.dim(`parent: ${task.parent_id}`));
  if (task.tags.length > 0) lines.push(`tags: ${task.tags.join(', ')}`);
  if (task.description) {
    lines.push('');
    lines.push(task.description);
  }
  if (task.agent_instructions) {
    lines.push('');
    lines.push(chalk.dim('agent_instructions:'));
    lines.push(task.agent_instructions);
  }
  lines.push('');
  lines.push(
    chalk.dim(`created: ${fmtDate(task.created_at)}  updated: ${fmtDate(task.updated_at)}`),
  );
  process.stdout.write(lines.join('\n') + '\n');
}

export function printTaskList(tasks: Task[]): void {
  const columns: TableColumn<Task>[] = [
    { header: 'ID', get: (t) => t.id, width: 14 },
    { header: 'STATUS', get: (t) => colorStatus(t.status), width: 12 },
    { header: 'PRI', get: (t) => colorPriority(t.priority), width: 3 },
    { header: 'AGENT', get: (t) => t.agent_method, width: 10 },
    { header: 'DUE', get: (t) => (t.due ? fmtDate(t.due) : '-'), width: 20 },
    { header: 'TITLE', get: (t) => t.title, width: 60 },
  ];
  printTable(tasks, columns);
}
