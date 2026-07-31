/**
 * Module-singleton holder for the backup scheduler handle.
 *
 * The API server boot path starts the scheduler and stashes its handle here
 * so route handlers can read `status()` without re-importing the module.
 * Tests / standalone scripts may also set this directly for assertions.
 */

import type { ScheduledBackupsHandle } from './index';

let handle: ScheduledBackupsHandle | null = null;

export function setScheduledBackupsHandle(
  next: ScheduledBackupsHandle | null,
): void {
  handle = next;
}

export function getScheduledBackupsHandle(): ScheduledBackupsHandle | null {
  return handle;
}
