import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log/main';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CAPTURES_DIR, LOGS_DIR } from '@/shared/constants';

import { destroyCaptureWindow } from './capture-window';
import {
  registerGlobalShortcut,
  unregisterAllGlobalShortcuts,
  type GlobalShortcutHandle,
} from './global-shortcut';
import { attachIoEventBridgeToWindow, registerIpcHandlers } from './ipc';
import type { MonitorHandle } from './monitor';
import { setMonitorHandle } from './monitor/handle';
import { startNotifications, type NotificationsHandle } from './notifications';
import {
  ALLOWED_HOSTNAMES,
  assertEgressPolicy,
  EgressViolation,
  isEgressGuardDisabled,
  registerHttpInterceptor,
} from './security/egress-policy';
import { startTray, type TrayHandle } from './tray';

// --- electron-log bootstrap --------------------------------------------------
// Wave 6C installed electron-log but couldn't wire it. We initialize early so
// every console.* call from this point forward is mirrored to a rotating file
// under `~/.taskpilot/logs/main.log`. The renderer has its own log file via
// electron-log/renderer (configured later if needed).
log.initialize();
log.transports.file.resolvePathFn = (): string => path.join(LOGS_DIR, 'main.log');
// Rotation: cap at 10 MB per file, archive the prior file so we keep one
// generation. Without this main.log grows unbounded.
log.transports.file.maxSize = 10 * 1024 * 1024;
log.transports.file.archiveLogFn = (oldPath): void => {
  // Move <name>.log → <name>.old.log on rotation. Renderer logs use the
  // same convention via electron-log's defaults, but main.ts uses an
  // explicit resolvePathFn so we provide a matching archive helper.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const archivedPath = oldPath.toString().replace(/\.log$/, '.old.log');
  try {
    fs.renameSync(oldPath.toString(), archivedPath);
  } catch {
    /* non-fatal — rotation just overwrites instead */
  }
};
console.log = log.log.bind(log);
console.warn = log.warn.bind(log);
console.error = log.error.bind(log);

// In CJS output, __dirname is available. When running via tsx in ESM mode we need a fallback.
const _filename =
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// --- Single-instance lock ----------------------------------------------------
// If another TaskPilot instance is already running, focus its window and bail
// out. The local API server binds to a fixed port (7847) so a second instance
// would always fail to boot anyway — exiting cleanly is the right behavior.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

// Stable app id so Windows groups dock/jumplist entries and notifications
// under the same identity across runs.
app.setAppUserModelId('com.jackgierlich.taskpilot');

let mainWindow: BrowserWindow | null = null;
let trayHandle: TrayHandle | null = null;
let notificationsHandle: NotificationsHandle | null = null;
let globalShortcutHandle: GlobalShortcutHandle | null = null;
let conversationsHandle: import('./conversations').ConversationsHandle | null =
  null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'TaskPilot',
    show: false,
    webPreferences: {
      preload: path.join(_dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox the renderer. The preload script uses `contextBridge` to
      // expose only the IPC surface defined in `preload.ts`; nothing in the
      // renderer should need Node integration or fs access.
      sandbox: true,
    },
  });

  // Any `target=_blank` / `window.open` in the renderer should open in the
  // user's default browser, not in a new Electron BrowserWindow. The IPC
  // `tp:open-external` channel handles scheme validation for explicit links.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'mailto:'
      ) {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      // Malformed URL — drop silently.
    }
    return { action: 'deny' };
  });

  // Block in-page navigation away from the renderer entry point. Anything
  // that isn't our dev server or the bundled `app://` / `file://` HTML must
  // be opened in the user's browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const isDevServer =
        isDev &&
        parsed.origin === (process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173');
      const isLocalAsset =
        parsed.protocol === 'file:' || parsed.protocol === 'app:';
      if (!isDevServer && !isLocalAsset) {
        event.preventDefault();
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          void shell.openExternal(parsed.toString());
        }
      }
    } catch {
      event.preventDefault();
    }
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererIndex = path.join(_dirname, 'renderer', 'index.html');
    void win.loadURL(pathToFileURL(rendererIndex).toString());
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Initialize observer (v2 ambient intelligence)
  void (async () => {
    try {
      const { initializeObserverIntegration } = await import('./observer-integration');
      await initializeObserverIntegration(win);
    } catch (err) {
      console.error('Failed to initialize observer:', err);
    }
  })();

  return win;
}

// --- Egress policy -----------------------------------------------------------
// Audit static configuration and wrap http/https/fetch BEFORE any integration
// has a chance to issue an outbound request. Failure here is fatal: the user
// sees a dialog, and the app exits — the alternative (silently shipping data
// to a non-allowlisted host) is worse.
//
// Telemetry settings + webhook endpoints are read lazily via require() so a
// drizzle init failure in the settings repo never masks the actual policy
// violation.
function bootEgressPolicy(): void {
  if (isEgressGuardDisabled()) {
    console.warn(
      '[taskpilot] egress guard disabled via TASKPILOT_DISABLE_EGRESS_GUARD',
    );
    // Still register the wrapper so call sites are uniform; the wrapper
    // becomes a passthrough when the escape hatch is set.
    registerHttpInterceptor();
    return;
  }
  try {
    let telemetryEndpoint: string | null = null;
    let webhookEndpoints: string[] = [];
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const settingsMod = require('./db/repositories/settings') as {
        settingsRepository?: { get?: <T = unknown>(key: string) => T | null };
      };
      const get = settingsMod.settingsRepository?.get;
      if (typeof get === 'function') {
        telemetryEndpoint = get<string>('telemetry_endpoint') ?? null;
      }
    } catch (err) {
      console.warn(
        '[taskpilot] egress audit could not read settings:',
        (err as Error).message,
      );
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webhooksMod = require('./db/repositories/webhooks') as {
        webhooksRepository?: { list?: () => Array<{ url?: string }> };
      };
      const list = webhooksMod.webhooksRepository?.list;
      if (typeof list === 'function') {
        webhookEndpoints = list()
          .map((w) => w.url)
          .filter((u): u is string => typeof u === 'string');
      }
    } catch {
      /* webhooks repo optional — many installs have none configured */
    }
    assertEgressPolicy({ telemetryEndpoint, webhookEndpoints });
    registerHttpInterceptor();
    console.log(
      `[taskpilot] egress policy active, ${ALLOWED_HOSTNAMES.length} entries`,
    );
  } catch (err) {
    const reasons =
      err instanceof EgressViolation ? err.reasons.join('\n - ') : (err as Error).message;
    console.error('[taskpilot] egress policy assertion failed:\n -', reasons);
    try {
      dialog.showErrorBox(
        'TaskPilot — egress policy violation',
        `TaskPilot detected outbound configuration that contradicts the egress allowlist and is exiting to prevent data leakage:\n\n${reasons}\n\nSet TASKPILOT_DISABLE_EGRESS_GUARD=1 to override (development only).`,
      );
    } catch {
      /* dialog unavailable pre-ready */
    }
    app.exit(1);
    return;
  }
}

// --- Sub-system bootstrap ----------------------------------------------------
// Other waves provide these modules. We import dynamically so the app starts
// before they exist. Each is wrapped in try/catch so missing modules don't
// crash launch.

async function bootApiServer(): Promise<void> {
  try {
    const mod = (await import('./server/index')) as {
      startApiServer?: () => Promise<unknown> | unknown;
    };
    if (typeof mod.startApiServer === 'function') {
      await mod.startApiServer();
      console.log('[taskpilot] api server started');
    } else {
      console.log('[taskpilot] api server module loaded but startApiServer() not exported');
    }
  } catch (err) {
    console.log('[taskpilot] api server not available yet:', (err as Error).message);
  }
}

// NOTE: The I/O watcher is owned exclusively by the API server (see
// `bootSubsystems` in src/main/server/index.ts). A second watcher here would
// race with the first and the no-op handlers would overwrite the real
// ingestion handlers via `activeRescan` (module-singleton). Do NOT add a
// `bootIoWatcher` here.

async function bootCalendarSync(): Promise<void> {
  try {
    const mod = (await import('./calendar/sync')) as {
      startCalendarSync?: () => Promise<unknown> | unknown;
    };
    if (typeof mod.startCalendarSync === 'function') {
      await mod.startCalendarSync();
      console.log('[taskpilot] calendar sync started');
    } else {
      console.log('[taskpilot] calendar sync module loaded but startCalendarSync() not exported');
    }
  } catch (err) {
    console.log('[taskpilot] calendar sync not available yet:', (err as Error).message);
  }
}

/* --- Ambient monitor + deliberation --------------------------------------- */
// Started after the API server + io watcher are up so the deliberation file
// drops the orchestrator writes are guaranteed to be picked up by the
// already-running watcher (see `bootSubsystems` in server/index.ts; it owns
// the watcher AND the `onDeliberatedFound` callback that calls
// `ingestDeliberation`). The monitor itself emits `observation_captured` on
// the io event bus; the batcher / orchestrator we inject as `flush` does the
// rest. Every tick re-reads settings so the master toggle propagates without
// requiring an app restart — this satisfies the "shouldRun callback" intent
// from the wire phase (the monitor's own ticker checks
// `ambient_monitor_enabled` on every tick).
let monitorHandle: MonitorHandle | null = null;

/**
 * One-time filesystem masking step. Lazy-imports `./security/fs-mask` so the
 * helper itself can fail to load (e.g. dev rebuild in progress) without
 * crashing the bootstrap chain. Every call is internally idempotent — the
 * Win Search registry write uses `reg add /f` which overwrites silently,
 * and the hidden-attribs pass is a no-op when the bits are already set.
 *
 * Non-fatal in every failure mode. The captures dir keeps working without
 * the search exclusion (it's a defense-in-depth layer, not a correctness
 * requirement).
 */
async function runFsMaskOnboarding(): Promise<void> {
  try {
    const mod = (await import('./security/fs-mask')) as {
      applyHiddenAttribs?: (p: string) => Promise<void>;
      excludeFromWindowsSearch?: (p: string) => Promise<void>;
    };
    if (typeof mod.applyHiddenAttribs === 'function') {
      await mod.applyHiddenAttribs(CAPTURES_DIR);
    }
    if (typeof mod.excludeFromWindowsSearch === 'function') {
      await mod.excludeFromWindowsSearch(CAPTURES_DIR);
    }
  } catch (err) {
    console.warn(
      '[taskpilot] fs-mask onboarding failed:',
      (err as Error).message,
    );
  }
}

async function bootAmbientMonitor(): Promise<void> {
  try {
    const [monitorMod, deliberationMod] = await Promise.all([
      import('./monitor') as Promise<typeof import('./monitor')>,
      import('./deliberation') as Promise<typeof import('./deliberation')>,
    ]);
    const { startMonitor } = monitorMod;
    const { requestDeliberation } = deliberationMod;
    // The monitor's `flush` is the producer call into the deliberation
    // orchestrator. We swallow `no observations` (orchestrator throws when
    // nothing's queued) so a stray flushNow() with an empty buffer doesn't
    // log a scary stack — that's a benign no-op.
    monitorHandle = startMonitor({
      flush: async (observationIds, reason) => {
        try {
          await requestDeliberation({
            observation_ids: observationIds,
            trigger_reason: reason,
          });
        } catch (cause) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          if (message.includes('no observations')) return;
          console.warn(
            '[taskpilot] ambient deliberation request failed:',
            message,
          );
        }
      },
    });
    // Publish the handle through the singleton holder so the context route
    // (and any future caller) can acquire the monitor mutex without
    // threading the handle through every layer. Cleared in `before-quit`.
    setMonitorHandle(monitorHandle);
    console.log('[taskpilot] ambient monitor started');
  } catch (err) {
    console.warn(
      '[taskpilot] ambient monitor failed to start:',
      (err as Error).message,
    );
  }
}

/**
 * Register Ctrl+Shift+\ — global panic-mode toggle. Flips the
 * `ambient_panic_mode` setting, immediately gates further window/screenshot
 * ticks (the monitor re-reads on every tick), and refreshes the tray so the
 * checkbox reflects the new state. Held separately from quick-capture /
 * manual-deliberation so the user can audit one accelerator without
 * affecting the others. Failure to register is non-fatal — the tray menu
 * is still a working entry point.
 */
async function registerPanicModeHotkey(): Promise<void> {
  try {
    const { globalShortcut } = await import('electron');
    const accelerator = 'CommandOrControl+Shift+\\';
    const ok = globalShortcut.register(accelerator, () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { settingsRepository } = require('./db/repositories/settings') as {
          settingsRepository: {
            get: <T = unknown>(key: string) => T | null;
            set: (key: string, value: unknown) => void;
          };
        };
        const current = settingsRepository.get<boolean>('ambient_panic_mode');
        const next = !(current === true);
        settingsRepository.set('ambient_panic_mode', next);
        console.log(`[taskpilot] panic mode toggled → ${next ? 'on' : 'off'}`);
        // Refresh the tray so its checkbox reflects the new state without
        // the user having to right-click first.
        try {
          trayHandle?.refresh();
        } catch {
          /* tray may not be up yet — toggle still landed in settings */
        }
      } catch (cause) {
        console.warn(
          '[taskpilot] panic mode toggle failed:',
          (cause as Error).message,
        );
      }
    });
    if (ok) {
      console.log(
        `[taskpilot] panic mode hotkey registered: ${accelerator}`,
      );
    } else {
      console.warn(
        `[taskpilot] panic mode hotkey "${accelerator}" was unavailable`,
      );
    }
  } catch (err) {
    console.warn(
      '[taskpilot] panic mode hotkey registration failed:',
      (err as Error).message,
    );
  }
}

/**
 * Register Ctrl+Shift+. (period) — global manual deliberation flush. Pushes
 * whatever observations are currently buffered through the orchestrator. Held
 * separately from the quick-capture hotkey so the user can opt to disable one
 * without losing the other.
 */
async function registerManualDeliberationHotkey(): Promise<void> {
  try {
    const { globalShortcut } = await import('electron');
    const accelerator = 'CommandOrControl+Shift+.';
    const ok = globalShortcut.register(accelerator, () => {
      try {
        // The batcher's reason vocabulary is internal ('manual' covers any
        // user-triggered flush); the deliberation orchestrator's reason
        // vocab ('hotkey') is downstream of the request payload, not this
        // handle.
        monitorHandle?.flushNow('manual');
      } catch (cause) {
        console.warn(
          '[taskpilot] manual deliberation flush failed:',
          (cause as Error).message,
        );
      }
    });
    if (ok) {
      console.log(
        `[taskpilot] manual deliberation hotkey registered: ${accelerator}`,
      );
    } else {
      console.warn(
        `[taskpilot] manual deliberation hotkey "${accelerator}" was unavailable`,
      );
    }
  } catch (err) {
    console.warn(
      '[taskpilot] manual deliberation hotkey registration failed:',
      (err as Error).message,
    );
  }
}

// --- Process-level crash handlers --------------------------------------------
// Surface anything that escapes a handler so the user sees a dialog instead of
// a silently-dead window. We don't try to recover — process exits cleanly.

/**
 * Telemetry-aware error reporter. Always logs locally; the upload pump
 * inside `src/main/telemetry` decides whether to ship based on the
 * `telemetry_enabled` opt-in. Wrapped in try/catch so a telemetry failure
 * never masks the original crash.
 */
function reportToTelemetry(
  source: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
): void {
  try {
    // Lazy-require so the telemetry module can fail to load without breaking
    // the crash handler itself.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./telemetry') as {
      recordError?: (e: unknown, ctx?: Record<string, unknown>) => void;
    };
    if (typeof mod.recordError === 'function') {
      mod.recordError(err, { source });
    }
  } catch {
    /* telemetry never gets to crash the crash handler */
  }
}

process.on('uncaughtException', (err) => {
  console.error('[taskpilot] uncaughtException:', err);
  reportToTelemetry('uncaughtException', err);
  try {
    dialog.showErrorBox(
      'TaskPilot error',
      `An unexpected error occurred:\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
  } catch {
    /* dialog may not be available if Electron hasn't initialized */
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[taskpilot] unhandledRejection:', reason);
  reportToTelemetry('unhandledRejection', reason);
  try {
    dialog.showErrorBox(
      'TaskPilot error',
      `An unexpected promise rejection occurred:\n\n${
        reason instanceof Error ? reason.stack ?? reason.message : String(reason)
      }`,
    );
  } catch {
    /* see above */
  }
});

// --- App lifecycle -----------------------------------------------------------

app.on('second-instance', () => {
  // Someone tried to launch a second TaskPilot. Focus the existing window
  // instead of opening a new one.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Register IPC before window so the renderer can call it from first paint.
  registerIpcHandlers(ipcMain, () => mainWindow);

  mainWindow = createMainWindow();

  // Hook the ioEvents bus → IPC bridge so post-ingest events reach the
  // renderer (the watcher / API server emit on the bus; we forward).
  attachIoEventBridgeToWindow(() => mainWindow);

  // Boot tray + system notifications. Both depend on the window existing
  // (their click handlers focus it) and on the settings repository being
  // ready (boots with the API server in `bootApiServer` below, but the
  // settings repo opens a DB connection lazily on first read so this order
  // is fine).
  try {
    trayHandle = startTray({ getMainWindow: () => mainWindow });
  } catch (err) {
    console.warn('[taskpilot] tray failed to start:', (err as Error).message);
  }
  try {
    notificationsHandle = startNotifications({
      getMainWindow: () => mainWindow,
    });
  } catch (err) {
    console.warn(
      '[taskpilot] notifications failed to start:',
      (err as Error).message,
    );
  }

  // Boot background services. Order is intentional but each is independent.
  // The API server also owns the I/O watcher (see `bootSubsystems` in
  // src/main/server/index.ts) — do not double-boot it here.
  //
  // Egress policy runs FIRST so the http/https/fetch wrappers are in place
  // before any integration (calendar, GH, Slack, etc.) has a chance to issue
  // a request. A violation here exits the app — see `bootEgressPolicy`.
  bootEgressPolicy();
  await bootApiServer();
  await bootCalendarSync();

  // One-time filesystem masking. Adds the captures dir to the Windows Search
  // exclusion list so the indexer doesn't sweep up screenshots into the
  // search database. Idempotent — `reg add /f` overwrites silently — but we
  // still gate behind a settings flag so a user can opt out and revert it.
  // Failure (permissions, registry locked, reg.exe missing) is logged and
  // swallowed — losing this exclusion only degrades a defense-in-depth
  // layer; the captures dir is still hidden + opaque-named.
  await runFsMaskOnboarding();

  // Ambient monitor + deliberation. Started AFTER the API server so the
  // watcher (which dispatches deliberation verdicts to ingestion) is up and
  // the settings repo is initialized. The monitor stays dormant if the user
  // hasn't opted in — its boot is safe to call unconditionally.
  await bootAmbientMonitor();

  // Conversations subsystem (Claude Code session catalogue). Reads from
  // `~/.claude/projects/` and writes summarize requests through the io
  // bridge. Honors `conversations_enabled` (default true). Failure is
  // non-fatal — losing this only disables auto-cataloguing.
  try {
    const { startConversations } = await import('./conversations/index.js');
    conversationsHandle = await startConversations();
    console.log('[taskpilot] conversations subsystem started');
  } catch (err) {
    console.warn(
      '[taskpilot] conversations subsystem failed to start:',
      (err as Error).message,
    );
  }

  // Global quick-capture hotkey. Registered after the API is up so the
  // settings repository (used to read the configured accelerator) is
  // guaranteed to have a DB connection. Failure is non-fatal — the
  // module logs a warning and the app stays usable without the hotkey.
  try {
    globalShortcutHandle = await registerGlobalShortcut({
      getMainWindow: () => mainWindow,
    });
  } catch (err) {
    console.warn(
      '[taskpilot] global shortcut registration failed:',
      (err as Error).message,
    );
  }

  // Manual-flush hotkey for the ambient monitor. Lives separately so it can
  // be toggled / debugged without disturbing the quick-capture binding.
  await registerManualDeliberationHotkey();

  // Panic-mode toggle hotkey. Coexists with the other two global shortcuts;
  // registration failure is logged as a warning so the user can still toggle
  // via the tray menu.
  await registerPanicModeHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      attachIoEventBridgeToWindow(() => mainWindow);
    }
  });
});

app.on('window-all-closed', () => {
  // Per spec: quit on Windows/Linux. Mac keeps dock alive.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Tear down tray + notifications listeners before Electron starts ripping
  // down windows. Both helpers no-op if already disposed.
  try {
    trayHandle?.destroy();
  } catch {
    /* already destroyed */
  }
  trayHandle = null;
  try {
    notificationsHandle?.stop();
  } catch {
    /* already stopped */
  }
  notificationsHandle = null;
  // Ambient monitor — `.stop()` clears timers + unsubscribes from the io
  // event bus. The deliberation ingestion side rides on the API server's
  // watcher and is torn down in that subsystem's stopWatcher handle.
  try {
    monitorHandle?.stop();
  } catch {
    /* already stopped */
  }
  monitorHandle = null;
  setMonitorHandle(null);
  // Conversations subsystem — ingestor + compactor timers.
  void (async () => {
    try {
      await conversationsHandle?.stop();
    } catch {
      /* already stopped */
    }
    conversationsHandle = null;
  })();
});

app.on('will-quit', () => {
  console.log('[taskpilot] shutting down');
  try {
    globalShortcutHandle?.unregister();
  } catch {
    /* already torn down */
  }
  globalShortcutHandle = null;
  // Belt-and-suspenders — make sure no global shortcut survives across
  // a `will-quit` triggered by a crash recovery path.
  try {
    unregisterAllGlobalShortcuts();
  } catch {
    /* nothing left */
  }
  try {
    destroyCaptureWindow();
  } catch {
    /* not created */
  }
  // Shutdown observer
  void (async () => {
    try {
      const { shutdownObserverIntegration } = await import('./observer-integration');
      await shutdownObserverIntegration();
    } catch (err) {
      console.debug('Failed to shutdown observer:', err);
    }
  })();
});
