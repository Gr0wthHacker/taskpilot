/**
 * Auto-launch on login.
 *
 * Thin wrapper around Electron's `app.setLoginItemSettings` so the renderer
 * can toggle "open at login" via a normal HTTP setting. The user preference
 * is persisted as the `auto_launch_enabled` setting; on every main-process
 * boot we enforce that preference against the OS via {@link applyAutoLaunch}.
 *
 * Why not IPC? Wave 7D is also wiring IPC channels, so to avoid stepping on
 * those handlers we surface this purely as an HTTP endpoint (see
 * `src/main/server/routes/data.ts`). The settings repository is the single
 * source of truth — the OS state is reconciled to match on each boot, not
 * the other way around.
 *
 * Behavior is a no-op when not running inside Electron (e.g. when the
 * standalone server is started for tests / CLI). `app` is optional-required
 * via a dynamic import so importing this module never blows up in a Node-only
 * context.
 */

import { settingsRepository } from '@/main/db/repositories/settings';

const SETTING_KEY = 'auto_launch_enabled';

interface ElectronAppLike {
  setLoginItemSettings: (settings: {
    openAtLogin: boolean;
    openAsHidden?: boolean;
  }) => void;
  getLoginItemSettings: () => { openAtLogin: boolean };
}

/**
 * Lazily resolve Electron's `app` module. Returns null when not running
 * inside an Electron main process — callers should degrade silently in
 * that case (the renderer/server still load the route; the toggle just
 * won't change OS state on a non-Electron host).
 */
function getElectronApp(): ElectronAppLike | null {
  // Electron is only available in the main process. In tests / standalone
  // server contexts the import will throw or return an empty shape; both
  // paths land us in the `null` branch.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: unknown };
    const app = electron.app as ElectronAppLike | undefined;
    if (
      app &&
      typeof app.setLoginItemSettings === 'function' &&
      typeof app.getLoginItemSettings === 'function'
    ) {
      return app;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Set the OS-level login item state. Safe to call on any platform —
 * Electron handles the win32 / darwin / linux differences internally.
 *
 * Always called with `openAsHidden: false` so the user sees a familiar
 * launch on login, not a hidden background process. The hidden variant
 * is only useful for tray-only apps; TaskPilot's main window is the
 * primary surface.
 */
export function setAutoLaunch(enabled: boolean): void {
  const app = getElectronApp();
  if (!app) return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false });
}

/**
 * Read the OS-level state. Returns `false` outside Electron.
 */
export function getAutoLaunchEnabled(): boolean {
  const app = getElectronApp();
  if (!app) return false;
  try {
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch {
    return false;
  }
}

/**
 * Read the persisted preference. Defaults to `false` when the setting has
 * never been written.
 */
export function getStoredAutoLaunchPreference(): boolean {
  const raw = settingsRepository.get<unknown>(SETTING_KEY);
  if (raw === true) return true;
  if (typeof raw === 'string') return raw === 'true' || raw === '1';
  if (typeof raw === 'number') return raw === 1;
  return false;
}

/**
 * Persist the preference AND reconcile OS state to match. Returns the new
 * effective state — usually identical to `enabled`, but on non-Electron
 * hosts where `setAutoLaunch` is a no-op we still write the setting so the
 * next real launch picks it up.
 */
export function updateAutoLaunch(enabled: boolean): boolean {
  settingsRepository.set(SETTING_KEY, enabled);
  setAutoLaunch(enabled);
  return enabled;
}

/**
 * Boot-time helper: read the persisted preference and push it back into the
 * OS. Called from `src/main/main.ts` once the app is ready so any drift
 * (user toggled the same setting via OS preferences, or we just installed
 * an update) is reconciled.
 *
 * Swallows DB / Electron unavailability so a boot path that hasn't fully
 * initialized the persistence layer (tests, standalone server) doesn't
 * crash the server. The OS state simply stays as-is until a later toggle.
 */
export function applyAutoLaunchOnBoot(): void {
  try {
    const pref = getStoredAutoLaunchPreference();
    setAutoLaunch(pref);
  } catch {
    /* DB not ready yet — defer to the next explicit toggle. */
  }
}

export const AUTO_LAUNCH_SETTING_KEY = SETTING_KEY;
