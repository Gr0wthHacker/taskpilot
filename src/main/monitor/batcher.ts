/**
 * Observation batcher.
 *
 * Event-driven (not timer-driven): tracks observations as they're captured
 * and emits a `flush()` callback when one of three conditions trips:
 *
 *   1. The unbatched count >= `batchSize` (default 8).
 *   2. The context-shift score between the new observation and the previous
 *      one exceeds `contextShiftThreshold` (default 0.4).
 *   3. `flushNow()` is called explicitly (manual deliberation hotkey, or the
 *      `/api/context/deliberate` route).
 *
 * Each tracked observation carries an `id` (assigned by the repository) and
 * just the few text fields the shift detector cares about. The batcher
 * itself is dependency-free: no DB, no electron, no fs — `flush` is supplied
 * by the caller (index.ts), which writes the deliberation_request io drop
 * and inserts the `deliberations` row.
 *
 * Reads its trigger values lazily on every `record()` call so the user can
 * change `ambient_batch_size` / `ambient_context_shift_threshold` from the
 * Settings UI and have it take effect on the very next observation without
 * restarting the monitor.
 */

import {
  contextShiftScore,
  type ContextShiftObservation,
} from './context-shift';

/** Trigger reason that ends up on the deliberation_request payload. */
export type BatcherTriggerReason = 'batch_size' | 'context_shift' | 'manual';

/**
 * One queued observation. Slimmed-down view of `ContextObservation` — we
 * keep only what the shift detector + the deliberation request need.
 */
export interface BatcherObservation extends ContextShiftObservation {
  id: string;
  captured_at: string;
}

export interface BatcherSettings {
  batchSize: number;
  contextShiftThreshold: number;
}

/**
 * Settings reader. Re-invoked on every `record()` so a UI toggle takes
 * effect within one observation, with no caching layer to invalidate.
 */
export type BatcherSettingsReader = () => BatcherSettings;

/**
 * Flush callback. Receives the queued observation IDs (already in capture
 * order) and the trigger reason that caused the flush. Returning a promise
 * is fine — the batcher does NOT await it; failures are caller-logged.
 */
export type BatcherFlush = (
  observationIds: string[],
  reason: BatcherTriggerReason,
) => void | Promise<void>;

export interface BatcherDeps {
  readSettings: BatcherSettingsReader;
  flush: BatcherFlush;
}

export interface Batcher {
  /** Add a freshly-captured observation. May trigger an immediate flush. */
  record: (obs: BatcherObservation) => void;
  /** Force a flush right now (e.g. from the deliberate hotkey). No-op when empty. */
  flushNow: (reason?: BatcherTriggerReason) => void;
  /** Number of observations currently queued (testing + telemetry). */
  size: () => number;
  /** Drop all queued state. Used when the monitor is disabled mid-batch. */
  reset: () => void;
}

/** Minimum acceptable batch size. Anything <1 is treated as "flush every record". */
const MIN_BATCH_SIZE = 1;
/** Defensive cap so a misconfigured setting can't grow the queue unbounded. */
const MAX_BATCH_SIZE = 500;

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_BATCH_SIZE;
  const rounded = Math.round(value);
  if (rounded < MIN_BATCH_SIZE) return MIN_BATCH_SIZE;
  if (rounded > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return rounded;
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Build a batcher. The returned handle is stateful — keep it for the
 * lifetime of `startMonitor()`'s session and drop it in `stopMonitor()`.
 */
export function createObservationBatcher(deps: BatcherDeps): Batcher {
  const queue: BatcherObservation[] = [];
  let last: BatcherObservation | null = null;

  const drain = (reason: BatcherTriggerReason): void => {
    if (queue.length === 0) return;
    const ids = queue.map((o) => o.id);
    queue.length = 0;
    // Fire-and-forget — the flush callback is responsible for its own error
    // reporting. We deliberately swallow rejections here so a single bad
    // flush doesn't poison the batcher state.
    try {
      const maybe = deps.flush(ids, reason);
      if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
        (maybe as Promise<void>).catch(() => {
          /* logged by deps.flush itself */
        });
      }
    } catch {
      /* see above */
    }
  };

  return {
    record: (obs: BatcherObservation): void => {
      const settings = deps.readSettings();
      const batchSize = clampBatchSize(settings.batchSize);
      const threshold = clampThreshold(settings.contextShiftThreshold);

      // Compute shift relative to the previous observation BEFORE pushing —
      // otherwise we'd be comparing the new one to itself.
      const shift = contextShiftScore(last, obs);
      queue.push(obs);
      last = obs;

      if (queue.length >= batchSize) {
        drain('batch_size');
        return;
      }
      // Only the second+ observation can trigger a shift flush — the first
      // observation has no prior context to compare against.
      if (queue.length > 1 && shift > threshold) {
        drain('context_shift');
      }
    },
    flushNow: (reason: BatcherTriggerReason = 'manual'): void => {
      drain(reason);
    },
    size: (): number => queue.length,
    reset: (): void => {
      queue.length = 0;
      last = null;
    },
  };
}
