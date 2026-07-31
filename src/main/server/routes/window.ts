/**
 * `/api/window/*` routes — main-window focus helpers.
 *
 * Used by the Chrome extension popup's "Open Watch view" button. The extension
 * pings `/api/health` first; on success it POSTs `/api/window/focus` here,
 * which restores + focuses the first BrowserWindow.
 *
 * When the server is running outside Electron (`npm run server`, tests, MCP)
 * there's no window to focus; the route returns `{ ok: true, focused: false,
 * reason: 'no_electron' }` so the popup can still distinguish "the API is up
 * but nothing visible" from "the API is down".
 *
 * Mounted by `server/index.ts`:
 *     app.use('/api/window', windowRouter());
 */

import { Router } from 'express';

import type { WindowFocusResponse } from '@/shared/api-contract';

import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Electron access                                                           */
/* -------------------------------------------------------------------------- */

interface BrowserWindowLike {
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  isDestroyed?: () => boolean;
}

interface ElectronShape {
  BrowserWindow?: {
    getAllWindows: () => BrowserWindowLike[];
  };
}

/**
 * Load Electron only when running inside the main process. Outside Electron
 * (standalone server, MCP, tests) this returns `null` and the route degrades
 * gracefully.
 */
function loadElectron(): ElectronShape | null {
  if (
    typeof process === 'undefined' ||
    !process.versions ||
    !process.versions.electron
  ) {
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('electron') as ElectronShape;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function windowRouter(): Router {
  const router = Router();

  router.post(
    '/focus',
    asyncHandler(async (_req, res) => {
      const electron = loadElectron();
      if (!electron?.BrowserWindow) {
        const body: WindowFocusResponse = {
          ok: true,
          focused: false,
          reason: 'no_electron',
        };
        res.json(body);
        return;
      }

      const windows = electron.BrowserWindow.getAllWindows().filter(
        (win) => !(win.isDestroyed?.() ?? false),
      );
      const target = windows[0];
      if (!target) {
        const body: WindowFocusResponse = {
          ok: true,
          focused: false,
          reason: 'no_window',
        };
        res.json(body);
        return;
      }

      try {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      } catch {
        // Best-effort — a failed focus is non-fatal; the user can still
        // alt-tab to the app. Don't surface it as a 500.
        const body: WindowFocusResponse = {
          ok: true,
          focused: false,
          reason: 'focus_failed',
        };
        res.json(body);
        return;
      }

      const body: WindowFocusResponse = { ok: true, focused: true };
      res.json(body);
    }),
  );

  return router;
}
