/**
 * `/api/claude-runner` — status, force-run, and CLI probe.
 *
 * The runner module owns its own loop; this router is purely the renderer's
 * window into it. Settings changes happen via `/api/settings/<key>` like
 * everything else; this router doesn't write settings.
 */

import { spawn } from 'node:child_process';

import { Router } from 'express';

import { getRunnerHandle } from '@/main/claude-runner';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/**
 * Try the configured command's first argv token. If it spawns at all (any
 * exit code, even non-zero), it's installed; if it ENOENTs, it's missing.
 * 1.5s timeout so this never blocks a renderer refresh.
 */
async function probeProgram(program: string): Promise<{ found: boolean; error?: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { found: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawn(program, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        finish({ found: true }); // it spawned, so the binary exists
      }, 1_500);
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ found: false, error: err.message });
      });
      child.on('exit', () => {
        clearTimeout(timer);
        finish({ found: true });
      });
    } catch (err: unknown) {
      finish({
        found: false,
        error: err instanceof Error ? err.message : 'spawn threw',
      });
    }
  });
}

export function claudeRunnerRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const handle = getRunnerHandle();
      if (!handle) {
        res.json({ enabled: false, running: false, available: false });
        return;
      }
      const status = handle.status();
      // Probe whether the configured program exists on PATH. Cheap-ish.
      const program = status.command.split(/\s+/)[0] ?? '';
      const probe = program ? await probeProgram(program) : { found: false };
      res.json({
        ...status,
        program,
        available: probe.found,
        probe_error: probe.error ?? null,
      });
    }),
  );

  router.post(
    '/run-now',
    asyncHandler(async (_req, res) => {
      const handle = getRunnerHandle();
      if (!handle) {
        throw new ApiHttpError(503, 'runner_unavailable', 'Runner not booted');
      }
      const result = await handle.runNow();
      res.json({ ok: true, last_run: result });
    }),
  );

  // Hook the renderer can call after a settings change to apply the new
  // interval immediately.
  router.post(
    '/refresh',
    asyncHandler(async (_req, res) => {
      const handle = getRunnerHandle();
      if (!handle) {
        throw new ApiHttpError(503, 'runner_unavailable', 'Runner not booted');
      }
      handle.refresh();
      res.json({ ok: true });
    }),
  );

  return router;
}
