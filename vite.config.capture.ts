/**
 * Vite config for the standalone quick-capture window.
 *
 * The capture window is a separate Electron BrowserWindow with its own React
 * tree (no router, no React Query, no shadcn UI). Building it in a dedicated
 * Vite invocation keeps the main renderer bundle clean and lets the capture
 * shell paint instantly when the hotkey fires.
 *
 * Output:
 *   dist/renderer-capture/
 *     index.html         (Vite-rewritten with hashed asset paths)
 *     assets/...         (JS + CSS bundles)
 *
 * Why a second config (not a Rollup multi-input):
 *   The capture renderer has a fully separate HTML entry. Treating it as a
 *   second `input` in the main config produces an `index.html` collision in
 *   `dist/renderer/`. Two configs = two output trees, no collision.
 *
 * Packaging: `electron-builder.json` includes `dist/**\/*` so this output
 * ships alongside the main renderer. At runtime,
 * `src/main/capture-window.ts` loads `dist/capture/index.html` via a
 * post-build copy hook (see scripts/copy-capture.ts) so the path is stable
 * regardless of whether the file is loaded from `dist/renderer-capture/`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  // Root at the capture HTML so Vite resolves the entry correctly.
  root: path.resolve(__dirname, 'src/renderer/capture'),
  build: {
    outDir: path.resolve(__dirname, 'dist/capture'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/capture/index.html'),
    },
  },
  resolve: {
    alias: {
      // Mirror the main renderer aliases so capture code can import from
      // shared if it ever needs to (today: no such imports).
      '@/shared': path.resolve(__dirname, 'src/shared'),
      '@/renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
