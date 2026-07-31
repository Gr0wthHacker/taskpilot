/**
 * Auto-execute pipeline.
 *
 * When the user opts in via Settings (`auto_execute_enabled` /
 * `auto_execute_approved`), this module queues any task that becomes
 * `status='queued'` AND `agent_executable=true` AND `agent_method` ∈
 * (`cli`, `either`) for execution by writing an execution request file to
 * `IO_EXECUTE/`. Tasks whose method is `cowork` are skipped — Cowork-driven
 * work requires a human at the screen (PRD §11).
 *
 * The "agent paused" kill switch (`agent_paused` / `pause_all_agents`) short
 * circuits every tick so a single toggle freezes the entire pipeline.
 *
 * Listens to `ioEvents.pipeline_changed` and `derived_ingested` so it runs
 * just after every state transition. A small debounce keeps it from
 * thrashing when many events arrive at once.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { listTasks, updateTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import { ioEvents } from '@/main/io/events';
import { executePath, outputDir } from '@/main/io/paths';
import { writeExecuteRequest } from '@/main/io/protocol';
import type { Task } from '@/shared/types';

const TICK_DEBOUNCE_MS = 250;

/**
 * Setting keys we consult. The Settings UI currently writes
 * `auto_execute_approved` and `pause_all_agents`; the spec for this module
 * names them `auto_execute_enabled` and `agent_paused`. We honor either.
 */
const AUTO_EXECUTE_KEYS = ['auto_execute_enabled', 'auto_execute_approved'] as const;
const PAUSE_KEYS = ['agent_paused', 'pause_all_agents'] as const;

/**
 * Coerce a setting value to boolean. Settings are JSON-serialized, but the UI
 * has historically written `'true'`/`'false'` strings, so we accept both.
 */
function readBoolSetting(keys: ReadonlyArray<string>): boolean {
  for (const key of keys) {
    const raw = settingsRepository.get<unknown>(key);
    if (raw === true) return true;
    if (typeof raw === 'string') {
      if (raw === 'true' || raw === '1') return true;
    }
    if (typeof raw === 'number' && raw === 1) return true;
  }
  return false;
}

/** Whether auto-execute is enabled in settings. */
export function isAutoExecuteEnabled(): boolean {
  return readBoolSetting(AUTO_EXECUTE_KEYS);
}

/** Whether agent work is paused via settings. */
export function isAgentPaused(): boolean {
  return readBoolSetting(PAUSE_KEYS);
}

/**
 * Returns true if `task` is eligible for auto-execute. CLI/either methods
 * are fine, cowork tasks are not (they need a human at the screen). Tasks
 * already in flight (`agent_status` is `assigned`/`running`/terminal) are
 * skipped so we don't double-write the same request.
 */
export function isAutoExecuteEligible(task: Task): boolean {
  if (!task.agent_executable) return false;
  if (task.status !== 'queued') return false;
  if (task.agent_method !== 'cli' && task.agent_method !== 'either') {
    return false;
  }
  // Don't re-queue something already in flight.
  if (
    task.agent_status === 'assigned' ||
    task.agent_status === 'running' ||
    task.agent_status === 'succeeded'
  ) {
    return false;
  }
  return true;
}

/**
 * True when an execute request file already exists on disk for this task —
 * we treat this as a "claim" so concurrent ticks don't double-write.
 */
async function executeRequestExists(taskId: string): Promise<boolean> {
  try {
    await fs.access(executePath(taskId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve parent output files for `task` the same way the HTTP route does.
 * Kept in-module so we don't have to widen the routes/tasks helper exports.
 */
async function resolveParentOutputs(
  task: Task,
): Promise<Record<string, string[]>> {
  const parentIds = new Set<string>();
  if (task.parent_id) parentIds.add(task.parent_id);
  if (task.context && typeof task.context === 'object') {
    const dependsOn = (task.context as Record<string, unknown>)['depends_on'];
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep === 'string' && dep.length > 0) parentIds.add(dep);
      }
    }
  }

  const out: Record<string, string[]> = {};
  for (const parentId of parentIds) {
    const dir = outputDir(parentId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      out[parentId] = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      out[parentId] = [];
    }
  }
  return out;
}

/**
 * Single pass over the DB: queue every eligible task. Idempotent — tasks
 * whose request file already exists are skipped, and `agent_status` is
 * flipped to `assigned` after writing so the next tick won't reconsider.
 */
export async function runAutoExecuteTick(): Promise<{
  queued: number;
  skipped: number;
}> {
  if (!isAutoExecuteEnabled() || isAgentPaused()) {
    return { queued: 0, skipped: 0 };
  }

  // Pull a bounded list — the queue should never be massive, but cap to keep
  // any pathological state from blocking the tick.
  const candidates = listTasks({ status: 'queued', limit: 200 }).filter(
    isAutoExecuteEligible,
  );

  let queued = 0;
  let skipped = 0;

  for (const task of candidates) {
    if (await executeRequestExists(task.id)) {
      skipped += 1;
      continue;
    }
    try {
      const parentOutputs = await resolveParentOutputs(task);
      await writeExecuteRequest(
        task,
        parentOutputs,
        { tags: task.tags, auto_executed: true },
        task.agent_instructions ?? undefined,
      );
      updateTask(task.id, { agent_status: 'assigned' });
      queued += 1;
    } catch {
      // Best-effort. If a write fails the next tick can retry.
      skipped += 1;
    }
  }

  if (queued > 0) {
    ioEvents.emit('pipeline_changed', { reason: 'auto_execute_tick' });
  }

  return { queued, skipped };
}

/**
 * Handle for the running auto-execute loop. `stop()` removes its
 * subscriptions and cancels any pending debounced tick.
 */
export interface AutoExecuteHandle {
  stop: () => void;
}

/**
 * Start the auto-execute loop. The loop hooks `ioEvents.pipeline_changed`
 * and `ioEvents.derived_ingested` with a small debounce so a burst of
 * events only triggers a single scan.
 *
 * Calling twice produces two independent handles — callers should only call
 * once at boot. Each handle owns its own debounce timer and listeners.
 */
export function startAutoExecute(): AutoExecuteHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleTick = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runAutoExecuteTick().catch(() => {
        /* swallow — auto-execute must never crash the host */
      });
    }, TICK_DEBOUNCE_MS);
  };

  const onPipeline = (): void => {
    scheduleTick();
  };
  const onDerived = (): void => {
    scheduleTick();
  };

  ioEvents.on('pipeline_changed', onPipeline);
  ioEvents.on('derived_ingested', onDerived);

  // Run an initial tick so any tasks that were already eligible at boot get
  // picked up without waiting for the next event.
  scheduleTick();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      ioEvents.off('pipeline_changed', onPipeline);
      ioEvents.off('derived_ingested', onDerived);
    },
  };
}
