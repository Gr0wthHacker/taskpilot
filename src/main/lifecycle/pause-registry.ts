/**
 * Subsystem pause registry.
 *
 * Coordination point for "stop writing to the DB / filesystem now" requests.
 * Used by the restore handler (and any future operation that needs an atomic
 * point-in-time snapshot of the data layer): subsystems register a pause
 * callback at boot, and the restore code calls `pauseAll()` before swapping
 * files + `resumeAll()` after.
 *
 * Each callback is best-effort. A subsystem that fails to pause shouldn't
 * block the others — the registry catches and logs but always continues.
 *
 * Pause callbacks should be IDEMPOTENT — pausing an already-paused subsystem
 * is a no-op. Resume callbacks should be tolerant of being called without a
 * prior pause (no-op). The registry handles the lifecycle; subsystems just
 * provide their own toggle.
 *
 * Pattern: each subsystem registers in its boot path with
 *   const handle = registerPausable({
 *     name: 'watcher',
 *     pause: () => watcher.stop(),
 *     resume: () => watcher.start(),
 *   });
 * and unregisters on shutdown via `handle.unregister()`.
 */

const warn = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.warn(`[lifecycle:pause] ${msg}`, ...rest);

export interface Pausable {
  /** Human-readable name for logging — e.g. 'watcher', 'monitor', 'auto-execute'. */
  name: string;
  /** Stop work. May return a promise. */
  pause: () => void | Promise<void>;
  /** Resume work. May return a promise. */
  resume: () => void | Promise<void>;
}

export interface PausableHandle {
  unregister: () => void;
}

interface Entry extends Pausable {
  id: number;
}

const entries: Entry[] = [];
let nextId = 1;

export function registerPausable(p: Pausable): PausableHandle {
  const id = nextId++;
  entries.push({ ...p, id });
  return {
    unregister: () => {
      const idx = entries.findIndex((e) => e.id === id);
      if (idx >= 0) entries.splice(idx, 1);
    },
  };
}

/**
 * Pause every registered subsystem. Each pause is awaited; a failing pause
 * is logged but doesn't block the rest. Returns the list of subsystems that
 * successfully paused — useful so the caller can resume only those.
 */
export async function pauseAll(): Promise<string[]> {
  const paused: string[] = [];
  for (const entry of entries) {
    try {
      await entry.pause();
      paused.push(entry.name);
    } catch (err) {
      warn(`pause ${entry.name} failed`, err);
    }
  }
  return paused;
}

/**
 * Resume every registered subsystem. Always runs every resume (even if the
 * matching pause failed) so a partial pause failure doesn't leave anything
 * stuck. Failures are logged but never thrown.
 */
export async function resumeAll(): Promise<void> {
  for (const entry of entries) {
    try {
      await entry.resume();
    } catch (err) {
      warn(`resume ${entry.name} failed`, err);
    }
  }
}

/**
 * Test helper — clear all registrations so the next test starts clean.
 */
export function _resetPauseRegistryForTest(): void {
  entries.length = 0;
}

export function _listPausablesForTest(): readonly string[] {
  return entries.map((e) => e.name);
}
