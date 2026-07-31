/**
 * Resolves the on-disk root for Claude Code session transcripts.
 *
 * Default is `~/.claude/projects/`. Override via the `CLAUDE_PROJECTS_DIR`
 * env var (handy for tests + CI). Note this is OUTSIDE `~/.taskpilot/` — the
 * conversations subsystem reads it but never writes there.
 */

import os from 'node:os';
import path from 'node:path';

export function claudeProjectsDir(): string {
  if (process.env.CLAUDE_PROJECTS_DIR) {
    return process.env.CLAUDE_PROJECTS_DIR;
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * `~/.claude/projects/` flattens project paths into a hash-like dir name by
 * replacing slashes with double dashes. e.g.
 *   C:\Users\Jack\taskpilot  →  C--Users-Jack-taskpilot
 * This is the best-effort inverse — sufficient for matching observed values
 * against `task.context.cwd` strings.
 */
export function decodeProjectDirName(name: string): string {
  // Windows: `C--Users-Jack-taskpilot` → `C:/Users/Jack/taskpilot`.
  // Unix:    `-Users-jack-taskpilot`    → `/Users/jack/taskpilot`.
  if (/^[A-Za-z]--/.test(name)) {
    const drive = name[0];
    const rest = name.slice(3).replace(/-/g, '/');
    return `${drive}:/${rest}`;
  }
  if (name.startsWith('-')) {
    return '/' + name.slice(1).replace(/-/g, '/');
  }
  return name.replace(/-/g, '/');
}
