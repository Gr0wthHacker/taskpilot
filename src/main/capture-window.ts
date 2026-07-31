/**
 * Quick-capture window.
 *
 * A small, frameless, always-on-top Electron BrowserWindow used by the global
 * hotkey to let Jack jot a task title (+ optional description) without opening
 * the main TaskPilot UI. The window:
 *
 *   - Is 480×140 px, no title bar, frameless, always-on-top, centered on the
 *     active screen.
 *   - Closes on blur OR Escape OR submit (handled in the renderer).
 *   - Loads a separate Vite-built HTML (capture/index.html) so the main
 *     RouterProvider / KeyboardShortcuts plumbing doesn't have to mount.
 *
 * The submit flow runs over the same IPC bridge as the main window: the
 * renderer sends `tp:capture:submit { title, description? }`; the main
 * process turns it into a `POST /api/tasks` and forwards the toast notice to
 * the (possibly minimized) main window.
 *
 * Lifecycle:
 *
 *   - Window is created lazily on first hotkey press.
 *   - We don't destroy on blur — we `hide()` so subsequent toggles are
 *     instantaneous. The window is destroyed on app quit.
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const _filename =
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

const isDev =
  process.env.NODE_ENV !== 'production' && !process.env.ELECTRON_PROD;

/* -------------------------------------------------------------------------- */
/*  State                                                                     */
/* -------------------------------------------------------------------------- */

let captureWindow: BrowserWindow | null = null;

/* -------------------------------------------------------------------------- */
/*  Construction                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the capture window. Caller is responsible for showing / focusing it;
 * we return it ready to load but `show: false` so the first paint doesn't
 * flash before the input is focused.
 *
 * The window shares the same `preload.cjs` as the main window so the renderer
 * has access to `window.taskpilot` (config + bridge). Capture-specific
 * functionality lives behind a separate IPC channel (`tp:capture:submit`).
 */
export function createCaptureWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;
  const winW = 480;
  const winH = 140;

  const win = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.round((screenW - winW) / 2) + display.workArea.x,
    // Position slightly above center so the user's eyes land on the input
    // without having to scan down.
    y: Math.round((screenH - winH) / 3) + display.workArea.y,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // Vibrancy / corner radius is platform-specific; defaults are fine.
    webPreferences: {
      preload: path.join(_dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Don't let any in-page navigation steal the window. The capture renderer
  // never navigates by itself but defense in depth is cheap.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Hide on blur. Don't destroy — recreating the BrowserWindow on every
  // hotkey press would feel laggy.
  win.on('blur', () => {
    if (!win.isDestroyed()) win.hide();
  });

  win.on('closed', () => {
    if (captureWindow === win) captureWindow = null;
  });

  if (isDev) {
    // In dev the main Vite server serves the capture HTML at the same
    // root the main renderer uses. Vite resolves `/src/renderer/capture/`
    // because the project root includes that directory.
    const devUrl =
      (process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173') +
      '/src/renderer/capture/index.html';
    void win.loadURL(devUrl);
  } else {
    // Packaged path — produced by `vite build -c vite.config.capture.ts`.
    // Both `dist/main.cjs` and `dist/capture/` live under `dist/`, so the
    // path resolves relative to `_dirname` (which is `dist/`).
    const captureIndex = path.join(_dirname, 'capture', 'index.html');
    void win.loadURL(pathToFileURL(captureIndex).toString());
  }

  return win;
}

/* -------------------------------------------------------------------------- */
/*  Lifecycle helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Lazily create the capture window if it doesn't exist (or was destroyed).
 * Always returns a live BrowserWindow. The `getMainWindow` is passed in case
 * a future enhancement wants to position relative to the main app — unused
 * today but kept on the signature so the global-shortcut module stays
 * decoupled from screen geometry.
 */
export function ensureCaptureWindow(
  // Reserved for future positioning relative to the main window — kept on
  // the signature so callers don't need to refactor when we wire it up.
  _getMainWindow: () => BrowserWindow | null,
): BrowserWindow {
  if (captureWindow && !captureWindow.isDestroyed()) return captureWindow;
  captureWindow = createCaptureWindow();
  return captureWindow;
}

/**
 * Reveal the window and move keyboard focus to it. Re-centers each time so
 * if the user changed monitors the popup follows the active display.
 */
export function showCaptureWindow(win?: BrowserWindow): void {
  const target = win ?? captureWindow;
  if (!target || target.isDestroyed()) return;

  // Re-center on the currently focused display (which may differ from
  // the primary if Jack has the cursor on a second monitor).
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const [winW, winH] = target.getSize();
  const x = Math.round((display.workAreaSize.width - winW) / 2) + display.workArea.x;
  const y = Math.round((display.workAreaSize.height - winH) / 3) + display.workArea.y;
  target.setPosition(x, y);

  target.show();
  target.focus();
  // Send a focus signal to the renderer so it can clear stale input and
  // refocus the first field.
  try {
    target.webContents.send('tp:capture:focus');
  } catch {
    /* renderer not ready yet — first show() will paint and onload runs autofocus */
  }
}

/** Hide (but don't destroy) the window. */
export function hideCaptureWindow(): void {
  if (captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible()) {
    captureWindow.hide();
  }
}

export function isCaptureWindowVisible(): boolean {
  return Boolean(
    captureWindow && !captureWindow.isDestroyed() && captureWindow.isVisible(),
  );
}

/** Destroy the window. Called from `before-quit`. */
export function destroyCaptureWindow(): void {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.destroy();
  }
  captureWindow = null;
}

/** Used by IPC to dispatch the "captured" toast back to the renderer. */
export function getCaptureWindow(): BrowserWindow | null {
  if (captureWindow && !captureWindow.isDestroyed()) return captureWindow;
  return null;
}
