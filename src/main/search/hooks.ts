/**
 * Search-index incremental update hooks (Wave 17 — search).
 *
 * Side-effect module: importing it registers listeners on the task + decision
 * repositories so the FTS5 `search_index` stays in sync as data changes,
 * without the repos needing to know the search engine exists.
 *
 *   - task written (create / update)   → re-index that task + its attachments
 *   - task pre-delete                  → remove every index row for that task
 *   - decision created                 → index that decision entry
 *   - decision deleted                 → remove that decision's index row
 *
 * Result ingestion (the agent path that appends execution outputs) is handled
 * separately inside `io/ingestion.ts`, which re-indexes the task + its
 * execution outputs. Every hook here is best-effort: the indexer itself
 * swallows errors and no-ops when FTS5 is unavailable, so registering these is
 * always safe.
 *
 * `installSearchHooks()` is idempotent — calling it twice (e.g. server boot +
 * a test) won't double-register. The server imports this module for its side
 * effect; tests can call `installSearchHooks()` explicitly.
 */

import {
  addOnTaskWritten,
  registerOnTaskPreDelete,
} from '@/main/db/repositories/tasks';
import { addOnDecisionWritten } from '@/main/db/repositories/decisions';
import { addOnMemoryWritten } from '@/main/memory/repository';

import { indexDecision, indexMemory, indexTask, removeEntity } from './indexer';

let installed = false;

/**
 * Wire the repository hooks into the indexer. Idempotent.
 */
export function installSearchHooks(): void {
  if (installed) return;
  installed = true;

  // Task create/update → re-index. `indexTask` re-derives the task row and its
  // attachment rows, so this covers description / agent_instructions /
  // attachment changes alike.
  addOnTaskWritten((taskId) => {
    indexTask(taskId);
  });

  // Task delete → cascade-remove every index row keyed by this task id
  // (the task row plus its attachment / decision / execution rows).
  registerOnTaskPreDelete((taskId) => {
    removeEntity('task', taskId);
  });

  // Decision create/delete → upsert / remove that one entry's index row.
  addOnDecisionWritten((id, op) => {
    if (op === 'delete') {
      removeEntity('decision', id);
    } else {
      indexDecision(id);
    }
  });

  // Memory create/update/delete → upsert / remove that item's index row.
  addOnMemoryWritten((id, op) => {
    if (op === 'delete') {
      removeEntity('memory', id);
    } else {
      indexMemory(id);
    }
  });
}

// Install on import so the side-effect import in the server boots the hooks.
installSearchHooks();
