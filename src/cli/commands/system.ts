/**
 * Top-level convenience commands: `inbox`, `sweep`, `context refresh`.
 */

import { Command } from 'commander';
import { apiGet, apiPost } from '../api-client.js';
import { printJson, printTaskList, pickPretty } from '../format.js';
import type { Task } from '@/shared/types';

export function registerSystemCommands(program: Command): void {
  // inbox --------------------------------------------------------------------
  program
    .command('inbox')
    .description("Shortcut for `task list --status=inbox`")
    .action(async () => {
      const res = await apiGet<{ tasks: Task[] } | Task[]>('/api/tasks', { status: 'inbox' });
      const tasks = Array.isArray(res) ? res : res.tasks;
      if (pickPretty()) {
        printTaskList(tasks);
      } else {
        printJson(tasks);
      }
    });

  // sweep --------------------------------------------------------------------
  program
    .command('sweep')
    .description('Show tasks whose due date has passed but are not done/failed')
    .action(async () => {
      const res = await apiGet<{ tasks: Task[] } | Task[]>('/api/tasks');
      const tasks = Array.isArray(res) ? res : res.tasks;
      const now = Date.now();
      const overdue = tasks.filter((t) => {
        if (!t.due) return false;
        if (t.status === 'done' || t.status === 'failed') return false;
        const due = Date.parse(t.due);
        if (Number.isNaN(due)) return false;
        return due < now;
      });
      if (pickPretty()) {
        if (overdue.length === 0) {
          process.stdout.write('No overdue tasks.\n');
        } else {
          printTaskList(overdue);
        }
      } else {
        printJson(overdue);
      }
    });

  // context refresh ----------------------------------------------------------
  const context = program.command('context').description('Shared context for Claude');
  context
    .command('refresh')
    .description('Trigger a refresh of ~/.taskpilot/io/context/*')
    .action(async () => {
      // No dedicated endpoint yet; per spec, POST /api/io/ingest with a
      // refresh hint until the server adds a real route.
      const result = await apiPost<unknown>('/api/io/ingest', { refresh_context: true });
      if (pickPretty()) {
        process.stdout.write('Context refresh requested\n');
      } else {
        printJson(result ?? { ok: true });
      }
    });
}
