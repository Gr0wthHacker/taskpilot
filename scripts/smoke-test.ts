/**
 * Smoke test — exercises the DB + I/O protocol end to end without booting
 * Electron or the API server. Useful as a quick sanity check during local
 * development and CI.
 *
 * Cleans up after itself: the test task is deleted and its derive request
 * is removed before exit, so repeated runs don't pollute `~/.taskpilot/io/`
 * or leave phantom tasks the UI would render with a spinner.
 *
 * Run: `npm run smoke` (or `npx tsx scripts/smoke-test.ts`).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { closeDb, getDb } from '@/main/db';
import { createTask, deleteTask, listTasks } from '@/main/db/repositories/tasks';
import { writeDeriveRequest } from '@/main/io/protocol';
import { ensureDirs, IO_DERIVE } from '@/shared/constants';

async function main(): Promise<void> {
  ensureDirs();
  getDb();

  const task = createTask({
    title: 'smoke test',
    priority: 'p2',
  });
  // eslint-disable-next-line no-console
  console.log('Created:', task.id);

  const all = listTasks({});
  // eslint-disable-next-line no-console
  console.log('Listed:', all.length);

  await writeDeriveRequest(task, {
    calendar_snapshot: '{}',
    related_tasks: [],
    available_tools: [],
    execution_modes: ['cowork', 'cli'],
  });
  // eslint-disable-next-line no-console
  console.log('Wrote derive request');

  // Tear down: delete the io/derive file we just wrote, then drop the row.
  // Without this, every smoke run left a stale derive request that the UI
  // surfaces as "running" and a phantom 'smoke test' task in the inbox.
  await fs
    .unlink(path.join(IO_DERIVE, `${task.id}.json`))
    .catch(() => undefined);
  deleteTask(task.id);
  // eslint-disable-next-line no-console
  console.log('Cleaned up');

  closeDb();
  // eslint-disable-next-line no-console
  console.log('OK');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
