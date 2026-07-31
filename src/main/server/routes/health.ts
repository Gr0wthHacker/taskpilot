/**
 * Health and config endpoints.
 *
 * Both are GET-only, never require DB access (config is read entirely from the
 * compiled-in constants), and never fail under normal conditions — so they
 * make good probes for "is the local server alive at all?" from the renderer
 * or CLI.
 */

import { Router } from 'express';

import {
  API_PORT,
  APP_VERSION,
  DB_PATH,
  IO_CONTEXT,
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_INBOX,
  IO_RESULTS,
  IO_REVIEW,
  IO_ROOT,
  LOGS_DIR,
  TASKPILOT_HOME,
} from '@/shared/constants';
import type {
  ConfigResponse,
  HealthResponse,
} from '@/shared/api-contract';

function checkDb(): { ok: boolean; error?: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSqlite } = require('@/main/db') as typeof import('@/main/db');
    const sqlite = getSqlite();
    // Cheapest live probe: query sqlite_master. Synchronous + opens no new
    // connection.
    const row = sqlite
      .prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'")
      .get() as { c: number };
    return { ok: row !== undefined && typeof row.c === 'number' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function checkIntegration(modulePath: string, exportName: string): {
  ok: boolean;
  error?: string;
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(modulePath) as Record<string, unknown>;
    const fn = mod[exportName];
    if (typeof fn !== 'function') return { ok: false, error: 'no such export' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function healthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    const body: HealthResponse = { ok: true, version: APP_VERSION };
    res.json(body);
  });

  /**
   * Extended health probe. Returns subsystem status so monitoring scripts
   * can distinguish "running" from "running but broken." Each check is
   * cheap and synchronous — a slow probe defeats the purpose. Status codes:
   *   - 200 when every subsystem reports ok
   *   - 503 when any required subsystem is unhealthy
   */
  router.get('/health/full', (_req, res) => {
    const db = checkDb();
    const calendar = checkIntegration('@/main/calendar', 'getOauthClient');
    const github = checkIntegration('@/main/github', 'getOctokit');
    const ambient = checkIntegration('@/main/monitor', 'startMonitor');
    const allOk = db.ok;
    const body = {
      ok: allOk,
      version: APP_VERSION,
      at: new Date().toISOString(),
      subsystems: {
        db,
        calendar,
        github,
        ambient,
      },
    };
    res.status(allOk ? 200 : 503).json(body);
  });

  router.get('/config', (_req, res) => {
    const body: ConfigResponse = {
      version: APP_VERSION,
      api_port: API_PORT,
      paths: {
        home: TASKPILOT_HOME,
        db: DB_PATH,
        logs: LOGS_DIR,
        io: {
          root: IO_ROOT,
          inbox: IO_INBOX,
          derive: IO_DERIVE,
          derived: IO_DERIVED,
          execute: IO_EXECUTE,
          results: IO_RESULTS,
          review: IO_REVIEW,
          context: IO_CONTEXT,
        },
      },
    };
    res.json(body);
  });

  return router;
}
