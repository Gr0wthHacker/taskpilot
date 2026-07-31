/**
 * Task-mutation audit hooks.
 *
 * Wires the tasks repository's existing onTaskWritten + onTaskPreDelete
 * registries into the audit log so every create/update/delete leaves a
 * trail. Lets us answer "who deleted task X?" or "when did this title
 * change?" without git-style history tables.
 *
 * Idempotent: installAuditTaskHooks() registers exactly once even when
 * called from both tests and main boot.
 */

import { appendAuditEventSafe } from '@/main/audit/log';
import {
  addOnTaskWritten,
  registerOnTaskPreDelete,
} from '@/main/db/repositories/tasks';

let installed = false;
let writeUnsubscribe: (() => void) | null = null;

export function installAuditTaskHooks(): void {
  if (installed) return;
  installed = true;

  writeUnsubscribe = addOnTaskWritten((taskId) => {
    appendAuditEventSafe({
      kind: 'task_written',
      payload: { task_id: taskId },
    });
  });

  registerOnTaskPreDelete((taskId) => {
    appendAuditEventSafe({
      kind: 'task_deleted',
      payload: { task_id: taskId },
    });
  });
}

/** Testing helper. Resets state so a test run gets clean registration. */
export function _resetAuditTaskHooksForTest(): void {
  if (writeUnsubscribe) writeUnsubscribe();
  writeUnsubscribe = null;
  installed = false;
}
