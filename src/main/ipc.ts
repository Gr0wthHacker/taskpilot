import { shell, type IpcMain, type BrowserWindow } from 'electron';
import os from 'node:os';
import path from 'node:path';

import { getOrCreateApiToken } from './api-auth';
import { ioEvents } from './io/events';
import { derivedPath, inboxPath, resultPath } from './io/paths';

// Channel constants — keep in sync with preload.ts.
const CHANNEL_CONFIG = 'tp:config';
const CHANNEL_IO_EVENT = 'tp:io:event';
const CHANNEL_INGEST = 'tp:ingest';
const CHANNEL_OPEN_IO = 'tp:open-io-folder';
const CHANNEL_OPEN_EXTERNAL = 'tp:open-external';
const CHANNEL_TRAY_COMMAND = 'tp:tray:command';
// Wave 10 / S8: renderer reads the per-install bearer token over IPC so the
// raw value never lands in window.* config (which is logged on diagnostic
// surfaces). The token is read from disk on every invoke; cached internally
// by the renderer.
const CHANNEL_API_TOKEN = 'tp:auth:token';
// Wave 11 / quick-capture: capture window → main process → POST /api/tasks.
// Main also pushes `tp:capture:created` back so the main window can show a
// toast. `tp:capture:dismiss` lets the capture renderer hide itself.
const CHANNEL_CAPTURE_SUBMIT = 'tp:capture:submit';
const CHANNEL_CAPTURE_DISMISS = 'tp:capture:dismiss';
const CHANNEL_CAPTURE_CREATED = 'tp:capture:created';
const CHANNEL_CAPTURE_FOCUS = 'tp:capture:focus';

/**
 * Commands the tray menu can send to the renderer. The renderer subscribes
 * via `window.taskpilot.onTrayCommand(...)` (see preload.ts) and routes the
 * command appropriately — `quick-add` opens the global quick-add modal,
 * `navigate` pushes a route into the router.
 */
export type TrayCommand =
  | { kind: 'quick-add' }
  | { kind: 'navigate'; path: string };

/**
 * Tray IPC channel names. The single multiplexed channel `TRAY_COMMAND`
 * carries every command shape so the renderer only needs one listener.
 */
export const TRAY_CHANNELS = {
  TRAY_COMMAND: CHANNEL_TRAY_COMMAND,
} as const;

/**
 * Schemes the renderer is allowed to launch via `shell.openExternal`. We
 * deliberately do NOT include `file:` — opening filesystem paths is what the
 * dedicated `OPEN_IO_FOLDER` channel is for, and we don't want a runaway
 * renderer to be able to launch arbitrary local programs.
 */
const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

const API_PORT = 7847;
const HOME = os.homedir();
const TP_HOME = path.join(HOME, '.taskpilot');

function buildConfig(): {
  version: string;
  paths: Record<string, string>;
  api_port: number;
} {
  return {
    version: '0.1.0',
    api_port: API_PORT,
    paths: {
      TASKPILOT_HOME: TP_HOME,
      DB_PATH: path.join(TP_HOME, 'taskpilot.db'),
      CREDS_PATH: path.join(TP_HOME, 'credentials.json'),
      LOGS_DIR: path.join(TP_HOME, 'logs'),
      IO_ROOT: path.join(TP_HOME, 'io'),
      IO_INBOX: path.join(TP_HOME, 'io', 'inbox'),
      IO_DERIVE: path.join(TP_HOME, 'io', 'derive'),
      IO_DERIVED: path.join(TP_HOME, 'io', 'derived'),
      IO_EXECUTE: path.join(TP_HOME, 'io', 'execute'),
      IO_RESULTS: path.join(TP_HOME, 'io', 'results'),
      IO_REVIEW: path.join(TP_HOME, 'io', 'review'),
      IO_CONTEXT: path.join(TP_HOME, 'io', 'context'),
    },
  };
}

/**
 * Register all IPC handlers. Called once from main on app.whenReady().
 * Accepts a getWindow() thunk so callers can resolve the live window even
 * if it's recreated after a close (Mac).
 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle(CHANNEL_CONFIG, () => buildConfig());

  // Renderer-only bridge: returns the per-install bearer token so the
  // renderer's fetch wrapper can send `Authorization: Bearer …`. The
  // renderer never persists this token; it's re-fetched on every
  // session. The IPC channel is protected by Electron's contextIsolation
  // boundary — only the preload bridge can invoke it.
  ipcMain.handle(CHANNEL_API_TOKEN, async () => {
    try {
      return await getOrCreateApiToken();
    } catch (err) {
      // Surface a structured failure rather than the raw error string so
      // accidental console.error in the renderer can't leak any partial
      // token write state.
      return {
        error: {
          code: 'api_token_unavailable',
          message: (err as Error).message ?? 'failed to read api token',
        },
      };
    }
  });

  ipcMain.handle(CHANNEL_INGEST, async () => {
    try {
      // Wave 1C provides this. Defensive dynamic import.
      const mod = (await import('./io/watcher')) as {
        triggerRescan?: () => Promise<void> | void;
      };
      if (typeof mod.triggerRescan === 'function') {
        await mod.triggerRescan();
        return { ok: true };
      }
      return { ok: false, message: 'watcher not available' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNEL_OPEN_IO, async () => {
    try {
      const ioRoot = path.join(TP_HOME, 'io');
      const result = await shell.openPath(ioRoot);
      if (result.length > 0) {
        return { ok: false, message: result };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNEL_OPEN_EXTERNAL, async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
      return { ok: false, message: 'url must be a non-empty string' };
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, message: `invalid url: ${rawUrl}` };
    }
    if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
      return {
        ok: false,
        message: `scheme ${parsed.protocol} is not allowed`,
      };
    }
    try {
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  // ---- Quick-capture submit -------------------------------------------
  // Capture-window renderer posts `{ title, description? }` here. We
  // forward to POST /api/tasks (same payload shape) so auto-derive fires
  // exactly as it would for the normal NewTaskDialog. The main window
  // (if open) gets a toast via `tp:capture:created`.
  ipcMain.handle(
    CHANNEL_CAPTURE_SUBMIT,
    async (
      _event,
      payload: unknown,
    ): Promise<
      | { ok: true; task_id: string; title: string }
      | { ok: false; message: string }
    > => {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, message: 'invalid payload' };
      }
      const obj = payload as Record<string, unknown>;
      const title =
        typeof obj.title === 'string' ? obj.title.trim() : '';
      if (!title) {
        return { ok: false, message: 'title is required' };
      }
      if (title.length > 500) {
        return { ok: false, message: 'title is too long' };
      }
      const description =
        typeof obj.description === 'string' && obj.description.trim().length > 0
          ? obj.description.trim()
          : null;

      try {
        const created = await submitQuickCapture({
          title,
          description,
        });
        // Toast on the main window. If the main window isn't open, the
        // user still sees the capture window dismiss as confirmation.
        try {
          const mainWin = getWindow();
          if (mainWin && !mainWin.isDestroyed()) {
            mainWin.webContents.send(CHANNEL_CAPTURE_CREATED, {
              task_id: created.task_id,
              title: created.title,
            });
          }
        } catch {
          /* toast is best-effort */
        }
        return { ok: true, task_id: created.task_id, title: created.title };
      } catch (err) {
        return {
          ok: false,
          message: (err as Error).message ?? 'failed to create task',
        };
      }
    },
  );

  // ---- Capture-window dismiss -----------------------------------------
  ipcMain.handle(CHANNEL_CAPTURE_DISMISS, async () => {
    try {
      const mod = (await import('./capture-window')) as {
        hideCaptureWindow?: () => void;
      };
      if (typeof mod.hideCaptureWindow === 'function') {
        mod.hideCaptureWindow();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  // Touch the window getter so TS doesn't complain about it being unused.
  // Other modules (e.g. io/watcher) can call emitIoEvent() below to push.
  void getWindow;
}

/* -------------------------------------------------------------------------- */
/*  Quick-capture helper                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Create a task on behalf of the capture window. Uses the same code path
 * as the HTTP endpoint (createTask + maybeAutoDerive) by going through
 * the local API. Doing it via HTTP keeps a single place where auto-derive,
 * permission seeding, and validation live.
 *
 * We post to `127.0.0.1:7847` over loopback with the in-process API token.
 * This avoids importing the route handler directly (which would couple the
 * IPC bridge to Express internals).
 */
async function submitQuickCapture(input: {
  title: string;
  description: string | null;
}): Promise<{ task_id: string; title: string }> {
  const token = await getOrCreateApiToken();
  const body = {
    title: input.title,
    description: input.description,
    agent_method: 'either' as const,
  };

  const res = await fetch(`http://127.0.0.1:${API_PORT}/api/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      if (errBody?.error?.message) detail = errBody.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(`task create failed: ${detail}`);
  }

  const data = (await res.json()) as { task: { id: string; title: string } };
  return { task_id: data.task.id, title: data.task.title };
}

/**
 * Push an I/O event to the renderer. Other modules (watcher, server) import
 * and call this once they receive the BrowserWindow reference via DI.
 */
export function emitIoEvent(
  window: BrowserWindow | null,
  event: {
    kind: 'derived' | 'result' | 'inbox' | 'invalid' | 'unknown';
    task_id?: string;
    path: string;
    at: string;
  },
): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(CHANNEL_IO_EVENT, event);
}

/**
 * Subscribe to the I/O event bus and forward post-ingest events to the
 * renderer via {@link emitIoEvent}. Idempotent — repeated calls (after a
 * window close/recreate) safely replace the prior listeners.
 *
 * Listens for the three "successful ingest" events emitted by
 * `@/main/io/ingestion`. Each one is normalized to the renderer-facing
 * `{ kind, task_id, path, at }` shape and pushed over IPC.
 *
 * Returns a disposer that detaches the listeners (used for shutdown / tests).
 */
let activeIoBridgeDisposer: (() => void) | null = null;

export function attachIoEventBridgeToWindow(
  getWindow: () => BrowserWindow | null,
): () => void {
  // Replace any prior wiring so a window recreate doesn't leak listeners.
  if (activeIoBridgeDisposer) {
    activeIoBridgeDisposer();
    activeIoBridgeDisposer = null;
  }

  const onDerived = (payload: { taskId: string }): void => {
    let p = '';
    try {
      p = derivedPath(payload.taskId);
    } catch {
      // invalid id — emit with empty path rather than throw
    }
    emitIoEvent(getWindow(), {
      kind: 'derived',
      task_id: payload.taskId,
      path: p,
      at: new Date().toISOString(),
    });
  };
  const onResult = (payload: { taskId: string }): void => {
    let p = '';
    try {
      p = resultPath(payload.taskId);
    } catch {
      /* see above */
    }
    emitIoEvent(getWindow(), {
      kind: 'result',
      task_id: payload.taskId,
      path: p,
      at: new Date().toISOString(),
    });
  };
  const onInbox = (payload: { taskId: string }): void => {
    let p = '';
    try {
      p = inboxPath(payload.taskId);
    } catch {
      /* see above */
    }
    emitIoEvent(getWindow(), {
      kind: 'inbox',
      task_id: payload.taskId,
      path: p,
      at: new Date().toISOString(),
    });
  };

  ioEvents.on('derived_ingested', onDerived);
  ioEvents.on('result_ingested', onResult);
  ioEvents.on('inbox_ingested', onInbox);

  const disposer = (): void => {
    ioEvents.off('derived_ingested', onDerived);
    ioEvents.off('result_ingested', onResult);
    ioEvents.off('inbox_ingested', onInbox);
  };
  activeIoBridgeDisposer = disposer;
  return disposer;
}

export const IPC_CHANNELS = {
  CONFIG: CHANNEL_CONFIG,
  IO_EVENT: CHANNEL_IO_EVENT,
  INGEST: CHANNEL_INGEST,
  OPEN_IO_FOLDER: CHANNEL_OPEN_IO,
  OPEN_EXTERNAL: CHANNEL_OPEN_EXTERNAL,
  TRAY_COMMAND: CHANNEL_TRAY_COMMAND,
  API_TOKEN: CHANNEL_API_TOKEN,
  CAPTURE_SUBMIT: CHANNEL_CAPTURE_SUBMIT,
  CAPTURE_DISMISS: CHANNEL_CAPTURE_DISMISS,
  CAPTURE_CREATED: CHANNEL_CAPTURE_CREATED,
  CAPTURE_FOCUS: CHANNEL_CAPTURE_FOCUS,
} as const;

/**
 * Send a tray-originated command to the renderer. Idempotent: if the window
 * is destroyed or null this is a no-op. The renderer subscribes via
 * `window.taskpilot.onTrayCommand(...)`.
 *
 * Note: `tray.ts` builds the menu and calls its own internal helper which
 * also restores/focuses the window before sending. This exported version is
 * a thinner primitive — exposed mostly so other main-process modules (or
 * tests) can drive the same channel without depending on `tray.ts`.
 */
export function sendTrayCommand(
  getMainWindow: () => BrowserWindow | null,
  command: TrayCommand,
): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(CHANNEL_TRAY_COMMAND, command);
}

/**
 * Attach a tray-command listener helper. Currently a no-op on the main side
 * (the renderer listens on `tp:tray:command` directly via preload). Exposed
 * so future wiring (e.g. a tray-event audit log) has a hook point without
 * touching every call site.
 *
 * Returns a disposer for symmetry with {@link attachIoEventBridgeToWindow}.
 */
export function attachTrayBridge(
  _getMainWindow: () => BrowserWindow | null,
): () => void {
  // No additional wiring yet — `startTray()` already owns menu construction
  // and uses `webContents.send(TRAY_CHANNELS.TRAY_COMMAND, …)` directly.
  return () => {
    /* no-op */
  };
}
