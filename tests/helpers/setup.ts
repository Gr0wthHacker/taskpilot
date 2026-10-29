/**
 * Global vitest setup. Runs once per worker before any tests in that worker.
 *
 * - Re-routes TASKPILOT_HOME to a per-worker temp directory so tests never
 *   touch the user's real `~/.taskpilot`.
 *
 * Note: `src/shared/constants.ts` reads `os.homedir()` at module load time, so
 * a plain env var won't redirect those constants. Tests that need redirected
 * paths must `vi.mock('@/shared/constants', ...)` themselves before importing
 * any module that pulls in constants. This setup file enforces the env-var
 * baseline and provides shared helpers.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const TEST_HOME = path.join(
  os.tmpdir(),
  `taskpilot-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

if (!fs.existsSync(TEST_HOME)) {
  fs.mkdirSync(TEST_HOME, { recursive: true });
}

process.env.TASKPILOT_TEST_HOME = TEST_HOME;
process.env.TASKPILOT_HOME = path.join(TEST_HOME, '.taskpilot');

// Disable bearer-token + host-header checks for the existing integration
// suites, which fetch the in-process API directly without supplying auth.
// The dedicated `tests/api-auth.test.ts` builds the middleware standalone
// to exercise the real auth path. See `src/main/server/middleware/auth.ts`.
process.env.TASKPILOT_DISABLE_AUTH = '1';
// Keep the hourly renewal engine (T704) out of route integration runs.
process.env.TASKPILOT_DISABLE_RENEWALS = '1';
