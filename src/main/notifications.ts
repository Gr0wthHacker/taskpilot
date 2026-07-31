/**
 * System notifications.
 *
 * Subscribes to the process-wide `ioEvents` bus and surfaces high-signal
 * lifecycle events as OS-native toasts via Electron's `Notification` class.
 *
 * Three event sources currently fire notifications:
 *   - `review_added`        → "N task(s) ready for review" → focus + /review
 *   - `result_ingested`     → "Agent finished {task title}" → focus + /task/:id
 *                             (only when `agent_executable === true` and
 *                              `status === 'succeeded'`)
 *   - `io_error` (watcher)  → "TaskPilot I/O issue" — debounced max 1/min
 *
 * Every notification respects the master `notifications_enabled` setting and
 * a per-channel sub-setting (`notifications_review_added`,
 * `notifications_result_complete`, `notifications_errors`). All default to
 * `true` so the user starts with notifications on.
 *
 * Click handling: passes the configured callback to Electron's
 * `Notification` constructor. Most callers pass a function that shows + focuses
 * the main window then sends a tray-style navigate command to the renderer.
 *
 * Boot order: `startNotifications()` is called from `main.ts` inside
 * `app.whenReady()`, after the window has been created so the click handler
 * can resolve a live `BrowserWindow`.
 */

import { Notification, type BrowserWindow } from 'electron';

import { createBatcher } from './notification-batcher';
import { settingsRepository } from './db/repositories/settings';
import { ioEvents } from './io/events';
import { sendTrayCommand } from './ipc';
import { tasksRepository } from './db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Setting keys                                                              */
/* -------------------------------------------------------------------------- */

const SETTING_MASTER = 'notifications_enabled';
const SETTING_REVIEW = 'notifications_review_added';
const SETTING_RESULT = 'notifications_result_complete';
const SETTING_ERRORS = 'notifications_errors';

/**
 * Default coalescing window. When several agent results land (or several
 * tasks enter review) in a short burst — common during a derive→execute
 * fan-out — we collect them and fire ONE summary toast instead of a flurry.
 */
const BATCH_WINDOW_MS = 5_000;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function safeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    return safeBool(settingsRepository.get(key), fallback);
  } catch {
    return fallback;
  }
}

function masterEnabled(): boolean {
  return readBool(SETTING_MASTER, true);
}

function channelEnabled(key: string): boolean {
  return masterEnabled() && readBool(key, true);
}

/* -------------------------------------------------------------------------- */
/*  Public notify() — direct entry for callers that already know the copy    */
/* -------------------------------------------------------------------------- */

export interface NotifyOptions {
  title: string;
  body: string;
  /** Fired when the user clicks the toast. */
  onClick?: () => void;
  /** Override the master enable check (used only by error reporting). */
  force?: boolean;
}

/**
 * Show an OS notification. No-op when the platform doesn't support
 * notifications or when the master setting is disabled (unless `force`).
 */
export function notify(options: NotifyOptions): void {
  if (!options.force && !masterEnabled()) return;
  try {
    if (!Notification.isSupported()) return;
  } catch {
    return;
  }
  try {
    const n = new Notification({ title: options.title, body: options.body });
    if (options.onClick) {
      n.on('click', options.onClick);
    }
    n.show();
  } catch {
    // Surface to console but never propagate — notification failures must
    // never take down the caller.
    // eslint-disable-next-line no-console
    console.warn('[notifications] failed to show toast', options.title);
  }
}

/* -------------------------------------------------------------------------- */
/*  startNotifications() — wires ioEvents → notify()                          */
/* -------------------------------------------------------------------------- */

export interface StartNotificationsOptions {
  /** Resolves to the live BrowserWindow used for click → focus + navigate. */
  getMainWindow: () => BrowserWindow | null;
  /** Override the coalescing window (ms). Defaults to {@link BATCH_WINDOW_MS}. */
  batchWindowMs?: number;
}

export interface NotificationsHandle {
  /** Detach all listeners. Idempotent. */
  stop: () => void;
}

/**
 * Bring the active main window forward without stealing the user's focus
 * unnecessarily. Restores from minimized state and calls `.focus()`.
 */
function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Subscribe to ioEvents and translate signal events into notifications.
 * Returns a handle that detaches the listeners. Safe to call multiple times
 * — each call returns a fresh handle and the listeners stack, so callers
 * should `.stop()` the previous handle before re-attaching.
 */
export function startNotifications(
  options: StartNotificationsOptions,
): NotificationsHandle {
  const { getMainWindow } = options;
  const windowMs = options.batchWindowMs ?? BATCH_WINDOW_MS;

  /* ------------------------------ review_added ------------------------------ */

  // Coalesce review additions across rapid fires into one summary toast.
  const reviewBatcher = createBatcher<{ taskId: string }>(
    windowMs,
    (items) => {
      const count = items.length;
      if (count === 0) return;
      const title =
        count === 1 ? 'Task ready for review' : `${count} tasks ready for review`;
      const body =
        count === 1
          ? 'Open the Review queue to approve, reject, or revise.'
          : 'Open the Review queue to triage them.';
      notify({
        title,
        body,
        onClick: () => {
          focusWindow(getMainWindow());
          sendTrayCommand(getMainWindow, { kind: 'navigate', path: '/review' });
        },
      });
    },
  );

  const onReviewAdded = (
    items: Array<{ taskId: string; reason: string }>,
  ): void => {
    if (!channelEnabled(SETTING_REVIEW)) return;
    for (const item of items) reviewBatcher.push({ taskId: item.taskId });
  };

  /* ---------------------------- result_ingested ---------------------------- */

  // Coalesce agent completions: one toast per task is noisy during a fan-out.
  const resultBatcher = createBatcher<{ taskId: string; title: string }>(
    windowMs,
    (items) => {
      if (items.length === 0) return;
      if (items.length === 1) {
        const only = items[0]!;
        notify({
          title: `Agent finished: ${only.title}`,
          body: 'Click to review the result.',
          onClick: () => {
            focusWindow(getMainWindow());
            sendTrayCommand(getMainWindow, {
              kind: 'navigate',
              path: `/task/${only.taskId}`,
            });
          },
        });
        return;
      }
      notify({
        title: `${items.length} agent tasks finished`,
        body: 'Open Mission Control to see what completed.',
        onClick: () => {
          focusWindow(getMainWindow());
          sendTrayCommand(getMainWindow, { kind: 'navigate', path: '/agents' });
        },
      });
    },
  );

  const onResultIngested = (payload: {
    taskId: string;
    result: { status?: string };
  }): void => {
    if (!channelEnabled(SETTING_RESULT)) return;
    const status = payload.result?.status;
    if (status !== 'succeeded') return;

    let title = 'a task';
    try {
      const task = tasksRepository.findById(payload.taskId);
      if (task) {
        // Only agent-executable completions are notification-worthy.
        if (!task.agent_executable) return;
        title = task.title;
      }
    } catch {
      // Fall back to generic copy.
    }

    resultBatcher.push({ taskId: payload.taskId, title });
  };

  /* -------------------------------- io_error ------------------------------- */

  // Errors can fan out (one bad file triggers a watcher loop). Cap to 1/min
  // so the user isn't carpet-bombed by toasts when the watcher misbehaves.
  let lastErrorAt = 0;
  const ERROR_DEBOUNCE_MS = 60_000;

  const onIoError = (payload: { scope: string; message: string }): void => {
    if (!channelEnabled(SETTING_ERRORS)) return;
    if (payload.scope !== 'watcher') return;
    const now = Date.now();
    if (now - lastErrorAt < ERROR_DEBOUNCE_MS) return;
    lastErrorAt = now;
    notify({
      title: 'TaskPilot I/O issue',
      body: payload.message || 'The file watcher reported an error.',
      onClick: () => {
        const win = getMainWindow();
        focusWindow(win);
        sendTrayCommand(getMainWindow, { kind: 'navigate', path: '/io' });
      },
    });
  };

  ioEvents.on('review_added', onReviewAdded);
  ioEvents.on('result_ingested', onResultIngested);
  ioEvents.on('io_error', onIoError);

  const stop = (): void => {
    ioEvents.off('review_added', onReviewAdded);
    ioEvents.off('result_ingested', onResultIngested);
    ioEvents.off('io_error', onIoError);
    reviewBatcher.cancel();
    resultBatcher.cancel();
  };

  return { stop };
}

/** Exposed for tests. */
export const __notifications_internals = {
  SETTING_MASTER,
  SETTING_REVIEW,
  SETTING_RESULT,
  SETTING_ERRORS,
  BATCH_WINDOW_MS,
};
