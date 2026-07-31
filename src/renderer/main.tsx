import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyStoredTheme } from './lib/theme-boot';
import { hydrateWorkspacesFromSettings } from './lib/workspace-boot';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

/**
 * Boot-time side effects.
 *
 * `applyStoredTheme()` reads the persisted theme setting and toggles the
 * `dark` class on `<html>` BEFORE React renders, so the initial paint
 * matches the user's choice — otherwise we'd flash whatever class
 * `index.html` shipped with (currently `dark`). It's safe to fire-and-
 * forget; the call gracefully degrades to "system" when the server is
 * unreachable.
 *
 * `hydrateWorkspacesFromSettings()` pulls the persisted workspace list out
 * of the `workspaces` setting key and seeds the Zustand store with it.
 */
void applyStoredTheme();
void hydrateWorkspacesFromSettings();

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
