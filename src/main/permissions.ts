/**
 * Permissions resolution + validation for TaskPilot.
 *
 * Every task can carry a `PermissionSet` at `task.context.permissions`. The
 * resolver walks the parent chain and merges field-by-field — the closest
 * non-undefined value wins. The result is what an agent (Claude Code, runner,
 * MCP caller) must respect before doing any Read / Write / Bash / network
 * operation on behalf of that task.
 *
 * This module is intentionally pure / synchronous: callers from routes,
 * MCP tools, the runner, and tests can all hit `resolvePermissions(task)`
 * without async overhead. Repository lookups go through `getTask` which is
 * itself synchronous (better-sqlite3).
 *
 * The reference at `~/.claude/skills/taskpilot/references/PERMISSIONS.md`
 * documents the contract from Claude's perspective.
 */

import os from 'node:os';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import {
  permissionSetSchema,
  type PermissionSet as ZodPermissionSet,
} from '@/shared/io-schemas';
import type {
  PermissionProfileDescriptor,
  PermissionProfileName,
  PermissionSet,
  Task,
} from '@/shared/types';

import { getTask } from '@/main/db/repositories/tasks';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Maximum parent links the resolver will follow before bailing. */
const MAX_PARENT_DEPTH = 16;

/** Path key on a task's `context` where the PermissionSet lives. */
export const PERMISSIONS_CONTEXT_KEY = 'permissions';

/**
 * Conservative default applied when no task in the chain declares anything.
 * Mirrors `trusted-local` but with `network_access: 'off'` so a fresh,
 * un-configured task can't reach the internet by accident.
 */
const HARDCODED_DEFAULT: PermissionSet = {
  workspace: path.join(os.homedir(), 'Documents'),
  allowed_tools: ['Read'],
  denied_patterns: [
    '**/.env*',
    '**/.ssh/**',
    '**/credentials*',
    '**/tokens.json',
  ],
  network_access: 'off',
  confirm_destructive: true,
};

/* -------------------------------------------------------------------------- */
/*  Profiles                                                                  */
/* -------------------------------------------------------------------------- */

function trustedLocalProfile(): PermissionSet {
  return {
    workspace: path.join(os.homedir(), 'Documents'),
    allowed_tools: [
      'Read',
      'Write',
      'Edit',
      'Bash(git*,npm*,python*)',
      'WebSearch',
    ],
    denied_patterns: [
      '**/.env*',
      '**/.ssh/**',
      '**/credentials*',
      '**/tokens.json',
    ],
    network_access: 'restricted',
    confirm_destructive: true,
  };
}

/**
 * `sandboxed` defers the per-task workspace path to the caller (the resolver
 * fills it in based on the task id when applying the profile). The base
 * descriptor returns a placeholder that will be replaced if a task id is
 * known at apply time.
 */
function sandboxedProfile(taskId?: string): PermissionSet {
  const base = path.join(TASKPILOT_HOME, 'sandbox');
  return {
    workspace: taskId ? path.join(base, taskId) : base,
    allowed_tools: ['Read', 'Write', 'Edit'],
    denied_patterns: [],
    network_access: 'off',
    confirm_destructive: true,
  };
}

function readOnlyResearchProfile(): PermissionSet {
  return {
    // No workspace — purely read-from-web / read-from-disk(-into-context).
    allowed_tools: ['Read', 'WebSearch', 'WebFetch'],
    denied_patterns: [],
    network_access: 'open',
    confirm_destructive: true,
  };
}

function githubPrProfile(): PermissionSet {
  return {
    ...trustedLocalProfile(),
    github_operations: ['read', 'branch', 'commit', 'pr'],
    github_branch_policy: 'agent/{task_id}',
  };
}

const PROFILE_DESCRIPTORS: Record<
  PermissionProfileName,
  Omit<PermissionProfileDescriptor, 'permissions'>
> = {
  'trusted-local': {
    name: 'trusted-local',
    label: 'Trusted local',
    description:
      "Default for tasks you've vetted. Read/Write/Edit + git, npm, python under ~/Documents. Restricted network. Secrets always denied.",
  },
  sandboxed: {
    name: 'sandboxed',
    label: 'Sandboxed',
    description:
      'Strict per-task workspace under ~/.taskpilot/sandbox/<id>. No network. Read/Write/Edit only. Safe default for untrusted task sources.',
  },
  'read-only-research': {
    name: 'read-only-research',
    label: 'Read-only research',
    description:
      'No writes anywhere. Web access for research (WebSearch + WebFetch). Use for "go find me X" tasks.',
  },
  'github-pr': {
    name: 'github-pr',
    label: 'GitHub PR',
    description:
      'Trusted-local plus authorized GitHub branch/commit/PR operations. Branches must match agent/{task_id}.',
  },
};

/**
 * Apply a built-in profile and return the resulting `PermissionSet`. Pass
 * `taskId` to materialize the `sandboxed` profile's per-task workspace path.
 */
export function applyProfile(
  profile: PermissionProfileName,
  taskId?: string,
): PermissionSet {
  switch (profile) {
    case 'trusted-local':
      return trustedLocalProfile();
    case 'sandboxed':
      return sandboxedProfile(taskId);
    case 'read-only-research':
      return readOnlyResearchProfile();
    case 'github-pr':
      return githubPrProfile();
    default: {
      // Exhaustiveness check — TS will flag a missing case.
      const _exhaustive: never = profile;
      void _exhaustive;
      throw new Error(`Unknown permission profile: ${String(profile)}`);
    }
  }
}

/**
 * List every built-in profile with its descriptor + materialized permissions.
 * Used by the `GET /api/permissions/profiles` endpoint and the Settings UI.
 */
export function listProfiles(): PermissionProfileDescriptor[] {
  const names: PermissionProfileName[] = [
    'trusted-local',
    'sandboxed',
    'read-only-research',
    'github-pr',
  ];
  return names.map((name) => ({
    ...PROFILE_DESCRIPTORS[name],
    permissions: applyProfile(name),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Read / write helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pull the raw `PermissionSet` declared directly on a task (no parent walk).
 * Returns `null` when the task has no permissions block, or when the stored
 * value fails schema validation. Validation errors are swallowed silently —
 * we treat malformed permission blobs as "absent" so a corrupted task can't
 * widen its own access through a parse failure.
 */
export function readTaskPermissions(task: Task | null): PermissionSet | null {
  if (!task || !task.context || typeof task.context !== 'object') return null;
  const raw = (task.context as Record<string, unknown>)[
    PERMISSIONS_CONTEXT_KEY
  ];
  if (!raw || typeof raw !== 'object') return null;
  const parsed = permissionSetSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Merge two permission sets. The child wins field-by-field — any field
 * defined on the child overrides the parent. Arrays are NOT concatenated;
 * if the child supplies one it replaces the parent's. This matches the
 * intent of inheritance ("override" semantics, not "extend").
 */
function mergePermissions(
  parent: PermissionSet,
  child: PermissionSet,
): PermissionSet {
  const merged: PermissionSet = { ...parent };
  const keys: (keyof PermissionSet)[] = [
    'workspace',
    'allowed_tools',
    'denied_patterns',
    'network_access',
    'max_runtime_minutes',
    'confirm_destructive',
    'github_repo',
    'github_branch_policy',
    'github_operations',
  ];
  for (const key of keys) {
    const value = child[key];
    if (value !== undefined) {
      // Assign through a typed map — TypeScript can't narrow generically.
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/*  Resolution                                                                */
/* -------------------------------------------------------------------------- */

export interface ResolveResult {
  resolved: PermissionSet;
  /**
   * - `self` — this task declared at least one field.
   * - `inherited` — every field comes from an ancestor.
   * - `default` — no task in the chain declared anything; the hardcoded
   *   default was used.
   */
  source: 'self' | 'inherited' | 'default';
}

/**
 * Resolve a task's effective permissions by walking up the parent chain.
 *
 * Implementation notes:
 *   - We walk from root → leaf so child fields override parent fields.
 *   - A loop guard caps the chain at `MAX_PARENT_DEPTH` parents to defend
 *     against pathological data.
 *   - The hardcoded default sits at the very root: any task that declares
 *     nothing (and has no declarative ancestor) gets a conservative shape
 *     rather than `{}`.
 */
export function resolvePermissions(task: Task): PermissionSet {
  return resolvePermissionsWithSource(task).resolved;
}

export function resolvePermissionsWithSource(task: Task): ResolveResult {
  const chain: Task[] = [];
  const seen = new Set<string>();
  let cursor: Task | null = task;
  let depth = 0;
  while (cursor && depth < MAX_PARENT_DEPTH) {
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    chain.unshift(cursor);
    const parentId = cursor.parent_id;
    if (!parentId) break;
    cursor = getTask(parentId);
    depth += 1;
  }

  let merged: PermissionSet = { ...HARDCODED_DEFAULT };
  let selfContributed = false;
  let anyContributed = false;
  for (let i = 0; i < chain.length; i += 1) {
    const link = chain[i];
    const declared = readTaskPermissions(link);
    if (!declared) continue;
    anyContributed = true;
    if (link.id === task.id) selfContributed = true;
    merged = mergePermissions(merged, declared);
  }

  const source: ResolveResult['source'] = selfContributed
    ? 'self'
    : anyContributed
      ? 'inherited'
      : 'default';
  return { resolved: merged, source };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Normalize a filesystem path for prefix-based containment checks. Resolves
 * `..` traversal, expands relative segments against the workspace root, and
 * always returns an absolute path.
 */
function normalizeWithin(workspace: string, candidate: string): string {
  const abs = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workspace, candidate);
  return path.normalize(abs);
}

/**
 * Returns true iff `child` is inside (or equal to) `parent`. Uses path
 * separators so `/foo/bar` is NOT considered inside `/foo/ba`.
 */
function isInside(parent: string, child: string): boolean {
  const normalizedParent = path.normalize(parent);
  const normalizedChild = path.normalize(child);
  if (normalizedParent === normalizedChild) return true;
  const withSep = normalizedParent.endsWith(path.sep)
    ? normalizedParent
    : normalizedParent + path.sep;
  return normalizedChild.startsWith(withSep);
}

/**
 * Compile a denied glob to a RegExp. Supports `**`, `*`, and `?`. We don't
 * pull in a real glob lib here — these patterns are user-authored and small,
 * and a hand-rolled translator keeps the surface area tiny.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        // single * — anything except path separator
        re += '[^/\\\\]*';
      }
    } else if (ch === '?') {
      re += '[^/\\\\]';
    } else if (ch === '/') {
      re += '[/\\\\]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/**
 * Check whether an absolute path falls under a denied pattern. The pattern is
 * matched against (a) the absolute path verbatim and (b) the path relative
 * to the workspace, so authors can write either `**\/.env*` or absolute paths.
 */
function matchesAnyDenied(
  workspace: string | undefined,
  absolutePath: string,
  denied: string[],
): string | null {
  if (denied.length === 0) return null;
  const candidates: string[] = [absolutePath];
  if (workspace) {
    const rel = path.relative(workspace, absolutePath);
    candidates.push(rel.split(path.sep).join('/'));
  }
  for (const pattern of denied) {
    const re = globToRegExp(pattern);
    for (const candidate of candidates) {
      if (re.test(candidate)) return pattern;
    }
  }
  return null;
}

/**
 * Validate a workspace-scoped write. Returns `allowed: true` only when both:
 *   - the target path is inside the configured workspace (after normalizing
 *     `..` traversal), AND
 *   - it doesn't match any denied glob.
 *
 * If no workspace is configured the path is allowed by default — callers
 * should pair this with `validateToolUse` to ensure they had a Write tool
 * grant in the first place.
 */
export function validateWorkspaceWrite(
  perms: PermissionSet,
  absolutePath: string,
): ValidationResult {
  if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
    return { allowed: false, reason: 'Empty path' };
  }
  const workspace = perms.workspace;
  // Resolve traversal against the workspace (if any). When no workspace is
  // configured we still normalize so callers can't sneak `..` through.
  const normalized = workspace
    ? normalizeWithin(workspace, absolutePath)
    : path.normalize(absolutePath);

  // Reject any path containing parent-segment markers post-normalization —
  // on Windows path.normalize keeps `..\\foo` when the original was relative
  // and not anchored, which would otherwise sneak past containment.
  const segments = normalized.split(/[\\/]/);
  if (segments.includes('..')) {
    return {
      allowed: false,
      reason: `Path traversal segment in ${absolutePath}`,
    };
  }

  if (workspace) {
    if (!isInside(workspace, normalized)) {
      return {
        allowed: false,
        reason: `Path ${normalized} is outside workspace ${workspace}`,
      };
    }
  }

  const denied = perms.denied_patterns ?? [];
  const hit = matchesAnyDenied(workspace, normalized, denied);
  if (hit) {
    return {
      allowed: false,
      reason: `Path matches denied pattern ${hit}`,
    };
  }
  return { allowed: true };
}

/**
 * Parse a tool entry. `"Bash(git*,npm*)"` → name=`Bash`, allowlist=`['git*','npm*']`.
 * `"Read"` → name=`Read`, allowlist=null (everything allowed for that tool).
 */
function parseToolEntry(entry: string): {
  name: string;
  allowlist: string[] | null;
} {
  const trimmed = entry.trim();
  const open = trimmed.indexOf('(');
  if (open === -1 || !trimmed.endsWith(')')) {
    return { name: trimmed, allowlist: null };
  }
  const name = trimmed.slice(0, open).trim();
  const inner = trimmed.slice(open + 1, -1);
  const allowlist = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { name, allowlist };
}

function matchesAllowlistPattern(pattern: string, candidate: string): boolean {
  // Glob-lite: '*' anywhere matches `[^\s]*`.
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    'i',
  );
  return re.test(candidate);
}

/**
 * Validate that a tool invocation is allowed by the permission set.
 *
 * `toolName` accepts either:
 *   - a bare name (`"Read"`, `"WebSearch"`)
 *   - a Bash invocation in the form `"Bash:git push"` or `"Bash:npm test"`
 *     (anything after the colon is the command being run; we match it against
 *     the Bash entry's allowlist)
 *
 * If `allowed_tools` is undefined the call is allowed (no enforcement). When
 * the list is present, the named tool MUST appear; Bash entries enforce the
 * allowlist if one was specified.
 */
export function validateToolUse(
  perms: PermissionSet,
  toolName: string,
): ValidationResult {
  if (perms.allowed_tools === undefined) return { allowed: true };
  const entries = perms.allowed_tools;
  // Split "Bash:command args" into ('Bash', 'command args'). For non-Bash
  // tools the second half is empty and ignored.
  const colon = toolName.indexOf(':');
  const requestedName = colon === -1 ? toolName : toolName.slice(0, colon);
  const requestedCommand = colon === -1 ? '' : toolName.slice(colon + 1).trim();
  const requestedBinary = requestedCommand.split(/\s+/)[0] ?? '';

  for (const raw of entries) {
    const { name, allowlist } = parseToolEntry(raw);
    if (name !== requestedName) continue;
    if (allowlist === null) return { allowed: true };
    // We have an allowlist — only Bash uses this surface today, but the logic
    // applies generically.
    if (requestedBinary.length === 0) {
      return {
        allowed: false,
        reason: `Tool ${name} requires a binary; allowlist is ${allowlist.join(', ')}`,
      };
    }
    for (const pattern of allowlist) {
      if (matchesAllowlistPattern(pattern, requestedBinary)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `${requestedBinary} not in ${name} allowlist (${allowlist.join(', ')})`,
    };
  }
  return {
    allowed: false,
    reason: `Tool ${requestedName} is not in allowed_tools`,
  };
}

/**
 * Validate a GitHub operation against the resolved permissions.
 *
 * Fails when:
 *   - `github_repo` is configured but doesn't match the target repo
 *   - `github_operations` is configured but doesn't include the requested op
 *
 * If neither field is set, defaults are conservative: nothing is allowed
 * until the user opts in (`github-pr` profile does this in one click).
 */
export function validateGithubOperation(
  perms: PermissionSet,
  op: 'read' | 'branch' | 'commit' | 'pr',
  repo: string,
): ValidationResult {
  if (!perms.github_operations || perms.github_operations.length === 0) {
    return {
      allowed: false,
      reason: 'No github_operations configured',
    };
  }
  if (!perms.github_operations.includes(op)) {
    return {
      allowed: false,
      reason: `Operation '${op}' not in github_operations (${perms.github_operations.join(', ')})`,
    };
  }
  if (perms.github_repo) {
    if (perms.github_repo !== repo) {
      return {
        allowed: false,
        reason: `Repo ${repo} doesn't match configured ${perms.github_repo}`,
      };
    }
  }
  return { allowed: true };
}

/* -------------------------------------------------------------------------- */
/*  Persistence helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build the new `context` blob for `updateTask` when writing permissions.
 * Pass `null` for `permissions` to clear the block (so the task inherits
 * from its parent again).
 */
export function buildContextWithPermissions(
  existingContext: Record<string, unknown> | null,
  permissions: PermissionSet | null,
): Record<string, unknown> | null {
  const baseObj: Record<string, unknown> =
    existingContext && typeof existingContext === 'object'
      ? { ...existingContext }
      : {};
  if (permissions === null) {
    delete baseObj[PERMISSIONS_CONTEXT_KEY];
    if (Object.keys(baseObj).length === 0) return null;
    return baseObj;
  }
  baseObj[PERMISSIONS_CONTEXT_KEY] = permissions;
  return baseObj;
}

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

// Re-export the Zod-inferred shape for callers who don't want to dual-import
// from `@/shared/types` and `@/shared/io-schemas`.
export type { ZodPermissionSet };
