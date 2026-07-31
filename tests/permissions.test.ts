/**
 * Permission resolution + validation tests.
 *
 * Covers:
 *   - inheritance: parent fields propagate to children with no own permissions
 *   - override: child fields beat parent fields when both are declared
 *   - profile presets: every built-in profile materializes to the expected shape
 *   - validateWorkspaceWrite: inside-workspace allowed; outside / traversal denied
 *   - validateToolUse: plain name allowed when present; Bash allowlist enforced
 *
 * Uses the in-memory DB harness so `resolvePermissions` can walk a real parent
 * chain. Path constants are mocked via `mockTaskpilotPaths` because some of
 * the profile presets resolve `TASKPILOT_HOME` at module load.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import {
  applyProfile,
  buildContextWithPermissions,
  listProfiles,
  PERMISSIONS_CONTEXT_KEY,
  resolvePermissions,
  resolvePermissionsWithSource,
  validateGithubOperation,
  validateToolUse,
  validateWorkspaceWrite,
} from '@/main/permissions';
import { createTask, getTask, updateTask } from '@/main/db/repositories/tasks';
import type { PermissionSet } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function withPermissions(
  permissions: PermissionSet | null,
): Record<string, unknown> | null {
  if (permissions === null) return null;
  return { [PERMISSIONS_CONTEXT_KEY]: permissions };
}

describe('permissions / resolvePermissions', () => {
  useMockedDb();

  it('inherits fields from a parent when the child declares none', () => {
    const parent = createTask({
      title: 'parent',
      context: withPermissions({
        workspace: '/tmp/parent-ws',
        allowed_tools: ['Read', 'Write'],
        network_access: 'restricted',
      }),
    });
    const child = createTask({
      title: 'child',
      parent_id: parent.id,
    });

    const resolved = resolvePermissions(child);
    expect(resolved.workspace).toBe('/tmp/parent-ws');
    expect(resolved.allowed_tools).toEqual(['Read', 'Write']);
    expect(resolved.network_access).toBe('restricted');
  });

  it('overrides parent fields when the child declares them', () => {
    const parent = createTask({
      title: 'parent',
      context: withPermissions({
        network_access: 'restricted',
        allowed_tools: ['Read'],
      }),
    });
    const child = createTask({
      title: 'child',
      parent_id: parent.id,
      context: withPermissions({
        network_access: 'open',
      }),
    });

    const resolved = resolvePermissions(child);
    expect(resolved.network_access).toBe('open');
    // unchanged fields fall through from parent
    expect(resolved.allowed_tools).toEqual(['Read']);
  });

  it('flags the resolution source as inherited/self/default correctly', () => {
    const parent = createTask({
      title: 'parent',
      context: withPermissions({ workspace: '/tmp/ws' }),
    });
    const child = createTask({ title: 'child', parent_id: parent.id });
    expect(resolvePermissionsWithSource(child).source).toBe('inherited');

    const own = createTask({
      title: 'own',
      context: withPermissions({ workspace: '/tmp/own' }),
    });
    expect(resolvePermissionsWithSource(own).source).toBe('self');

    const blank = createTask({ title: 'blank' });
    expect(resolvePermissionsWithSource(blank).source).toBe('default');
  });

  it('treats a malformed permissions blob as absent (no privilege escalation)', () => {
    // Construct a task with garbage in context.permissions. The resolver
    // should ignore it and fall back to the hardcoded default rather than
    // accept the bogus value.
    const t = createTask({
      title: 'garbage',
      context: { permissions: { network_access: 'invalid-mode' } as unknown as PermissionSet },
    });
    // Default is `off`, not the invalid value.
    expect(resolvePermissions(t).network_access).toBe('off');
  });
});

describe('permissions / applyProfile', () => {
  it('materializes all four profiles with expected shape', () => {
    const trusted = applyProfile('trusted-local');
    expect(trusted.network_access).toBe('restricted');
    expect(trusted.allowed_tools).toContain('Read');
    expect(trusted.allowed_tools).toContain('Bash(git*,npm*,python*)');
    expect(trusted.denied_patterns).toContain('**/.env*');
    expect(trusted.confirm_destructive).toBe(true);

    const sandboxed = applyProfile('sandboxed', 'abc123');
    expect(sandboxed.network_access).toBe('off');
    expect(sandboxed.workspace).toContain('sandbox');
    expect(sandboxed.workspace).toContain('abc123');
    expect(sandboxed.allowed_tools).toEqual(['Read', 'Write', 'Edit']);

    const research = applyProfile('read-only-research');
    expect(research.workspace).toBeUndefined();
    expect(research.allowed_tools).toEqual(['Read', 'WebSearch', 'WebFetch']);
    expect(research.network_access).toBe('open');

    const githubPr = applyProfile('github-pr');
    expect(githubPr.github_operations).toEqual([
      'read',
      'branch',
      'commit',
      'pr',
    ]);
    expect(githubPr.github_branch_policy).toBe('agent/{task_id}');
    // inherits trusted-local fields
    expect(githubPr.allowed_tools).toContain('Bash(git*,npm*,python*)');
  });

  it('listProfiles returns descriptors for every built-in', () => {
    const profiles = listProfiles();
    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual([
      'github-pr',
      'read-only-research',
      'sandboxed',
      'trusted-local',
    ]);
    for (const p of profiles) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.permissions).toBeDefined();
    }
  });
});

describe('permissions / validateWorkspaceWrite', () => {
  it('allows writes inside the workspace', () => {
    const perms: PermissionSet = { workspace: '/tmp/ws' };
    const inside = path.normalize('/tmp/ws/foo/bar.txt');
    expect(validateWorkspaceWrite(perms, inside).allowed).toBe(true);
  });

  it('refuses writes outside the workspace', () => {
    const perms: PermissionSet = { workspace: '/tmp/ws' };
    const outside = path.normalize('/tmp/other/foo.txt');
    const result = validateWorkspaceWrite(perms, outside);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/outside workspace/);
  });

  it('refuses paths containing parent-segment traversal', () => {
    const perms: PermissionSet = { workspace: '/tmp/ws' };
    // After normalization this still sneaks outside because of `..`. The
    // validator should reject any post-normalize `..` segment defensively.
    const result = validateWorkspaceWrite(perms, '/tmp/ws/../etc/passwd');
    expect(result.allowed).toBe(false);
  });

  it('refuses paths that match a denied glob', () => {
    const perms: PermissionSet = {
      workspace: '/tmp/ws',
      denied_patterns: ['**/.env*'],
    };
    const env = path.normalize('/tmp/ws/foo/.env.production');
    const result = validateWorkspaceWrite(perms, env);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/denied pattern/);
  });

  it('allows paths anywhere when no workspace is configured', () => {
    const perms: PermissionSet = {};
    const result = validateWorkspaceWrite(perms, '/anything/at/all.txt');
    expect(result.allowed).toBe(true);
  });
});

describe('permissions / validateToolUse', () => {
  it('allows a plain tool name when present in allowed_tools', () => {
    const perms: PermissionSet = { allowed_tools: ['Read', 'WebSearch'] };
    expect(validateToolUse(perms, 'Read').allowed).toBe(true);
    expect(validateToolUse(perms, 'WebSearch').allowed).toBe(true);
  });

  it('refuses a tool not in the allow list', () => {
    const perms: PermissionSet = { allowed_tools: ['Read'] };
    const result = validateToolUse(perms, 'Write');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/not in allowed_tools/);
  });

  it('enforces a Bash allowlist', () => {
    const perms: PermissionSet = {
      allowed_tools: ['Bash(git*,npm*)'],
    };
    expect(validateToolUse(perms, 'Bash:git status').allowed).toBe(true);
    expect(validateToolUse(perms, 'Bash:npm install').allowed).toBe(true);
    const denied = validateToolUse(perms, 'Bash:rm -rf /');
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/not in Bash allowlist/);
  });

  it('allows everything when allowed_tools is undefined', () => {
    const perms: PermissionSet = {};
    expect(validateToolUse(perms, 'AnythingGoes').allowed).toBe(true);
  });
});

describe('permissions / validateGithubOperation', () => {
  it('refuses when github_operations is empty', () => {
    const perms: PermissionSet = {};
    const result = validateGithubOperation(perms, 'pr', 'org/repo');
    expect(result.allowed).toBe(false);
  });

  it('refuses when the requested op isn’t in github_operations', () => {
    const perms: PermissionSet = { github_operations: ['read'] };
    expect(validateGithubOperation(perms, 'commit', 'org/repo').allowed).toBe(
      false,
    );
  });

  it('refuses when github_repo is set to a different repo', () => {
    const perms: PermissionSet = {
      github_operations: ['read', 'branch', 'commit', 'pr'],
      github_repo: 'org/expected',
    };
    expect(
      validateGithubOperation(perms, 'pr', 'org/other').allowed,
    ).toBe(false);
  });

  it('allows when the op + repo match', () => {
    const perms: PermissionSet = {
      github_operations: ['read', 'branch', 'commit', 'pr'],
      github_repo: 'org/expected',
    };
    expect(
      validateGithubOperation(perms, 'pr', 'org/expected').allowed,
    ).toBe(true);
  });
});

describe('permissions / buildContextWithPermissions', () => {
  it('preserves unrelated context keys when writing permissions', () => {
    const existing = { recurrence: { kind: 'daily' }, notes: 'hi' };
    const next = buildContextWithPermissions(existing, {
      network_access: 'open',
    });
    expect(next).toEqual({
      recurrence: { kind: 'daily' },
      notes: 'hi',
      permissions: { network_access: 'open' },
    });
  });

  it('clears just the permissions key when passed null', () => {
    const existing = {
      recurrence: { kind: 'daily' },
      permissions: { network_access: 'open' },
    };
    const next = buildContextWithPermissions(existing, null);
    expect(next).toEqual({ recurrence: { kind: 'daily' } });
  });

  it('collapses an empty context to null when clearing the only key', () => {
    const existing = { permissions: { network_access: 'open' } };
    const next = buildContextWithPermissions(existing, null);
    expect(next).toBeNull();
  });
});

describe('permissions / inheritance via DB walk', () => {
  useMockedDb();

  it('walks multiple levels deep without cycling', () => {
    const grandparent = createTask({
      title: 'gp',
      context: withPermissions({
        workspace: '/tmp/gp',
        allowed_tools: ['Read'],
      }),
    });
    const parent = createTask({
      title: 'p',
      parent_id: grandparent.id,
      context: withPermissions({
        // shadows allowed_tools only
        allowed_tools: ['Read', 'Write'],
      }),
    });
    const child = createTask({
      title: 'c',
      parent_id: parent.id,
    });
    const resolved = resolvePermissions(child);
    // workspace from grandparent
    expect(resolved.workspace).toBe('/tmp/gp');
    // allowed_tools from parent
    expect(resolved.allowed_tools).toEqual(['Read', 'Write']);
  });

  it('writing permissions on a child via PATCH-style update overrides parent', () => {
    const parent = createTask({
      title: 'p',
      context: withPermissions({
        network_access: 'restricted',
      }),
    });
    const child = createTask({ title: 'c', parent_id: parent.id });
    // Apply a child override.
    const nextCtx = buildContextWithPermissions(child.context, {
      network_access: 'open',
    });
    updateTask(child.id, { context: nextCtx });
    const reread = getTask(child.id);
    if (!reread) throw new Error('child vanished');
    expect(resolvePermissions(reread).network_access).toBe('open');
  });
});
