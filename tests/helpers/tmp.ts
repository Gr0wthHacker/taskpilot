/**
 * Temp directory helpers for I/O tests.
 *
 * Each call to `tmpIoRoot()` creates an isolated directory tree mirroring the
 * `~/.taskpilot/io/` layout, returns the paths, and registers cleanup with
 * vitest's `afterEach` hook.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

export interface TmpIoRoot {
  home: string;
  taskpilot: string;
  ioRoot: string;
  ioInbox: string;
  ioDerive: string;
  ioDerived: string;
  ioExecute: string;
  ioResults: string;
  ioReview: string;
  ioContext: string;
  ioInvalid: string;
  logsDir: string;
}

const trackedRoots: string[] = [];

export function tmpIoRoot(): TmpIoRoot {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpilot-test-'));
  const taskpilot = path.join(home, '.taskpilot');
  const ioRoot = path.join(taskpilot, 'io');
  const dirs: TmpIoRoot = {
    home,
    taskpilot,
    ioRoot,
    ioInbox: path.join(ioRoot, 'inbox'),
    ioDerive: path.join(ioRoot, 'derive'),
    ioDerived: path.join(ioRoot, 'derived'),
    ioExecute: path.join(ioRoot, 'execute'),
    ioResults: path.join(ioRoot, 'results'),
    ioReview: path.join(ioRoot, 'review'),
    ioContext: path.join(ioRoot, 'context'),
    ioInvalid: path.join(ioRoot, '_invalid'),
    logsDir: path.join(taskpilot, 'logs'),
  };

  for (const dir of [
    dirs.taskpilot,
    dirs.ioRoot,
    dirs.ioInbox,
    dirs.ioDerive,
    dirs.ioDerived,
    dirs.ioExecute,
    dirs.ioResults,
    dirs.ioReview,
    dirs.ioContext,
    dirs.ioInvalid,
    dirs.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  trackedRoots.push(home);
  return dirs;
}

afterEach(() => {
  while (trackedRoots.length > 0) {
    const dir = trackedRoots.pop();
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; windows file locks etc.
    }
  }
});
