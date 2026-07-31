/**
 * System tray integration.
 *
 * Exports `startTray()` which builds a tray icon + context menu and wires
 * every menu item to either a callback the renderer can react to (via the IPC
 * channels declared in `ipc.ts`) or an app-level action (show window, open IO
 * folder, quit).
 *
 * The tray is created lazily — we only attach it after the main window has
 * been constructed so `getMainWindow` can resolve to a live `BrowserWindow`
 * for every callback. The icon is loaded from `build/icon.png` which ships
 * via electron-builder; in dev it lives next to the repo root.
 *
 * Boot order:
 *   1. Main process creates the window.
 *   2. Main calls `startTray({ getMainWindow })`.
 *   3. Tray menu actions either fire IPC events (`tp:tray:navigate`,
 *      `tp:tray:quick-add`) that the renderer handles, or directly call
 *      Electron APIs (window show/focus, app.quit, shell.openPath).
 *
 * The renderer subscribes via `window.taskpilot.onTrayCommand(...)` (see
 * `preload.ts`). The Layout component owns that subscription.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Menu,
  Tray,
  app,
  dialog,
  nativeImage,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';

import { listTasks } from './db/repositories/tasks';
import { settingsRepository } from './db/repositories/settings';
import {
  disableAutoDrain,
  enableAutoDrain,
  getAutoDrainStatus,
  isAutoDrainAvailable,
} from './deliberation/auto-drain';
import { TRAY_CHANNELS, type TrayCommand } from './ipc';
import { runPanicWipe } from './monitor/panic-wipe';

const TOOLTIP = 'TaskPilot';

const SETTING_AGENT_PAUSED = 'agent_paused';
const SETTING_AUTO_EXECUTE = 'auto_execute_approved';
/**
 * Ambient panic-mode flag. Mirrors `KEY_PANIC_MODE` from
 * `@/main/monitor/index.ts` — when true the monitor's window + screenshot
 * ticks short-circuit and the Watch view renders censored. Toggled via the
 * tray menu, the global hotkey, or `POST /api/settings/ambient_panic_mode`.
 */
const SETTING_PANIC_MODE = 'ambient_panic_mode';

/**
 * Refresh interval for the tooltip + menu cowork count. 30s mirrors the
 * staleTime on the renderer hook so the two surfaces stay in lockstep.
 */
const COWORK_REFRESH_MS = 30_000;

/**
 * Count queued cowork-eligible tasks. Cheap — the tasks table is small
 * relative to anything else better-sqlite3 touches, and the filter is a
 * single status equality + a tiny in-memory predicate.
 */
function countCoworkWaiting(): number {
  try {
    const tasks = listTasks({ status: 'queued', limit: 500 });
    return tasks.filter(
      (t) => t.agent_method === 'cowork' || t.agent_method === 'either',
    ).length;
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/*  Module-local CJS/ESM-compat __dirname                                     */
/* -------------------------------------------------------------------------- */

// At runtime the bundled tray.ts is concatenated into `dist/main.cjs`, so
// `__dirname` is available. When loaded via tsx in ESM mode (tests, server
// standalone) we fall back to import.meta.url.
const _filename =
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname =
  typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

/* -------------------------------------------------------------------------- */
/*  Icon resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Locate the tray icon PNG. In dev the file lives at `<repo>/build/icon.png`;
 * in a packaged build electron-builder copies it under `process.resourcesPath`.
 * Try a few candidate locations and use the first that exists — falls back to
 * an empty `nativeImage` so tray construction never throws.
 */
function resolveTrayIcon(): NativeImage {
  const candidates = [
    // packaged: resources/build/icon.png (extraResources or asarUnpack)
    process.resourcesPath
      ? path.join(process.resourcesPath, 'build', 'icon.png')
      : null,
    // dev: dist/../build/icon.png
    path.join(_dirname, '..', 'build', 'icon.png'),
    // tsx fallback: src/main → repo root → build
    path.join(_dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.cwd(), 'build', 'icon.png'),
  ].filter((p): p is string => typeof p === 'string');

  for (const candidate of candidates) {
    try {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) {
        // On macOS the menubar wants a small monochrome image.
        if (process.platform === 'darwin') {
          return img.resize({ width: 18, height: 18 });
        }
        return img;
      }
    } catch {
      /* try next candidate */
    }
  }

  return nativeImage.createEmpty();
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export interface StartTrayOptions {
  getMainWindow: () => BrowserWindow | null;
  /**
   * Optional ipc handle override. The default uses the channels declared in
   * `ipc.ts`; tests can substitute a stub.
   */
  ioRootPath?: string;
}

export interface TrayHandle {
  destroy: () => void;
  /** Re-read settings and rebuild the menu (used after a setting changes). */
  refresh: () => void;
  /** Exposed for tests. */
  readonly _tray: Tray;
}

function safeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

/**
 * Wipe-captures click handler. Pops a modal confirm dialog (parented to the
 * main window when possible) and, on approval, invokes the shared
 * {@link runPanicWipe} routine. The wipe itself is best-effort and never
 * throws — partial-failure warnings come back through `result.warnings`.
 *
 * The shaped result is surfaced via a second informational dialog so the
 * user has a paper trail in the moment; the audit log carries the
 * persistent record.
 */
async function confirmAndRunWipe(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  const candidate = getMainWindow();
  const parent =
    candidate && !candidate.isDestroyed() ? candidate : null;
  const messageBoxOpts = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Wipe'],
    defaultId: 0,
    cancelId: 0,
    title: 'TaskPilot — wipe captures',
    message:
      'This permanently deletes every captured screenshot and skips every pending deliberation. This action cannot be undone.',
    detail:
      'The captures directory is renamed and removed in the background. Pending deliberation rows are marked skipped. An audit event records the action.',
  };
  const confirm = parent
    ? await dialog.showMessageBox(parent, messageBoxOpts)
    : await dialog.showMessageBox(messageBoxOpts);
  if (confirm.response !== 1) return;
  try {
    const result = await runPanicWipe({ reason: 'tray' });
    const note =
      result.warnings.length > 0
        ? `Warnings: ${result.warnings.join('; ')}`
        : 'Captures cleared, pending deliberations skipped.';
    const infoOpts = {
      type: 'info' as const,
      title: 'TaskPilot — wipe complete',
      message: `Wiped ${result.files_deleted} files · skipped ${result.rows_skipped} pending deliberations.`,
      detail: note,
    };
    if (parent) {
      await dialog.showMessageBox(parent, infoOpts);
    } else {
      await dialog.showMessageBox(infoOpts);
    }
  } catch (err) {
    // runPanicWipe is documented as never-throwing; this catch is defense
    // in depth so a future regression doesn't leak a tray click as an
    // uncaught rejection.
    dialog.showErrorBox(
      'TaskPilot — wipe failed',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function sendCommand(
  getMainWindow: () => BrowserWindow | null,
  command: TrayCommand,
): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  // Make sure the window is visible before the renderer reacts — every tray
  // command implies "the user is interacting with the app right now".
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.send(TRAY_CHANNELS.TRAY_COMMAND, command);
}

/**
 * Build the "Agent" submenu items. Split out so the auto-drain entries
 * can branch on platform + current task-registration status without
 * bloating the main `buildMenu` body.
 *
 * The auto-drain entries are Windows-only (Task Scheduler is OS-specific
 * and the helper scripts are PowerShell). On macOS/Linux the entry is
 * omitted entirely — `isAutoDrainAvailable()` short-circuits.
 */
interface AgentSubmenuOptions {
  agentPaused: boolean;
  autoExecute: boolean;
  onPauseChange: (checked: boolean) => void;
  onAutoExecuteChange: (checked: boolean) => void;
  onEnableAutoDrain: () => void;
  onDisableAutoDrain: () => void;
}

export function buildAgentSubmenu(
  opts: AgentSubmenuOptions,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Pause all agent work',
      type: 'checkbox',
      checked: opts.agentPaused,
      click: (item) => opts.onPauseChange(item.checked),
    },
    {
      label: 'Auto-execute approved',
      type: 'checkbox',
      checked: opts.autoExecute,
      click: (item) => opts.onAutoExecuteChange(item.checked),
    },
  ];

  if (isAutoDrainAvailable()) {
    const status = getAutoDrainStatus();
    items.push({ type: 'separator' });
    if (status === 'registered') {
      items.push({
        label: 'Disable auto-drain (5-minute Claude polling)',
        click: () => opts.onDisableAutoDrain(),
      });
    } else {
      items.push({
        label: 'Enable auto-drain (5-minute Claude polling)…',
        click: () => opts.onEnableAutoDrain(),
        // Surface the unknown state to the user as an italic hint —
        // the click handler still runs setup, which is the right move
        // if we can't tell whether a task already exists.
        sublabel:
          status === 'unknown' ? 'status unknown — schtasks unreachable' : undefined,
      });
    }
  }

  return items;
}

export function startTray(options: StartTrayOptions): TrayHandle {
  const { getMainWindow } = options;
  const icon = resolveTrayIcon();
  const tray = new Tray(icon);
  tray.setToolTip(TOOLTIP);

  const buildMenu = (): Menu => {
    const agentPaused = safeBool(settingsRepository.get(SETTING_AGENT_PAUSED), false);
    const autoExecute = safeBool(
      settingsRepository.get(SETTING_AUTO_EXECUTE),
      false,
    );
    const panicMode = safeBool(settingsRepository.get(SETTING_PANIC_MODE), false);
    const coworkCount = countCoworkWaiting();

    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Show TaskPilot',
        click: () => {
          const win = getMainWindow();
          if (!win || win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
      },
      {
        label: 'Quick add task…',
        accelerator: process.platform === 'darwin' ? 'Cmd+N' : 'Ctrl+N',
        click: () => sendCommand(getMainWindow, { kind: 'quick-add' }),
      },
      { type: 'separator' },
      {
        label: 'Open Inbox',
        click: () => sendCommand(getMainWindow, { kind: 'navigate', path: '/' }),
      },
      {
        label: 'Open Review',
        click: () =>
          sendCommand(getMainWindow, { kind: 'navigate', path: '/review' }),
      },
      {
        label: `Cowork queue (${coworkCount} waiting)`,
        click: () =>
          sendCommand(getMainWindow, { kind: 'navigate', path: '/cowork' }),
      },
      {
        label: 'Open IO Folder',
        click: async () => {
          try {
            // Resolve the IO root the same way the IPC handler does. We can't
            // import the constant directly here without dragging the full
            // shared/constants module — but doing so is fine since both run in
            // the main process.
            const { IO_ROOT } = await import('@/shared/constants');
            await shell.openPath(IO_ROOT);
          } catch {
            /* non-fatal */
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Agent',
        submenu: buildAgentSubmenu({
          agentPaused,
          autoExecute,
          onPauseChange: (checked) => {
            settingsRepository.set(SETTING_AGENT_PAUSED, checked);
            refresh();
          },
          onAutoExecuteChange: (checked) => {
            settingsRepository.set(SETTING_AUTO_EXECUTE, checked);
            refresh();
          },
          onEnableAutoDrain: () => {
            enableAutoDrain(() => {
              // refresh once the script finishes so the menu flips to
              // "Disable auto-drain". The 1s status cache is invalidated
              // inside enableAutoDrain/onExit.
              refresh();
            });
            // Also refresh now so the menu doesn't show the same label
            // on the next right-click before the script completes.
            refresh();
          },
          onDisableAutoDrain: () => {
            disableAutoDrain(() => {
              refresh();
            });
            refresh();
          },
        }),
      },
      { type: 'separator' },
      {
        // Panic-mode toggle. Reflects current `ambient_panic_mode` setting;
        // clicking flips it and immediately refreshes the menu (so the
        // checkbox state stays accurate without waiting on the 30s tick).
        label: 'Panic mode',
        type: 'checkbox',
        checked: panicMode,
        click: (item) => {
          settingsRepository.set(SETTING_PANIC_MODE, item.checked);
          refresh();
        },
      },
      {
        // Destructive irreversible nuke. The wipe runs in-process via
        // `runPanicWipe()` — same code path as `POST /api/context/panic/
        // wipe` — so the audit + lock semantics match either entry point.
        // A confirm dialog gates the action because there's no undo.
        label: 'Wipe captures (irreversible)…',
        click: () => {
          void confirmAndRunWipe(getMainWindow);
        },
      },
      { type: 'separator' },
      {
        label: 'About TaskPilot',
        click: () =>
          sendCommand(getMainWindow, {
            kind: 'navigate',
            path: '/settings?tab=about',
          }),
      },
      {
        label: 'Quit TaskPilot',
        click: () => {
          app.quit();
        },
      },
    ];

    return Menu.buildFromTemplate(template);
  };

  const refresh = (): void => {
    try {
      tray.setContextMenu(buildMenu());
      const coworkCount = countCoworkWaiting();
      const tooltip =
        coworkCount > 0
          ? `${TOOLTIP} — ${coworkCount} cowork waiting`
          : TOOLTIP;
      tray.setToolTip(tooltip);
    } catch {
      /* tray may already be destroyed */
    }
  };

  refresh();

  // Re-poll the cowork count every 30s so the tooltip + menu line update
  // without forcing the user to right-click the tray.
  const coworkPoll = setInterval(refresh, COWORK_REFRESH_MS);
  // Unref so a stranded interval can't keep the Electron app alive on quit.
  if (typeof coworkPoll === 'object' && coworkPoll && 'unref' in coworkPoll) {
    (coworkPoll as { unref: () => void }).unref();
  }

  // On Windows/Linux a left-click on the icon should show/focus the window.
  // macOS leaves the click for the menu — left-click already opens it.
  if (process.platform !== 'darwin') {
    tray.on('click', () => {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (win.isVisible()) {
        win.focus();
      } else {
        win.show();
        win.focus();
      }
    });
  }

  // Ensure the icon is removed before quit so Windows doesn't leak a ghost
  // entry in the system tray area.
  const onBeforeQuit = (): void => {
    try {
      tray.destroy();
    } catch {
      /* already destroyed */
    }
  };
  app.on('before-quit', onBeforeQuit);

  const destroy = (): void => {
    app.off('before-quit', onBeforeQuit);
    try {
      clearInterval(coworkPoll);
    } catch {
      /* non-fatal */
    }
    try {
      tray.destroy();
    } catch {
      /* already destroyed */
    }
  };

  return { destroy, refresh, _tray: tray };
}
