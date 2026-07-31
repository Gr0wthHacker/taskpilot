/**
 * `taskpilot task ...` subcommands.
 *
 * Thin shim over the local HTTP API. Each command emits JSON by default; pass
 * `--pretty` for human-readable output. Exit codes: 0 success, 1 error,
 * 2 needs-review (mapped by `runCli` in index.ts).
 */

import { Command } from 'commander';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';
import { printJson, printTask, printTaskList, pickPretty } from '../format.js';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  AgentMethod,
  ApprovalKind,
} from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Parsers                                                                   */
/* -------------------------------------------------------------------------- */

function parseStatus(value: string): TaskStatus {
  const allowed: TaskStatus[] = ['inbox', 'queued', 'in_progress', 'blocked', 'done', 'failed'];
  if (!allowed.includes(value as TaskStatus)) {
    throw new Error(`Invalid status "${value}". Must be one of: ${allowed.join(', ')}`);
  }
  return value as TaskStatus;
}

function parsePriority(value: string): TaskPriority {
  const allowed: TaskPriority[] = ['p0', 'p1', 'p2', 'p3'];
  if (!allowed.includes(value as TaskPriority)) {
    throw new Error(`Invalid priority "${value}". Must be one of: ${allowed.join(', ')}`);
  }
  return value as TaskPriority;
}

function parseAgentMethod(value: string): AgentMethod {
  const allowed: AgentMethod[] = ['cowork', 'cli', 'either', 'human_only'];
  if (!allowed.includes(value as AgentMethod)) {
    throw new Error(`Invalid agent-method "${value}". Must be one of: ${allowed.join(', ')}`);
  }
  return value as AgentMethod;
}

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseKind(value: string): ApprovalKind {
  if (value !== 'derivation' && value !== 'result') {
    throw new Error(`Invalid --kind "${value}". Must be derivation or result.`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*  Output helpers                                                            */
/* -------------------------------------------------------------------------- */

function emitTask(task: Task): void {
  if (pickPretty()) {
    printTask(task);
  } else {
    printJson(task);
  }
}

function emitTaskList(tasks: Task[]): void {
  if (pickPretty()) {
    printTaskList(tasks);
  } else {
    printJson(tasks);
  }
}

/* -------------------------------------------------------------------------- */
/*  Command registration                                                      */
/* -------------------------------------------------------------------------- */

export function registerTaskCommand(program: Command): void {
  const task = program.command('task').description('Manage tasks');

  // list ---------------------------------------------------------------------
  task
    .command('list')
    .description('List tasks')
    .option('--status <status>', 'Filter by status')
    .option('--priority <priority>', 'Filter by priority')
    .option('--agent-only', 'Only tasks marked agent_executable')
    .option('--parent <id>', 'Filter by parent task id')
    .action(async (opts: {
      status?: string;
      priority?: string;
      agentOnly?: boolean;
      parent?: string;
    }) => {
      const query: Record<string, string | boolean | undefined> = {};
      if (opts.status) query.status = parseStatus(opts.status);
      if (opts.priority) query.priority = parsePriority(opts.priority);
      if (opts.agentOnly) query.agent_only = true;
      if (opts.parent) query.parent = opts.parent;
      const res = await apiGet<{ tasks: Task[] } | Task[]>('/api/tasks', query);
      const tasks = Array.isArray(res) ? res : res.tasks;
      emitTaskList(tasks);
    });

  // create -------------------------------------------------------------------
  task
    .command('create <title>')
    .description('Create a new task')
    .option('--priority <priority>', 'Priority (p0..p3)')
    .option('--due <iso>', 'Due date (ISO 8601)')
    .option('--description <text>', 'Description')
    .option('--tags <list>', 'Comma-separated tags')
    .option('--agent-method <method>', 'cowork|cli|either|human_only')
    .action(async (title: string, opts: {
      priority?: string;
      due?: string;
      description?: string;
      tags?: string;
      agentMethod?: string;
    }) => {
      const body: Record<string, unknown> = { title };
      if (opts.priority) body.priority = parsePriority(opts.priority);
      if (opts.due) body.due = opts.due;
      if (opts.description) body.description = opts.description;
      if (opts.tags) body.tags = parseTags(opts.tags);
      if (opts.agentMethod) body.agent_method = parseAgentMethod(opts.agentMethod);
      const created = await apiPost<{ task: Task } | Task>('/api/tasks', body);
      const task = 'task' in (created as object) ? (created as { task: Task }).task : (created as Task);
      emitTask(task);
    });

  // show ---------------------------------------------------------------------
  task
    .command('show <id>')
    .description('Show one task')
    .action(async (id: string) => {
      const res = await apiGet<{ task: Task } | Task>(`/api/tasks/${encodeURIComponent(id)}`);
      const t = 'task' in (res as object) ? (res as { task: Task }).task : (res as Task);
      emitTask(t);
    });

  // update -------------------------------------------------------------------
  task
    .command('update <id>')
    .description('Update an existing task')
    .option('--status <status>')
    .option('--priority <priority>')
    .option('--due <iso>')
    .option('--title <title>')
    .option('--description <text>')
    .option('--tags <list>', 'Comma-separated tags (replaces existing)')
    .option('--agent-instructions <text>')
    .option('--agent-method <method>')
    .action(async (id: string, opts: {
      status?: string;
      priority?: string;
      due?: string;
      title?: string;
      description?: string;
      tags?: string;
      agentInstructions?: string;
      agentMethod?: string;
    }) => {
      const body: Record<string, unknown> = {};
      if (opts.status) body.status = parseStatus(opts.status);
      if (opts.priority) body.priority = parsePriority(opts.priority);
      if (opts.due !== undefined) body.due = opts.due;
      if (opts.title !== undefined) body.title = opts.title;
      if (opts.description !== undefined) body.description = opts.description;
      if (opts.tags !== undefined) body.tags = parseTags(opts.tags);
      if (opts.agentInstructions !== undefined) body.agent_instructions = opts.agentInstructions;
      if (opts.agentMethod) body.agent_method = parseAgentMethod(opts.agentMethod);
      const updated = await apiPatch<{ task: Task } | Task>(`/api/tasks/${encodeURIComponent(id)}`, body);
      const t = 'task' in (updated as object) ? (updated as { task: Task }).task : (updated as Task);
      emitTask(t);
    });

  // delete -------------------------------------------------------------------
  task
    .command('delete <id>')
    .description('Delete a task')
    .option('--yes', 'Skip confirmation prompt (required in pretty mode)')
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (pickPretty() && !opts.yes) {
        process.stderr.write(`Refusing to delete ${id} without --yes (pretty mode).\n`);
        process.exitCode = 1;
        return;
      }
      const result = await apiDelete<unknown>(`/api/tasks/${encodeURIComponent(id)}`);
      if (pickPretty()) {
        process.stdout.write(`Deleted ${id}\n`);
      } else {
        printJson(result ?? { ok: true, id });
      }
    });

  // derive -------------------------------------------------------------------
  task
    .command('derive <id>')
    .description('Write a derivation request file for Claude')
    .action(async (id: string) => {
      const result = await apiPost<unknown>(`/api/tasks/${encodeURIComponent(id)}/derive`);
      if (pickPretty()) {
        process.stdout.write(`Derivation request written for ${id}\n`);
      } else {
        printJson(result ?? { ok: true, id });
      }
    });

  // execute ------------------------------------------------------------------
  task
    .command('execute <id>')
    .description('Write an execution request file for Claude')
    .action(async (id: string) => {
      const result = await apiPost<unknown>(`/api/tasks/${encodeURIComponent(id)}/execute`);
      if (pickPretty()) {
        process.stdout.write(`Execution request written for ${id}\n`);
      } else {
        printJson(result ?? { ok: true, id });
      }
    });

  // approve ------------------------------------------------------------------
  task
    .command('approve <id>')
    .description('Approve a derivation or execution result')
    .requiredOption('--kind <kind>', 'derivation|result')
    .action(async (id: string, opts: { kind: string }) => {
      const kind = parseKind(opts.kind);
      const result = await apiPost<unknown>(`/api/tasks/${encodeURIComponent(id)}/approve`, { kind });
      if (pickPretty()) {
        process.stdout.write(`Approved ${kind} for ${id}\n`);
      } else {
        printJson(result ?? { ok: true, id, kind });
      }
    });

  // reject -------------------------------------------------------------------
  task
    .command('reject <id>')
    .description('Reject a derivation or execution result')
    .requiredOption('--kind <kind>', 'derivation|result')
    .option('--requeue', 'Send the task back to the queue')
    .option('--reason <text>', 'Reason for rejection')
    .action(async (id: string, opts: { kind: string; requeue?: boolean; reason?: string }) => {
      const kind = parseKind(opts.kind);
      const body: Record<string, unknown> = { kind };
      if (opts.requeue) body.requeue = true;
      if (opts.reason !== undefined) body.reason = opts.reason;
      const result = await apiPost<unknown>(`/api/tasks/${encodeURIComponent(id)}/reject`, body);
      if (pickPretty()) {
        process.stdout.write(`Rejected ${kind} for ${id}\n`);
      } else {
        printJson(result ?? { ok: true, id, kind });
      }
    });
}
