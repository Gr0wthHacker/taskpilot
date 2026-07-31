/**
 * API server roundtrip + CLI smoke test.
 *
 * Boots `startApiServer()` in-process against a mocked TaskPilot home + an
 * in-memory DB, then exercises:
 *
 *   - Direct fetch against the API: GET /api/health, /api/config, /api/tasks,
 *     POST /api/tasks, 404 envelope.
 *   - The built CLI (`dist/cli/index.js`) talking to that same in-process
 *     server: help, friendly connection error, and `task list --json` roundtrip.
 *
 * Both halves share a single API server boot so they don't fight over
 * port 7847. The CLI test is skipped if `dist/cli/index.js` doesn't exist
 * (fresh checkout without `npm run build`).
 *
 * NOTE: The CLI is spawned asynchronously (not `spawnSync`) — blocking the
 * event loop with `spawnSync` would deadlock the subprocess's HTTP request
 * back to the in-process server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

mockTaskpilotPaths();

import { startApiServer, type ApiServerHandle } from '@/main/server';
import { API_PORT } from '@/shared/constants';
import type {
  ConfigResponse,
  HealthResponse,
  ListTasksResponse,
  Task,
} from '@/shared/api-contract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
const HAS_BUILT_CLI = fs.existsSync(CLI_PATH);

interface CliResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 12_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const finalize = (status: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `CLI timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => finalize(code));
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

let handle: ApiServerHandle;
let baseUrl: string;

// Hoisted so BOTH the API-roundtrip and CLI describe blocks share one mocked
// DB — without this, the CLI test would hit `getDb() called before mock-db
// beforeEach` when it issues a request.
useMockedDb();

// File-scoped server lifecycle so both describe blocks share one boot. If we
// scoped these to the first describe, its afterAll would stop the server
// before the CLI describe runs.
beforeAll(async () => {
  // Vitest can fork multiple test files in parallel, and two test files
  // (this one and tests/server/routes-tasks.test.ts) both bind port 7847.
  // Retry briefly on EADDRINUSE so both suites coexist.
  let lastErr: unknown = null;
  for (let i = 0; i < 30; i += 1) {
    try {
      handle = await startApiServer();
      break;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!handle) {
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Could not bind API server after retries');
  }
  baseUrl = `http://127.0.0.1:${handle.port}`;
}, 30_000);

afterAll(async () => {
  if (handle) {
    await Promise.race([
      handle.stop(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}, 30_000);

describe('api roundtrip', () => {
  it('uses the configured API port', () => {
    expect(handle.port).toBe(API_PORT);
  });

  it('GET /api/health returns { ok: true, version }', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('GET /api/config returns paths + api_port', async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(body.api_port).toBe(API_PORT);
    expect(typeof body.paths.home).toBe('string');
    expect(typeof body.paths.db).toBe('string');
    // Mocked paths route into tmpdir — never the real ~/.taskpilot.
    expect(body.paths.io.root).toContain('taskpilot-mocked-');
  });

  it('GET /api/tasks returns an empty list envelope', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListTasksResponse;
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it('POST /api/tasks creates a task and round-trips through GET /api/tasks', async () => {
    const postRes = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'integration test task',
        priority: 'p1',
      }),
    });
    expect(postRes.status).toBeLessThan(400);
    const created = (await postRes.json()) as Task | { task: Task };
    const task = 'task' in created ? created.task : created;
    expect(task.title).toBe('integration test task');
    expect(task.priority).toBe('p1');
    expect(typeof task.id).toBe('string');

    const listRes = await fetch(`${baseUrl}/api/tasks`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ListTasksResponse;
    const titles = list.tasks.map((t) => t.title);
    expect(titles).toContain('integration test task');
  });

  it('returns a canonical error envelope for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error?: { code: string; message: string };
    };
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe('route_not_found');
    expect(typeof body.error?.message).toBe('string');
  });
});

describe.skipIf(!HAS_BUILT_CLI)('cli smoke (against the in-process API)', () => {
  it('prints --help without crashing', async () => {
    const out = await runCli(['--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('taskpilot');
    expect(out.stdout).toContain('task');
    expect(out.stdout).toContain('cal');
  });

  it('returns a friendly connection error when API is unreachable', async () => {
    const out = await runCli(
      ['--api', 'http://127.0.0.1:1', 'task', 'list'],
      // Avoid any inherited TASKPILOT_API leaking in.
      { TASKPILOT_API: '' },
    );
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toMatch(/Cannot reach TaskPilot API/);
    expect(out.stderr + out.stdout).toMatch(/npm run server/);
  });

  it('task list --json returns valid JSON against the live API', async () => {
    // --json is a global flag, declared before the subcommand.
    const out = await runCli(['--json', '--api', baseUrl, 'task', 'list']);
    expect(out.status).toBe(0);
    const trimmed = out.stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    // The CLI unwraps the envelope, so the output is a bare array of tasks.
    const parsed = JSON.parse(trimmed) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });
});
