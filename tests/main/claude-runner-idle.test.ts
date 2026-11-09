/**
 * Idle gate for the auto-runner: an empty request queue must not spawn a
 * headless `claude -p /tp-watch` every tick (each start costs a full model
 * turn over Claude Code's system prompt and tools), but real work, forced
 * runs, custom commands and the heartbeat still spawn.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Only pure helpers are exercised here, with explicit temp dirs, so the real
// constants module is fine: nothing under ~/.taskpilot is read or written.
import { countPendingRequests, shouldSkipIdleTick, type IdleGateInput } from '@/main/claude-runner';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const base: IdleGateInput = {
  argv: ['claude', '-p', '/tp-watch'],
  pending: 0,
  lastStartedAt: new Date(NOW - 60_000).toISOString(),
  now: NOW,
  skipWhenIdle: true,
  heartbeatMs: 30 * 60_000,
};

describe('claude-runner idle gate', () => {
  it('skips an idle tick for the default /tp-watch runner', () => {
    expect(shouldSkipIdleTick(base)).toBe(true);
    expect(shouldSkipIdleTick({ ...base, argv: ['claude.cmd', '-p', '/tp-watch'] })).toBe(true);
  });

  it('spawns when anything is queued', () => {
    expect(shouldSkipIdleTick({ ...base, pending: 1 })).toBe(false);
  });

  it('spawns a heartbeat once the last run is older than the heartbeat', () => {
    expect(shouldSkipIdleTick({ ...base, lastStartedAt: new Date(NOW - 31 * 60_000).toISOString() })).toBe(false);
    expect(shouldSkipIdleTick({ ...base, lastStartedAt: null })).toBe(false);
    expect(shouldSkipIdleTick({ ...base, heartbeatMs: 0, lastStartedAt: new Date(NOW - 86_400_000).toISOString() })).toBe(true);
  });

  it('never gates a custom command or a disabled gate', () => {
    expect(shouldSkipIdleTick({ ...base, argv: ['my-runner', '--drain'] })).toBe(false);
    expect(shouldSkipIdleTick({ ...base, skipWhenIdle: false })).toBe(false);
  });

  it('counts only .json request files and treats missing dirs as empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-runner-'));
    const a = path.join(root, 'execute');
    const b = path.join(root, 'summarize');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 't1.json'), '{}');
    fs.writeFileSync(path.join(a, 't2.json.tmp'), '{}');
    fs.writeFileSync(path.join(b, 'c1.json'), '{}');
    fs.mkdirSync(path.join(b, 'sub.json'));
    expect(countPendingRequests([a, b, path.join(root, 'missing')])).toBe(2);
    expect(countPendingRequests([path.join(root, 'missing')])).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
