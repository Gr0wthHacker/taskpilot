/**
 * Module-singleton holder for the proactive-monitor handle.
 *
 * The Electron main process owns the monitor's lifetime — it calls
 * `startMonitor()` after the API server boots and stashes the resulting
 * {@link MonitorHandle} here so route handlers (notably the panic-wipe
 * endpoint) can grab `withLock()` / `resetEnableTime()` without re-importing
 * the monitor module or threading the handle through every layer.
 *
 * Mirrors the pattern used by `backups/scheduler.ts`. Tests that don't boot
 * the real monitor can install a stub via `setMonitorHandle()` and assert
 * the route's behavior without spinning up the Electron-only collectors.
 */

import type { MonitorHandle } from './index';

let handle: MonitorHandle | null = null;

export function setMonitorHandle(next: MonitorHandle | null): void {
  handle = next;
}

export function getMonitorHandle(): MonitorHandle | null {
  return handle;
}
