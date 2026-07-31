/**
 * Path-mocking helper for tests that touch `@/shared/constants` paths.
 *
 * `src/shared/constants.ts` reads `os.homedir()` at import time, so any test
 * that needs the IO_* / TASKPILOT_HOME paths redirected must `vi.mock` the
 * constants module. This helper centralises that boilerplate.
 *
 * Usage:
 *
 *   // tests/io/something.test.ts
 *   import { mockTaskpilotPaths } from '../helpers/mock-paths';
 *   const PATHS = mockTaskpilotPaths();
 *   // ...then import { ... } from '@/main/io/...';
 *
 * The returned `PATHS` object exposes every directory so tests can write
 * fixtures directly.
 */

import { vi } from 'vitest';

export interface MockedTaskpilotPaths {
  TEST_HOME: string;
  TASKPILOT_HOME: string;
  IO_ROOT: string;
  IO_INBOX: string;
  IO_DERIVE: string;
  IO_DERIVED: string;
  IO_EXECUTE: string;
  IO_RESULTS: string;
  IO_REVIEW: string;
  IO_CONTEXT: string;
  IO_DELIBERATE: string;
  IO_DELIBERATED: string;
  IO_DONE_ARCHIVE_DELIBERATE: string;
  IO_SUMMARIZE: string;
  IO_SUMMARIZED: string;
  IO_DONE_ARCHIVE_SUMMARIZE: string;
  IO_INVALID: string;
  LOGS_DIR: string;
  BACKUPS_DIR: string;
  TELEMETRY_LOG_PATH: string;
  DB_PATH: string;
  CREDS_PATH: string;
  ATTACHMENTS_DIR: string;
  CAPTURES_DIR: string;
  AUDIT_DIR: string;
  REQUIRED_DIRS: string[];
}

/**
 * Build a tmp root and call `vi.mock('@/shared/constants', ...)` with paths
 * derived from it. Must be called at module scope (not inside `describe` /
 * `beforeAll`) so the mock factory runs before any subsequent imports.
 *
 * The mock factory uses `vi.hoisted` under the hood so it executes before
 * the in-module `import` statements that pull `@/main/io/*` etc.
 */
export function mockTaskpilotPaths(): MockedTaskpilotPaths {
  const paths = vi.hoisted(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ph = require('node:path') as typeof import('node:path');

    const TEST_HOME = fs.mkdtempSync(ph.join(os.tmpdir(), 'taskpilot-mocked-'));
    const TASKPILOT_HOME = ph.join(TEST_HOME, '.taskpilot');
    const IO_ROOT = ph.join(TASKPILOT_HOME, 'io');
    const IO_INBOX = ph.join(IO_ROOT, 'inbox');
    const IO_DERIVE = ph.join(IO_ROOT, 'derive');
    const IO_DERIVED = ph.join(IO_ROOT, 'derived');
    const IO_EXECUTE = ph.join(IO_ROOT, 'execute');
    const IO_RESULTS = ph.join(IO_ROOT, 'results');
    const IO_REVIEW = ph.join(IO_ROOT, 'review');
    const IO_CONTEXT = ph.join(IO_ROOT, 'context');
    const IO_DELIBERATE = ph.join(IO_ROOT, 'deliberate');
    const IO_DELIBERATED = ph.join(IO_ROOT, 'deliberated');
    const IO_DONE_ARCHIVE_DELIBERATE = ph.join(
      IO_ROOT,
      '_done-archive',
      'deliberate',
    );
    const IO_SUMMARIZE = ph.join(IO_ROOT, 'summarize');
    const IO_SUMMARIZED = ph.join(IO_ROOT, 'summarized');
    const IO_DONE_ARCHIVE_SUMMARIZE = ph.join(
      IO_ROOT,
      '_done-archive',
      'summarize',
    );
    const IO_INVALID = ph.join(IO_ROOT, '_invalid');
    const LOGS_DIR = ph.join(TASKPILOT_HOME, 'logs');
    const BACKUPS_DIR = ph.join(TASKPILOT_HOME, 'backups');
    const TELEMETRY_LOG_PATH = ph.join(LOGS_DIR, 'telemetry.jsonl');
    const DB_PATH = ph.join(TASKPILOT_HOME, 'taskpilot.db');
    const CREDS_PATH = ph.join(TASKPILOT_HOME, 'credentials.json');
    const ATTACHMENTS_DIR = ph.join(TASKPILOT_HOME, 'attachments');
    const CAPTURES_DIR = ph.join(TASKPILOT_HOME, 'captures');
    const AUDIT_DIR = ph.join(TASKPILOT_HOME, 'audit');
    const REQUIRED_DIRS: string[] = [
      TASKPILOT_HOME,
      LOGS_DIR,
      BACKUPS_DIR,
      IO_ROOT,
      IO_INBOX,
      IO_DERIVE,
      IO_DERIVED,
      IO_EXECUTE,
      IO_RESULTS,
      IO_REVIEW,
      IO_CONTEXT,
      IO_DELIBERATE,
      IO_DELIBERATED,
      IO_DONE_ARCHIVE_DELIBERATE,
      IO_SUMMARIZE,
      IO_SUMMARIZED,
      IO_DONE_ARCHIVE_SUMMARIZE,
      IO_INVALID,
      AUDIT_DIR,
    ];

    for (const d of REQUIRED_DIRS) fs.mkdirSync(d, { recursive: true });

    return {
      TEST_HOME,
      TASKPILOT_HOME,
      IO_ROOT,
      IO_INBOX,
      IO_DERIVE,
      IO_DERIVED,
      IO_EXECUTE,
      IO_RESULTS,
      IO_REVIEW,
      IO_CONTEXT,
      IO_DELIBERATE,
      IO_DELIBERATED,
      IO_DONE_ARCHIVE_DELIBERATE,
      IO_SUMMARIZE,
      IO_SUMMARIZED,
      IO_DONE_ARCHIVE_SUMMARIZE,
      IO_INVALID,
      LOGS_DIR,
      BACKUPS_DIR,
      TELEMETRY_LOG_PATH,
      DB_PATH,
      CREDS_PATH,
      ATTACHMENTS_DIR,
      CAPTURES_DIR,
      AUDIT_DIR,
      REQUIRED_DIRS,
    };
  });

  vi.mock('@/shared/constants', () => ({
    APP_NAME: 'TaskPilot',
    APP_VERSION: '0.1.0-test',
    API_PORT: 7847,
    TASKPILOT_HOME: paths.TASKPILOT_HOME,
    DB_PATH: paths.DB_PATH,
    CREDS_PATH: paths.CREDS_PATH,
    LOGS_DIR: paths.LOGS_DIR,
    BACKUPS_DIR: paths.BACKUPS_DIR,
    TELEMETRY_LOG_PATH: paths.TELEMETRY_LOG_PATH,
    IO_ROOT: paths.IO_ROOT,
    IO_INBOX: paths.IO_INBOX,
    IO_DERIVE: paths.IO_DERIVE,
    IO_DERIVED: paths.IO_DERIVED,
    IO_EXECUTE: paths.IO_EXECUTE,
    IO_RESULTS: paths.IO_RESULTS,
    IO_REVIEW: paths.IO_REVIEW,
    IO_CONTEXT: paths.IO_CONTEXT,
    IO_DELIBERATE: paths.IO_DELIBERATE,
    IO_DELIBERATED: paths.IO_DELIBERATED,
    IO_DONE_ARCHIVE_DELIBERATE: paths.IO_DONE_ARCHIVE_DELIBERATE,
    IO_SUMMARIZE: paths.IO_SUMMARIZE,
    IO_SUMMARIZED: paths.IO_SUMMARIZED,
    IO_DONE_ARCHIVE_SUMMARIZE: paths.IO_DONE_ARCHIVE_SUMMARIZE,
    IO_INVALID: paths.IO_INVALID,
    ATTACHMENTS_DIR: paths.ATTACHMENTS_DIR,
    CAPTURES_DIR: paths.CAPTURES_DIR,
    AUDIT_DIR: paths.AUDIT_DIR,
    DEFAULT_ATTACHMENT_MAX_FILE_BYTES: 50 * 1024 * 1024,
    DEFAULT_ATTACHMENT_MAX_TASK_BYTES: 200 * 1024 * 1024,
    REQUIRED_DIRS: paths.REQUIRED_DIRS,
    ensureDirs: () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      for (const dir of paths.REQUIRED_DIRS) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
    },
  }));

  return paths;
}
