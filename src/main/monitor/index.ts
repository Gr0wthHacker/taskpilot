/**
 * Proactive monitor — entry point.
 *
 * Background service that runs in the Electron main process and observes the
 * user's foreground context so Claude can deliberate ("interrupt or wait?")
 * without the user having to explicitly capture anything. The monitor owns
 * two timers and one event subscription:
 *
 *   - **Window-poll timer** — every `ambient_window_poll_interval_ms`
 *     (default 30s, clamped 10s-5min), probe the active window via
 *     {@link getActiveWindow}, persist a `context_observations` row tagged
 *     `source='window'`, and emit `observation_captured`.
 *   - **Screenshot timer** — every `ambient_screenshot_interval_ms` (default
 *     180s, clamped 60s-30min), capture every connected display via
 *     {@link captureScreenshots}, persist one row per display tagged
 *     `source='screenshot'` (all sharing the same `captured_at`),
 *     emit `observation_captured`. Gated separately by
 *     `ambient_screenshot_enabled` so the user can run the window poller
 *     without giving Electron a desktop-capture grant.
 *   - **Retention timer** — every hour, sweep observations older than
 *     `ambient_observation_retention_days` (default 14) from both the DB and
 *     the `~/.taskpilot/captures/` directory.
 *
 * The batcher (`createObservationBatcher`) is event-driven, not timed: it
 * subscribes to `observation_captured` and triggers a deliberation request
 * when the queue trips `ambient_batch_size` or the context-shift score
 * exceeds `ambient_context_shift_threshold`. The actual deliberation
 * orchestrator (in `src/main/deliberation/`) is injected through `deps.flush`
 * so this module doesn't need to import it directly — keeps the dep graph
 * simple and makes the batcher trivially mockable in tests.
 *
 * Expected wiring in main.ts (the wire phase will add this — DO NOT add it
 * here):
 *
 *   import { startMonitor } from '@/main/monitor';
 *   const monitor = startMonitor({
 *     flush: deliberationOrchestrator.requestDeliberation,
 *   });
 *   app.on('will-quit', () => monitor.stop());
 *
 * Settings are re-read on every tick (no caching) so a Settings toggle
 * propagates within one interval. The monitor never throws — every capture
 * path is wrapped in try/catch and logged with the `[monitor]` prefix.
 *
 * Defaults follow the privacy-first policy: `ambient_monitor_enabled` and
 * `ambient_screenshot_enabled` are both OFF until the user explicitly opts
 * in via Settings.
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import { contextObservationsRepository } from '@/main/db/repositories/context-observations';
import { ioEvents } from '@/main/io/events';
import type { ContextObservation } from '@/shared/types';

import { getActiveWindow } from './active-window';
import {
  REDACTION_PLACEHOLDER,
  __resetSensitivePatternCacheForTests as resetSensitivePatternCacheImpl,
  matchesSensitivePattern as matchesSensitivePatternImpl,
} from './sensitive-pattern';
import {
  createObservationBatcher,
  type Batcher,
  type BatcherFlush,
  type BatcherObservation,
  type BatcherSettings,
  type BatcherTriggerReason,
} from './batcher';
import { captureScreenshots, MAX_DISPLAYS } from './screenshot';
import { runRetentionSweep } from './retention';

/* -------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_WINDOW_POLL_MS = 30_000;
const DEFAULT_SCREENSHOT_MS = 180_000;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_SHIFT_THRESHOLD = 0.4;
const DEFAULT_RETENTION_DAYS = 14;

const MIN_WINDOW_POLL_MS = 10_000;
const MAX_WINDOW_POLL_MS = 5 * 60 * 1_000;
const MIN_SCREENSHOT_MS = 60_000;
const MAX_SCREENSHOT_MS = 30 * 60 * 1_000;

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

const SETTINGS_RECHECK_INTERVAL_MS = 30_000;

/**
 * Setting keys consumed by this module. Mirror the seeded keys in
 * `src/main/io/context-refresh.ts#DEFAULT_PREFERENCES` — update both
 * together if you rename one.
 */
const KEY_MONITOR_ENABLED = 'ambient_monitor_enabled';
const KEY_SCREENSHOT_ENABLED = 'ambient_screenshot_enabled';
const KEY_WINDOW_POLL_MS = 'ambient_window_poll_interval_ms';
const KEY_SCREENSHOT_MS = 'ambient_screenshot_interval_ms';
const KEY_BATCH_SIZE = 'ambient_batch_size';
const KEY_SHIFT_THRESHOLD = 'ambient_context_shift_threshold';
const KEY_RETENTION_DAYS = 'ambient_observation_retention_days';
/**
 * Panic-mode flag. When true, both window and screenshot ticks short-circuit
 * before they hit the collector or DB. The monitor stays warm (timers keep
 * cycling) so flipping the toggle back resumes capture without a restart.
 * Also drives the Watch view's censored render. Settable via the global
 * hotkey, tray menu, or `POST /api/settings/ambient_panic_mode`.
 */
export const KEY_PANIC_MODE = 'ambient_panic_mode';

/**
 * Module-local edge tracker for the panic-mode gate. Avoids logging the
 * "panic mode active — skipping tick" line every tick while panic is on;
 * we only emit on the off → on transition (and a matching "lifted" line
 * on the on → off transition). Reset to `null` so the first observation
 * after monitor restart still produces a clean log.
 */
let lastPanicStateLogged: boolean | null = null;

function logPanicTransitionIfChanged(active: boolean): void {
  if (lastPanicStateLogged === active) return;
  lastPanicStateLogged = active;
  if (active) {
    logInfo('panic mode active — skipping tick');
  } else {
    logInfo('panic mode lifted — capture resumed');
  }
}

/**
 * Test-only hook: reset the panic-transition tracker so the next gated tick
 * logs the transition line again. Pair with mocked settings.
 *
 * @internal
 */
export function __resetPanicTransitionForTests(): void {
  lastPanicStateLogged = null;
}

function readBoolSetting(key: string): boolean {
  const raw = settingsRepository.get<unknown>(key);
  if (raw === true) return true;
  if (raw === false || raw === null || raw === undefined) return false;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

function readNumberSetting(key: string, fallback: number): number {
  const raw = settingsRepository.get<unknown>(key);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/* -------------------------------------------------------------------------- */
/*  Logger                                                                    */
/* -------------------------------------------------------------------------- */

const PREFIX = '[monitor]';

function logInfo(message: string, ...args: unknown[]): void {
  console.log(PREFIX, message, ...args);
}

function logWarn(message: string, ...args: unknown[]): void {
  console.warn(PREFIX, message, ...args);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export interface MonitorDeps {
  /**
   * Flush callback. Receives observation IDs to deliberate and the trigger
   * reason. In production this is wired to `deliberationOrchestrator.
   * requestDeliberation()`; tests can pass a spy.
   */
  flush: BatcherFlush;
}

export interface MonitorHandle {
  /** Tear down every timer and event subscription. Idempotent. */
  stop: () => void;
  /** Force a flush of the current batch (manual deliberation hotkey). */
  flushNow: (reason?: BatcherTriggerReason) => void;
  /**
   * Trigger one immediate retention sweep and return the result. Mainly for
   * tests + an admin endpoint; the regular hourly timer handles steady state.
   */
  runRetentionNow: () => Promise<void>;
  /**
   * Acquire the monitor mutex, run `fn`, then release. Blocks any in-flight
   * tickWindow/tickScreenshot from racing with a destructive operation
   * (currently the panic wipe). Idempotent under sequential calls.
   */
  withLock: <T>(fn: () => Promise<T> | T) => Promise<T>;
  /**
   * Reset the "enable-time" tracker — the bookkeeping the monitor uses to
   * decide what counts as a fresh enable. Called from the panic wipe so
   * the next observation isn't grouped with the wiped ones.
   */
  resetEnableTime: () => void;
}

/**
 * Start the proactive monitor. Always returns a {@link MonitorHandle}; when
 * `ambient_monitor_enabled` is false at boot, the handle is "dormant" — all
 * timers no-op and only a settings poller keeps watch so the user can flip
 * the toggle without restarting the app.
 */
export function startMonitor(deps: MonitorDeps): MonitorHandle {
  const batcher = createObservationBatcher({
    readSettings: readBatcherSettings,
    flush: deps.flush,
  });

  const onObservationCaptured = (obs: ContextObservation): void => {
    // Only batch the rows produced by the local monitor. Browser-extension
    // captures already get batched by their own logic on the extension side.
    if (obs.source !== 'window' && obs.source !== 'screenshot') return;
    batcher.record(toBatcherObservation(obs));
  };
  ioEvents.on('observation_captured', onObservationCaptured);

  const state: TickerState = {
    windowTimer: null,
    screenshotTimer: null,
    retentionTimer: null,
    settingsTimer: null,
    enabled: false,
    stopped: false,
    enabledAt: null,
    lockChain: Promise.resolve(),
  };

  applyEnabledState(state, batcher);
  state.settingsTimer = setInterval(() => {
    if (state.stopped) return;
    applyEnabledState(state, batcher);
  }, SETTINGS_RECHECK_INTERVAL_MS);

  const withLock = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = state.lockChain.then(async () => fn());
    // Swallow rejections on the chain itself so a single failure doesn't
    // poison every subsequent acquirer. Callers still see their own reject.
    state.lockChain = next.catch(() => undefined);
    return next;
  };

  return {
    stop: (): void => {
      if (state.stopped) return;
      state.stopped = true;
      clearAllTimers(state);
      ioEvents.off('observation_captured', onObservationCaptured);
      batcher.reset();
      logInfo('stopped');
    },
    flushNow: (reason: BatcherTriggerReason = 'manual'): void => {
      batcher.flushNow(reason);
    },
    runRetentionNow: async (): Promise<void> => {
      await safeRetentionSweep();
    },
    withLock,
    resetEnableTime: (): void => {
      // The next observation is treated as a fresh start — useful after a
      // destructive panic wipe so historical buckets don't pollute the
      // batcher's context-shift baseline.
      state.enabledAt = state.enabled ? Date.now() : null;
      batcher.reset();
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

interface TickerState {
  windowTimer: NodeJS.Timeout | null;
  screenshotTimer: NodeJS.Timeout | null;
  retentionTimer: NodeJS.Timeout | null;
  settingsTimer: NodeJS.Timeout | null;
  enabled: boolean;
  stopped: boolean;
  /**
   * Epoch ms when the monitor most recently flipped from disabled → enabled.
   * `null` while the monitor is off. The panic wipe stamps this back to
   * Date.now() so the next observation isn't bucketed with anything that was
   * just censored.
   */
  enabledAt: number | null;
  /**
   * Single-slot mutex used by `withLock()`. Every acquirer chains onto the
   * previous promise so a destructive operation (panic wipe) sees a quiescent
   * state before it runs.
   */
  lockChain: Promise<unknown>;
}

function clearAllTimers(state: TickerState): void {
  if (state.windowTimer) clearTimeout(state.windowTimer);
  if (state.screenshotTimer) clearTimeout(state.screenshotTimer);
  if (state.retentionTimer) clearInterval(state.retentionTimer);
  if (state.settingsTimer) clearInterval(state.settingsTimer);
  state.windowTimer = null;
  state.screenshotTimer = null;
  state.retentionTimer = null;
  state.settingsTimer = null;
}

/**
 * Check the master enable flag and (re)wire the active timers to match.
 * Idempotent — safe to call from the settings re-check timer every 30s.
 */
function applyEnabledState(state: TickerState, batcher: Batcher): void {
  if (state.stopped) return;
  const enabled = readBoolSetting(KEY_MONITOR_ENABLED);
  if (enabled === state.enabled) return;
  state.enabled = enabled;
  if (!enabled) {
    if (state.windowTimer) clearTimeout(state.windowTimer);
    if (state.screenshotTimer) clearTimeout(state.screenshotTimer);
    if (state.retentionTimer) clearInterval(state.retentionTimer);
    state.windowTimer = null;
    state.screenshotTimer = null;
    state.retentionTimer = null;
    state.enabledAt = null;
    batcher.reset();
    logInfo('disabled — timers cleared');
    return;
  }
  state.enabledAt = Date.now();
  startWindowTimer(state);
  startScreenshotTimer(state);
  startRetentionTimer(state);
  logInfo('enabled — timers started');
}

/**
 * Schedule the next window-poll tick. Uses `setTimeout` recursion (not
 * `setInterval`) so the interval setting is re-read on every tick and a
 * mid-session change takes effect within one cycle.
 */
function startWindowTimer(state: TickerState): void {
  if (state.windowTimer) clearTimeout(state.windowTimer);
  const intervalMs = clamp(
    readNumberSetting(KEY_WINDOW_POLL_MS, DEFAULT_WINDOW_POLL_MS),
    MIN_WINDOW_POLL_MS,
    MAX_WINDOW_POLL_MS,
  );
  state.windowTimer = setTimeout(() => {
    if (state.stopped || !state.enabled) return;
    // Tick runs on the monitor mutex so a destructive panic-wipe can't
    // rename the captures dir mid-flight. The mutex is a single promise
    // chain (`state.lockChain`); every acquirer chains onto the previous.
    const guarded = state.lockChain
      .then(() => tickWindow())
      .catch((err: unknown) => {
        logWarn('window tick chain failed:', (err as Error).message);
      });
    state.lockChain = guarded;
    void guarded.finally(() => {
      if (!state.stopped && state.enabled) startWindowTimer(state);
    });
  }, intervalMs);
}

/** Same self-rescheduling pattern as {@link startWindowTimer}. */
function startScreenshotTimer(state: TickerState): void {
  if (state.screenshotTimer) clearTimeout(state.screenshotTimer);
  const intervalMs = clamp(
    readNumberSetting(KEY_SCREENSHOT_MS, DEFAULT_SCREENSHOT_MS),
    MIN_SCREENSHOT_MS,
    MAX_SCREENSHOT_MS,
  );
  state.screenshotTimer = setTimeout(() => {
    if (state.stopped || !state.enabled) return;
    const guarded = state.lockChain
      .then(() => tickScreenshot())
      .catch((err: unknown) => {
        logWarn('screenshot tick chain failed:', (err as Error).message);
      });
    state.lockChain = guarded;
    void guarded.finally(() => {
      if (!state.stopped && state.enabled) startScreenshotTimer(state);
    });
  }, intervalMs);
}

/** Retention runs hourly — fixed cadence, no per-tick setting to re-read. */
function startRetentionTimer(state: TickerState): void {
  if (state.retentionTimer) clearInterval(state.retentionTimer);
  state.retentionTimer = setInterval(() => {
    void safeRetentionSweep();
  }, RETENTION_SWEEP_INTERVAL_MS);
}

/**
 * One active-window probe tick. Persists a row, emits the bus event. Never
 * throws — failure modes (lock screen, PowerShell hung) return `null` from
 * the collector and we skip the tick.
 */
async function tickWindow(): Promise<void> {
  try {
    if (!readBoolSetting(KEY_MONITOR_ENABLED)) return;
    // Panic mode short-circuits the same place ambient_monitor_enabled is
    // checked. Timers keep ticking so the user can flip out of panic without
    // restarting the monitor — but nothing reaches the collector or DB.
    const panic = readBoolSetting(KEY_PANIC_MODE);
    logPanicTransitionIfChanged(panic);
    if (panic) return;
    const probe = await getActiveWindow();
    if (probe === null) return;

    // Privacy filter — `window_title` (and to a lesser extent `app_name`)
    // can leak credentials, banking surfaces, OAuth `state`/`code`
    // values, etc. Run the same regex the screenshot tick uses; on
    // match we still PERSIST the row (the batcher's context-shift
    // counter needs it, and the Watch view shows a "redacted" badge
    // so the user can see what just got masked) but replace the title
    // with a placeholder and tag metadata so the renderer can render
    // the badge. `app_name` is left intact because it's a process
    // name (low PII) and the matcher already factored it in when
    // deciding to redact.
    const sensitive = matchesSensitivePatternImpl({
      title: probe.window_title,
      app_name: probe.app_name,
    });
    const safeWindowTitle = sensitive
      ? REDACTION_PLACEHOLDER
      : probe.window_title;
    const baseMetadata: Record<string, unknown> = {};
    if (probe.process_path) baseMetadata.process_path = probe.process_path;
    if (sensitive) baseMetadata.sensitive_pattern_match = true;
    const metadata =
      Object.keys(baseMetadata).length > 0 ? baseMetadata : null;

    const row = contextObservationsRepository.create({
      source: 'window',
      app_name: probe.app_name,
      window_title: safeWindowTitle,
      metadata,
    });
    ioEvents.emit('observation_captured', row);
  } catch (err) {
    logWarn('window tick failed:', (err as Error).message);
  }
}

/**
 * One screenshot tick. Honors the secondary `ambient_screenshot_enabled`
 * flag so a user can run the window poller without granting desktopCapturer.
 */
async function tickScreenshot(): Promise<void> {
  try {
    if (!readBoolSetting(KEY_MONITOR_ENABLED)) return;
    if (!readBoolSetting(KEY_SCREENSHOT_ENABLED)) return;
    // Panic mode gate (mirrors tickWindow). Read AFTER the screenshot flag
    // so flipping just panic_mode → off and screenshot_enabled stays the
    // single gate it was before. Edge logger lives in tickWindow so we
    // don't double-log when both timers fire in the same panic state —
    // only one of the two helpers needs to call logPanicTransitionIfChanged.
    if (readBoolSetting(KEY_PANIC_MODE)) return;
    const outcome = await captureScreenshots();
    if (outcome.skipped_count > 0) {
      logWarn(
        `screenshot tick: ${outcome.total_displays} displays reported, capturing first ${MAX_DISPLAYS}; skipped ${outcome.skipped_count}`,
      );
    }
    if (outcome.results.length === 0) return;

    // All captures in a single tick share the same captured_at so consumers
    // can group them as a single observation set.
    const sharedCapturedAt = outcome.results[0]!.captured_at;
    for (let i = 0; i < outcome.results.length; i++) {
      const shot = outcome.results[i]!;
      const row = contextObservationsRepository.create({
        source: 'screenshot',
        captured_at: sharedCapturedAt,
        screenshot_path: shot.path,
        metadata: {
          size_bytes: shot.size_bytes,
          display_index: i,
          display_id: shot.display_id,
          display_label: shot.display_label,
        },
      });
      logInfo(
        `screenshot captured (display ${i + 1}/${outcome.results.length})`,
        shot.path,
      );
      ioEvents.emit('observation_captured', row);
    }
  } catch (err) {
    logWarn('screenshot tick failed:', (err as Error).message);
  }
}

async function safeRetentionSweep(): Promise<void> {
  try {
    const days = clamp(
      readNumberSetting(KEY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
      1,
      365,
    );
    const result = await runRetentionSweep(days);
    if (result.rows_deleted > 0 || result.files_deleted > 0 || result.orphans_deleted > 0) {
      logInfo(
        `retention swept ${result.rows_deleted} rows, ${result.files_deleted} files, ${result.orphans_deleted} orphans`,
      );
    }
  } catch (err) {
    logWarn('retention sweep failed:', (err as Error).message);
  }
}

function readBatcherSettings(): BatcherSettings {
  return {
    batchSize: readNumberSetting(KEY_BATCH_SIZE, DEFAULT_BATCH_SIZE),
    contextShiftThreshold: readNumberSetting(
      KEY_SHIFT_THRESHOLD,
      DEFAULT_SHIFT_THRESHOLD,
    ),
  };
}

function toBatcherObservation(obs: ContextObservation): BatcherObservation {
  return {
    id: obs.id,
    captured_at: obs.captured_at,
    app_name: obs.app_name,
    window_title: obs.window_title,
    url: obs.url,
    page_title: obs.page_title,
  };
}

/* -------------------------------------------------------------------------- */
/*  Sensitive-content matcher (extracted to ./sensitive-pattern)              */
/* -------------------------------------------------------------------------- */

/**
 * Re-exports of the extracted sensitive-content matcher + test hook. The
 * implementation now lives in `./sensitive-pattern` so the same logic can
 * be reused by the server's `/capture` routes (browser-extension intake)
 * without dragging the rest of the monitor module along. These re-exports
 * preserve every existing import path (`@/main/monitor/index`) used by
 * the legacy `tests/main/monitor/sensitive-pattern.test.ts` and any
 * external consumer that pinned to it.
 *
 * The matcher accepts BOTH the object form preferred by new call sites
 * (`{ title, app_name, url, ... }`) and the legacy positional form
 * (`appName, windowTitle`) — overload defined in `./sensitive-pattern`.
 */
export const matchesSensitivePattern = matchesSensitivePatternImpl;
export const __resetSensitivePatternCacheForTests =
  resetSensitivePatternCacheImpl;

/**
 * Test-only entry points for the tick functions. Production code never
 * reaches these directly — the timers wire through {@link startWindowTimer} /
 * {@link startScreenshotTimer}. Exposed so unit tests can drive a single tick
 * deterministically (instead of waiting on `setTimeout`) and assert the
 * panic gate without booting Electron.
 *
 * @internal
 */
export const __tickWindowForTests = tickWindow;
export const __tickScreenshotForTests = tickScreenshot;

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

export type { BatcherFlush, BatcherTriggerReason } from './batcher';
