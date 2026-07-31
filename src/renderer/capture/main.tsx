/**
 * Capture-window React entry.
 *
 * Mounts the {@link CaptureWindow} form inside the capture-only HTML shell.
 * This bundle is built separately from the main renderer (see
 * `vite.config.capture.ts`) so the capture window doesn't pull in
 * React Router, React Query, or any of the main app's state machinery.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';

import { CaptureWindow } from './CaptureWindow';
import './capture.css';

const rootEl = document.getElementById('capture-root');
if (!rootEl) {
  throw new Error('Root element #capture-root not found in capture/index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <CaptureWindow />
  </React.StrictMode>,
);
