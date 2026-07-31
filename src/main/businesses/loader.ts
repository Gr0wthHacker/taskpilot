/**
 * Loader for `~/.taskpilot/projects.json` — the business → repo map that
 * underpins the businesses status surface.
 *
 * Shape of the file (already in use by the existing scheduling layer):
 *
 *   {
 *     "owner": "Gr0wthHacker",
 *     "projects": [
 *       {
 *         "name": "Leal Health",
 *         "tag": "leal-health",
 *         "business": "leal-health",
 *         "goal_id": "K_HrKrWZx_EM",
 *         "default_permission_profile": "github-pr",
 *         "branch_policy": "agent/{task_id}",
 *         "repos": ["Gr0wthHacker/leal-treatment-finder-site", …]
 *       },
 *       …
 *     ]
 *   }
 *
 * The loader is intentionally tolerant — extra keys are kept, missing optional
 * keys are filled in from sensible defaults, and a malformed file degrades to
 * the empty business list (so a bad edit never crashes the snapshot engine).
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { TASKPILOT_HOME } from '@/shared/constants';

export const businessTagSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid business tag');

const businessConfigSchema = z.object({
  name: z.string().min(1).max(200),
  tag: businessTagSchema,
  business: businessTagSchema.optional(),
  goal_id: z.string().max(64).optional(),
  default_permission_profile: z.string().max(64).optional(),
  branch_policy: z.string().max(256).optional(),
  repos: z.array(z.string().max(256)).max(256).default([]),
});

const projectsFileSchema = z.object({
  owner: z.string().max(128).optional(),
  projects: z.array(businessConfigSchema).max(64).default([]),
});

export type BusinessConfig = z.infer<typeof businessConfigSchema>;
export type ProjectsFile = z.infer<typeof projectsFileSchema>;

export const PROJECTS_FILE_PATH = path.join(TASKPILOT_HOME, 'projects.json');

let cached: { mtime: number; data: ProjectsFile } | null = null;

/**
 * Read and parse `~/.taskpilot/projects.json`. Cached on (mtime, path) so
 * repeated calls in the same tick are O(stat). A missing or malformed file
 * yields an empty list (no `projects`) — callers that need to distinguish
 * "not configured" from "no businesses" should check `exists()`.
 */
export function loadProjects(): ProjectsFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(PROJECTS_FILE_PATH);
  } catch {
    cached = null;
    return { projects: [] };
  }
  const mtime = stat.mtimeMs;
  if (cached && cached.mtime === mtime) return cached.data;
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(PROJECTS_FILE_PATH, 'utf8');
    parsed = JSON.parse(raw);
  } catch {
    return { projects: [] };
  }
  const result = projectsFileSchema.safeParse(parsed);
  if (!result.success) return { projects: [] };
  cached = { mtime, data: result.data };
  return result.data;
}

/** True when `~/.taskpilot/projects.json` is present (and parseable). */
export function exists(): boolean {
  try {
    fs.statSync(PROJECTS_FILE_PATH);
    return true;
  } catch {
    return false;
  }
}

/** Force the next `loadProjects()` call to re-read the file from disk. */
export function invalidateCache(): void {
  cached = null;
}

/** Get a single business config by its tag, or null when no match. */
export function getBusiness(tag: string): BusinessConfig | null {
  const file = loadProjects();
  return file.projects.find((p) => p.tag === tag) ?? null;
}

/** List every configured business. Empty when no `projects.json` exists. */
export function listBusinesses(): BusinessConfig[] {
  return loadProjects().projects;
}

/**
 * Build a `repo → business tag` index across every configured project. Repo
 * keys are stored verbatim from `projects.json` (typically `owner/name`).
 * Used by the SessionEnd hook + the conversation→business mapper.
 */
export function buildRepoIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const p of loadProjects().projects) {
    for (const repo of p.repos) idx.set(repo, p.tag);
  }
  return idx;
}

/**
 * Find the first configured business whose `tag` appears in `tags`.
 * Used by the io ingestion layer to apply per-business defaults
 * (permission profile, branch policy) to newly created tasks.
 */
export function findBusinessByTags(tags: readonly string[]): BusinessConfig | null {
  if (tags.length === 0) return null;
  const set = new Set(tags);
  for (const p of loadProjects().projects) {
    if (set.has(p.tag)) return p;
  }
  return null;
}

/**
 * Best-effort mapping from a CWD (or any filesystem path) to a business tag.
 * Matches the path's final two segments against the `owner/name` repo entries
 * in `projects.json`. Returns null when no segment pair matches.
 *
 * Example: `C:\Users\Jack\code\leal-treatment-finder-site` matches
 * `Gr0wthHacker/leal-treatment-finder-site` and yields `leal-health`.
 */
export function inferBusinessFromPath(rawPath: string): string | null {
  if (!rawPath) return null;
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const idx = buildRepoIndex();
  const tail = parts[parts.length - 1] ?? '';
  const tailLower = tail.toLowerCase();
  for (const [repo, tag] of idx) {
    const repoName = repo.split('/').pop() ?? '';
    if (repoName.toLowerCase() === tailLower) return tag;
  }
  // Fallback: try the literal `owner/name` suffix in case the path retains it.
  if (parts.length >= 2) {
    const owner = parts[parts.length - 2];
    const candidate = `${owner}/${tail}`;
    const hit = idx.get(candidate);
    if (hit) return hit;
  }
  return null;
}
