/**
 * Global quick-capture hotkey.
 *
 * Registers an Electron `globalShortcut` that pops up the lightweight capture
 * window from anywhere on the machine — TaskPilot doesn't need to be focused
 * (or even visible) to use it.
 *
 * Default keybind: `CommandOrControl+Shift+Space`. Configurable via the
 * `quick_capture_hotkey` setting (accelerator string per Electron's
 * `globalShortcut.register()` format). If the configured combo is already
 * claimed by another app, we fall back to `CommandOrControl+Shift+T`.
 *
 * Toggle semantics: pressing the hotkey while the capture window is visible
 * hides it; pressing while hidden shows it and focuses the input.
 */

import { app, BrowserWindow, globalShortcut } from 'electron';

import { ensureCaptureWindow, hideCaptureWindow, isCaptureWindowVisible, showCaptureWindow } from './capture-window';

/** Default hotkey when no override is configured. */
export const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

/** Used when the configured combo can't be registered (already taken). */
export const FALLBACK_HOTKEY = 'CommandOrControl+Shift+T';

/** Setting key persisted in the settings table. */
export const HOTKEY_SETTING_KEY = 'quick_capture_hotkey';

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let registeredAccelerator: string | null = null;

/* -------------------------------------------------------------------------- */
/*  Settings access                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read the persisted hotkey override. Returns null when the setting is
 * unset or the settings module can't be loaded (DB not initialized yet).
 * Settings live in the local SQLite DB; the renderer can rewrite the value
 * via the `/api/settings/:key` endpoint.
 */
async function readConfiguredHotkey(): Promise<string | null> {
  try {
    const mod = (await import('@/main/db/repositories/settings')) as {
      settingsRepository?: { get: (key: string) => unknown };
    };
    const repo = mod.settingsRepository;
    if (!repo) return null;
    const raw = repo.get(HOTKEY_SETTING_KEY);
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
    return null;
  } catch {
    // DB not ready / settings missing — fall back to default.
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Toggle handler                                                            */
/* -------------------------------------------------------------------------- */

function toggleCaptureWindow(getMainWindow: () => BrowserWindow | null): void {
  if (isCaptureWindowVisible()) {
    hideCaptureWindow();
    return;
  }
  const win = ensureCaptureWindow(getMainWindow);
  showCaptureWindow(win);
}

/* -------------------------------------------------------------------------- */
/*  Registration                                                              */
/* -------------------------------------------------------------------------- */

interface RegisterOptions {
  /** Resolves to the live main window so the capture window can position relative to it. */
  getMainWindow: () => BrowserWindow | null;
}

export interface GlobalShortcutHandle {
  /** The accelerator string actually registered (may differ from the requested one if the fallback fired). */
  accelerator: string | null;
  /** Tear down the registration. Safe to call multiple times. */
  unregister: () => void;
}

/**
 * Register the global quick-capture hotkey. Reads the override from settings;
 * falls back to {@link DEFAULT_HOTKEY}. If both the configured and default
 * combos are taken, retries {@link FALLBACK_HOTKEY}; if even that fails the
 * handle reports `accelerator: null` and logs a warning.
 */
export async function registerGlobalShortcut(
  options: RegisterOptions,
): Promise<GlobalShortcutHandle> {
  // Detach any prior registration so a recreate-on-fly doesn't double-bind.
  unregisterGlobalShortcut();

  const configured = await readConfiguredHotkey();
  const candidates: string[] = [];
  if (configured && configured !== DEFAULT_HOTKEY) candidates.push(configured);
  candidates.push(DEFAULT_HOTKEY);
  if (!candidates.includes(FALLBACK_HOTKEY)) candidates.push(FALLBACK_HOTKEY);

  const handler = (): void => {
    try {
      toggleCaptureWindow(options.getMainWindow);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[taskpilot] global shortcut handler threw:', err);
    }
  };

  for (const accel of candidates) {
    try {
      const ok = globalShortcut.register(accel, handler);
      if (ok) {
        registeredAccelerator = accel;
        if (configured && accel !== configured) {
          // eslint-disable-next-line no-console
          console.warn(
            `[taskpilot] configured quick-capture hotkey "${configured}" was unavailable; using "${accel}" instead`,
          );
        } else {
          // eslint-disable-next-line no-console
          console.log(`[taskpilot] quick-capture hotkey registered: ${accel}`);
        }
        break;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[taskpilot] failed to register hotkey "${accel}":`,
        (err as Error).message,
      );
    }
  }

  if (!registeredAccelerator) {
    // eslint-disable-next-line no-console
    console.warn(
      '[taskpilot] no global quick-capture hotkey could be registered',
    );
  }

  return {
    accelerator: registeredAccelerator,
    unregister: unregisterGlobalShortcut,
  };
}

/** Tear down the active registration. Safe to call when nothing is registered. */
export function unregisterGlobalShortcut(): void {
  if (!registeredAccelerator) return;
  try {
    globalShortcut.unregister(registeredAccelerator);
  } catch {
    /* already gone */
  }
  registeredAccelerator = null;
}

/**
 * Unregister every global shortcut for this app. Use during `will-quit` —
 * safer than relying on Electron's auto-cleanup if the app crashes mid-quit.
 */
export function unregisterAllGlobalShortcuts(): void {
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* nothing to do */
  }
  registeredAccelerator = null;
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

/** Inspect what we currently have bound. Used by Settings → General. */
export function getRegisteredAccelerator(): string | null {
  return registeredAccelerator;
}

// Touch `app` so a future "rebind via menu" hookup has a stable import to
// hang off. Currently unused at runtime.
void app;
