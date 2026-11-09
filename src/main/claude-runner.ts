/**
 * Auto-runner — spawn a configured CLI on an interval to drain the queue.
 *
 * Mental model:
 *  - TaskPilot writes execute requests to `~/.taskpilot/io/execute/*.json`
 *    and flips the task to `agent_status='assigned'`.
 *  - An external runner consumes those files and writes results.
 *  - This module IS that consumer — it shells out on a tick to whatever
 *    command the user configured (default: `claude -p /tp-watch`).
 *
 * Why not bake the API client in? See CLAUDE.md: the app ships with ZERO
 * Anthropic API calls. The "runner" is always external; this module just
 * automates spawning it.
 *
 * Safety:
 *  - Spawn concurrency is 1. We never start a second run while the first
 *    is still going. A run that hangs longer than `claude_runner_timeout_ms`
 *    is killed so the next tick can fire.
 *  - We never shell-interpret the command — `command` is split into argv
 *    by a strict tokenizer (no env-expansion, no globbing).
 *  - Honors `agent_paused` — skips the tick when paused.
 *  - Bounds stdout/stderr capture to 64 KB per stream to keep RAM in check.
 *  - Skips the spawn while every request queue is empty (default `/tp-watch`
 *    command only). Each idle `claude -p` start still loads Claude Code's
 *    system prompt, tools and CLAUDE.md and runs at least one model turn, so a
 *    60 s tick on an empty queue burned ~1,440 headless runs a day. A
 *    heartbeat run still fires every `claude_runner_idle_heartbeat_ms`
 *    (30 min default) in case the skill does periodic work beyond the queues.
 *    `scripts/run-ambient-deliberate.ps1` already short-circuits the same way.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { settingsRepository } from '@/main/db/repositories/settings';
import { isAgentPaused } from '@/main/auto-execute';
import {
  IO_DELIBERATE,
  IO_DERIVE,
  IO_EXECUTE,
  IO_MEMORY_ENRICH,
  IO_SUMMARIZE,
  TASKPILOT_HOME,
} from '@/shared/constants';

/* -------------------------------------------------------------------------- */
/*  Settings keys + defaults                                                  */
/* -------------------------------------------------------------------------- */

export const SETTING_ENABLED = 'claude_runner_enabled';
export const SETTING_COMMAND = 'claude_runner_command';
export const SETTING_INTERVAL_MS = 'claude_runner_interval_ms';
export const SETTING_TIMEOUT_MS = 'claude_runner_timeout_ms';
export const SETTING_WORKDIR = 'claude_runner_workdir';
export const SETTING_LAST_RUN = 'claude_runner_last_run';
export const SETTING_SKIP_WHEN_IDLE = 'claude_runner_skip_when_idle';
export const SETTING_IDLE_HEARTBEAT_MS = 'claude_runner_idle_heartbeat_ms';

const DEFAULT_INTERVAL_MS = 60_000; // every 60s — debounced if a run is in flight
const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 min hard ceiling per run
// Default command: on Windows the `claude` CLI is typically `claude.cmd`;
// on POSIX it's just `claude`. The user can override; this is just a
// "guess the shape of the install" default that lights up the toggle for
// people who already have the CLI on PATH.
const DEFAULT_COMMAND =
  process.platform === 'win32' ? 'claude.cmd -p /tp-watch' : 'claude -p /tp-watch';
const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_IDLE_HEARTBEAT_MS = 30 * 60_000;

/**
 * Request queues the app writes and the `/tp-watch` runner drains. Built on
 * call, not at import, so modules that import this file never touch the
 * constants until a tick actually runs.
 */
export function runnerRequestDirs(): string[] {
  return [IO_EXECUTE, IO_DERIVE, IO_DELIBERATE, IO_SUMMARIZE, IO_MEMORY_ENRICH];
}

/** Count `*.json` request files (atomic-write `.tmp` files excluded). A missing dir counts as empty. */
export function countPendingRequests(dirs: readonly string[] = runnerRequestDirs()): number {
  let n = 0;
  for (const dir of dirs) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.toLowerCase().endsWith('.json') && fs.statSync(path.join(dir, entry)).isFile()) n += 1;
      }
    } catch {
      /* missing or unreadable dir: nothing pending there */
    }
  }
  return n;
}

export interface IdleGateInput {
  argv: readonly string[];
  pending: number;
  /** ISO start time of the last real run, if any. */
  lastStartedAt: string | null;
  now: number;
  skipWhenIdle: boolean;
  /** Spawn anyway once the last run is this old. 0 or less: never spawn while idle. */
  heartbeatMs: number;
}

/**
 * True when this tick should NOT spawn: the gate is on, the command is the
 * queue-draining `/tp-watch` runner (a custom command may do anything, so it
 * always runs), nothing is queued, and the heartbeat is not due.
 */
export function shouldSkipIdleTick(input: IdleGateInput): boolean {
  if (!input.skipWhenIdle) return false;
  if (!input.argv.some((a) => a.includes('/tp-watch'))) return false;
  if (input.pending > 0) return false;
  if (!input.lastStartedAt) return false;
  if (input.heartbeatMs <= 0) return true;
  const last = Date.parse(input.lastStartedAt);
  if (!Number.isFinite(last)) return false;
  return input.now - last < input.heartbeatMs;
}

/* -------------------------------------------------------------------------- */
/*  Public surface                                                            */
/* -------------------------------------------------------------------------- */

export interface RunnerLastRun {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  stdout_tail: string;
  stderr_tail: string;
  /** True when we killed it for hitting `claude_runner_timeout_ms`. */
  timed_out: boolean;
}

export interface RunnerStatus {
  enabled: boolean;
  running: boolean;
  command: string;
  interval_ms: number;
  timeout_ms: number;
  workdir: string;
  last_run: RunnerLastRun | null;
  /** Ticks skipped since boot because every request queue was empty. */
  idle_skips: number;
}

export interface RunnerHandle {
  stop: () => Promise<void>;
  /** Force a run right now (bypasses the interval, still respects concurrency). */
  runNow: () => Promise<RunnerLastRun | null>;
  /** Snapshot of the current state — same shape as the HTTP endpoint. */
  status: () => RunnerStatus;
  /** React to a settings change without a restart. Returns true if any value changed. */
  refresh: () => boolean;
}

let activeHandle: RunnerHandle | null = null;

export function getRunnerHandle(): RunnerHandle | null {
  return activeHandle;
}

/* -------------------------------------------------------------------------- */
/*  Settings helpers                                                          */
/* -------------------------------------------------------------------------- */

function readBoolSetting(key: string, fallback: boolean): boolean {
  const v = settingsRepository.get(key);
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function readStringSetting(key: string, fallback: string): string {
  const v = settingsRepository.get(key);
  if (typeof v === 'string' && v.length > 0) return v;
  return fallback;
}

function readIntSetting(key: string, fallback: number): number {
  const v = settingsRepository.get(key);
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function persistLastRun(run: RunnerLastRun): void {
  try {
    settingsRepository.set(SETTING_LAST_RUN, run as unknown as Record<string, unknown>);
  } catch {
    /* non-fatal */
  }
}

function readLastRun(): RunnerLastRun | null {
  const v = settingsRepository.get(SETTING_LAST_RUN);
  if (v && typeof v === 'object' && 'started_at' in v) {
    return v as RunnerLastRun;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Argv tokenizer (no shell expansion)                                       */
/* -------------------------------------------------------------------------- */

/**
 * Split a command string into argv, honoring matched quotes. Does NOT do
 * env-variable substitution, globbing, or command piping — anything that
 * needs those should be wrapped in a script the user invokes from here.
 *
 * Why the strict tokenizer rather than `shell: true`? Shell-true would let
 * a malicious settings value run arbitrary commands. The tokenizer turns
 * `claude -p "/tp-watch and friends"` into ['claude', '-p', '/tp-watch and friends']
 * deterministically; no metacharacter has special meaning.
 */
function tokenizeCommand(raw: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Start                                                                     */
/* -------------------------------------------------------------------------- */

export function startClaudeRunner(): RunnerHandle {
  // Bounded captures for the last run.
  function captureStream(
    stream: NodeJS.ReadableStream,
    bucket: { value: string; cap: number },
  ): void {
    stream.on('data', (chunk: Buffer | string) => {
      const piece = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const room = bucket.cap - bucket.value.length;
      if (room <= 0) return;
      bucket.value +=
        piece.length > room ? piece.slice(0, room) : piece;
    });
  }

  let timer: NodeJS.Timeout | null = null;
  let current: ChildProcess | null = null;
  let stopping = false;
  let lastRun: RunnerLastRun | null = readLastRun();
  let idleSkips = 0;

  function scheduleNext(intervalMs: number): void {
    if (stopping) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      void tickOnce();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function tickOnce(force = false): Promise<RunnerLastRun | null> {
    const intervalMs = readIntSetting(SETTING_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    // Re-read settings on every tick so toggling in the UI takes effect
    // without a restart.
    const enabled = readBoolSetting(SETTING_ENABLED, false);
    if (!enabled) {
      scheduleNext(intervalMs);
      return null;
    }
    if (isAgentPaused()) {
      scheduleNext(intervalMs);
      return null;
    }
    if (current !== null) {
      // Previous run still going — skip this tick and try again later.
      scheduleNext(intervalMs);
      return null;
    }

    const commandRaw = readStringSetting(SETTING_COMMAND, DEFAULT_COMMAND);
    const argv = tokenizeCommand(commandRaw);
    if (argv.length === 0) {
      scheduleNext(intervalMs);
      return null;
    }
    if (
      !force &&
      shouldSkipIdleTick({
        argv,
        pending: countPendingRequests(),
        lastStartedAt: lastRun?.started_at ?? null,
        now: Date.now(),
        skipWhenIdle: readBoolSetting(SETTING_SKIP_WHEN_IDLE, true),
        heartbeatMs: readIntSetting(SETTING_IDLE_HEARTBEAT_MS, DEFAULT_IDLE_HEARTBEAT_MS),
      })
    ) {
      idleSkips += 1;
      scheduleNext(intervalMs);
      return null;
    }
    const [program, ...args] = argv as [string, ...string[]];
    const timeoutMs = readIntSetting(SETTING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const cwd = readStringSetting(SETTING_WORKDIR, os.homedir() || TASKPILOT_HOME);

    const startedAt = new Date();
    const stdoutBucket = { value: '', cap: MAX_CAPTURE_BYTES };
    const stderrBucket = { value: '', cap: MAX_CAPTURE_BYTES };

    let timedOut = false;
    let exitCode: number | null = null;
    let signal: string | null = null;

    try {
      current = spawn(program, args, {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      // ENOENT — the configured command doesn't exist. Record it and stop.
      const endedAt = new Date();
      lastRun = {
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        duration_ms: endedAt.getTime() - startedAt.getTime(),
        exit_code: null,
        signal: null,
        stdout_tail: '',
        stderr_tail:
          err instanceof Error
            ? `spawn failed: ${err.message}`
            : 'spawn failed (unknown)',
        timed_out: false,
      };
      persistLastRun(lastRun);
      current = null;
      scheduleNext(intervalMs);
      return lastRun;
    }

    if (current.stdout) captureStream(current.stdout, stdoutBucket);
    if (current.stderr) captureStream(current.stderr, stderrBucket);

    const killTimer = setTimeout(() => {
      if (current === null) return;
      timedOut = true;
      try {
        current.kill('SIGTERM');
        // Hard-kill if it ignores SIGTERM for 5s.
        setTimeout(() => {
          try {
            current?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 5_000).unref();
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    killTimer.unref();

    await new Promise<void>((resolve) => {
      current!.on('exit', (code, sig) => {
        exitCode = code;
        signal = sig;
        resolve();
      });
      current!.on('error', () => {
        resolve();
      });
    });
    clearTimeout(killTimer);

    const endedAt = new Date();
    lastRun = {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      exit_code: exitCode,
      signal,
      stdout_tail: stdoutBucket.value,
      stderr_tail: stderrBucket.value,
      timed_out: timedOut,
    };
    persistLastRun(lastRun);
    current = null;
    scheduleNext(intervalMs);
    return lastRun;
  }

  function snapshot(): RunnerStatus {
    return {
      enabled: readBoolSetting(SETTING_ENABLED, false),
      running: current !== null,
      command: readStringSetting(SETTING_COMMAND, DEFAULT_COMMAND),
      interval_ms: readIntSetting(SETTING_INTERVAL_MS, DEFAULT_INTERVAL_MS),
      timeout_ms: readIntSetting(SETTING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      workdir: readStringSetting(SETTING_WORKDIR, os.homedir() || TASKPILOT_HOME),
      last_run: lastRun,
      idle_skips: idleSkips,
    };
  }

  // First tick fires in ~1 s so changes show up quickly after a fresh boot.
  scheduleNext(1_000);

  const handle: RunnerHandle = {
    async stop() {
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (current !== null) {
        try {
          current.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        await new Promise<void>((resolve) => {
          if (current === null) {
            resolve();
            return;
          }
          current.once('exit', () => resolve());
          setTimeout(() => resolve(), 2_000).unref();
        });
      }
      activeHandle = null;
    },
    runNow() {
      // A forced run always spawns, even with empty queues.
      return tickOnce(true);
    },
    status: snapshot,
    refresh() {
      // No diff needed — settings are read on every tick. A consumer
      // calling refresh() just wants the timer to reflect the new
      // interval right now.
      scheduleNext(readIntSetting(SETTING_INTERVAL_MS, DEFAULT_INTERVAL_MS));
      return true;
    },
  };
  activeHandle = handle;
  return handle;
}
