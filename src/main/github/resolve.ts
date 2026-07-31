/**
 * Repo resolution for tasks.
 *
 * Tasks that need GitHub access don't always know which repo to act on —
 * Claude has to decide based on context. This module picks one of four
 * outcomes for a given task:
 *
 *   1. `use_existing` — the task (or a mapping or setting) specifies a real
 *      repo that the PAT can reach. Use it.
 *   2. `propose_new`  — no existing repo matches; the task is concrete enough
 *      to spin up a new repo (slug suggested). Caller asks the user to
 *      confirm before calling `POST /api/github/repos`.
 *   3. `ambiguous`    — multiple plausible repos. Caller surfaces options.
 *   4. `none`         — task doesn't need GitHub. Caller skips github ops.
 *
 * The resolver consults, in order:
 *
 *   (a) `task.context.permissions.github_repo`              — explicit
 *   (b) `task.context.github_repo`                          — alias
 *   (c) `github_repo_mappings` setting (tag/keyword → repo) — registry
 *   (d) `default_github_repo` setting                       — global fallback
 *   (e) Title/description keyword inference (looks for "in the X repo",
 *       "for X site", explicit `owner/repo` tokens, common business names
 *       mapped to known repos)
 *
 * If none of the above produces a candidate but the task title looks like
 * code work ("write a script", "build a tool", "scaffold", etc.), the
 * resolver returns `propose_new` with a slugified name.
 */

import { listTasks } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export type RepoResolution =
  | { decision: 'use_existing'; repo: string; source: string }
  | {
      decision: 'propose_new';
      suggested_name: string;
      suggested_owner?: string;
      rationale: string;
    }
  | {
      decision: 'ambiguous';
      candidates: Array<{ repo: string; source: string; score: number }>;
    }
  | { decision: 'none'; rationale: string };

export interface RepoMapping {
  /** Match key — a tag slug or a keyword (case-insensitive substring). */
  match: string;
  /** Target repo in `owner/name` form. */
  repo: string;
  /** Whether `match` is a tag (exact) or a keyword (substring). */
  kind: 'tag' | 'keyword';
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Two patterns for inline repo references:
 *   - `https://github.com/owner/repo` (or `http://`, with or without `.git`)
 *   - Backtick-wrapped `owner/repo` token
 *
 * Bare `owner/repo` in prose is intentionally NOT matched — too many false
 * positives ("cowork/cli", "review/approve", file paths like "src/index").
 * Users who want a bare reference should mention the GitHub URL or wrap in
 * backticks.
 */
const GITHUB_URL_REGEX = /https?:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\.git)?(?:[/#?]|\b|$)/;
const BACKTICKED_REPO_REGEX = /`([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})`/;

/**
 * Words in a task title that suggest the task is code work and warrants a
 * new repo when no existing match is found.
 */
const CODE_WORK_KEYWORDS = [
  'build',
  'scaffold',
  'create',
  'write',
  'implement',
  'prototype',
  'spike',
  'repo',
  'script',
  'cli',
  'tool',
  'library',
  'package',
  'app',
  'project',
  'starter',
];

/**
 * Words that strongly suggest the task is NOT code work — skip github ops.
 */
const NON_CODE_KEYWORDS = [
  'email',
  'meeting',
  'call',
  'review pdf',
  'sign',
  'pay',
  'remind',
  'follow up',
  'thank',
];

/** Slugify a task title to a reasonable repo name. */
export function slugifyName(title: string, taskId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  if (base.length === 0) return `tp-${taskId.toLowerCase()}`;
  return base;
}

function readMappings(): RepoMapping[] {
  try {
    const raw = settingsRepository.get('github_repo_mappings');
    if (!raw) return [];
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is RepoMapping =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as RepoMapping).match === 'string' &&
        typeof (m as RepoMapping).repo === 'string' &&
        ((m as RepoMapping).kind === 'tag' || (m as RepoMapping).kind === 'keyword'),
    );
  } catch {
    return [];
  }
}

function readDefaultRepo(): string | null {
  try {
    const raw = settingsRepository.get('default_github_repo');
    if (typeof raw === 'string' && raw.includes('/')) return raw;
    return null;
  } catch {
    return null;
  }
}

function extractGithubFromContext(task: Task): string | null {
  const ctx = task.context as Record<string, unknown> | null;
  if (!ctx) return null;
  const perms = ctx['permissions'] as Record<string, unknown> | undefined;
  const fromPerms = perms?.['github_repo'];
  if (typeof fromPerms === 'string' && fromPerms.includes('/')) return fromPerms;
  const direct = ctx['github_repo'];
  if (typeof direct === 'string' && direct.includes('/')) return direct;
  return null;
}

function matchesKeyword(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function looksLikeCodeWork(text: string): boolean {
  const lower = text.toLowerCase();
  for (const stop of NON_CODE_KEYWORDS) {
    if (lower.includes(stop)) return false;
  }
  for (const kw of CODE_WORK_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Decide which repo a task should act on. Pure — no network calls. Pair with
 * `POST /api/github/repos/:owner/:repo/exists` to confirm reachability before
 * acting on a `use_existing` result.
 */
export function resolveTaskRepo(task: Task): RepoResolution {
  // (a) + (b) explicit on the task
  const explicit = extractGithubFromContext(task);
  if (explicit) {
    return { decision: 'use_existing', repo: explicit, source: 'task.context' };
  }

  // (c) settings-level mappings
  const mappings = readMappings();
  const matched: Array<{ repo: string; source: string; score: number }> = [];
  for (const m of mappings) {
    if (m.kind === 'tag') {
      if (task.tags.some((t) => t.toLowerCase() === m.match.toLowerCase())) {
        matched.push({ repo: m.repo, source: `tag:${m.match}`, score: 3 });
      }
    } else {
      if (
        matchesKeyword(task.title, m.match) ||
        (task.description !== null && matchesKeyword(task.description, m.match))
      ) {
        matched.push({ repo: m.repo, source: `keyword:${m.match}`, score: 2 });
      }
    }
  }

  // (e) inline repo mention in title or description.
  // GitHub URL gets the highest score; backticked token is treated as a
  // moderately strong signal too. Bare `owner/repo` strings in prose are
  // intentionally ignored — they false-positive on file paths and option
  // values like `cowork/cli`.
  const text = `${task.title}\n${task.description ?? ''}`;
  const urlMatch = text.match(GITHUB_URL_REGEX);
  if (urlMatch) {
    matched.push({
      repo: `${urlMatch[1]}/${urlMatch[2]}`,
      source: 'github_url',
      score: 5,
    });
  }
  const backtickMatch = text.match(BACKTICKED_REPO_REGEX);
  if (backtickMatch) {
    matched.push({
      repo: `${backtickMatch[1]}/${backtickMatch[2]}`,
      source: 'backticked_mention',
      score: 4,
    });
  }

  // Dedupe by repo, keep highest score
  const dedup = new Map<string, { repo: string; source: string; score: number }>();
  for (const c of matched) {
    const prior = dedup.get(c.repo);
    if (!prior || prior.score < c.score) dedup.set(c.repo, c);
  }
  const candidates = [...dedup.values()].sort((a, b) => b.score - a.score);

  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { decision: 'use_existing', repo: only.repo, source: only.source };
  }
  if (candidates.length > 1) {
    // If the top score dominates, return it; otherwise it's truly ambiguous.
    const top = candidates[0]!;
    const second = candidates[1]!;
    if (top.score - second.score >= 2) {
      return { decision: 'use_existing', repo: top.repo, source: top.source };
    }
    return { decision: 'ambiguous', candidates };
  }

  // (d) global default
  const defaultRepo = readDefaultRepo();
  if (defaultRepo) {
    return { decision: 'use_existing', repo: defaultRepo, source: 'default_github_repo' };
  }

  // (no match) — decide between propose_new and none based on the task
  if (looksLikeCodeWork(text)) {
    return {
      decision: 'propose_new',
      suggested_name: slugifyName(task.title, task.id),
      rationale:
        'No matching repo found; task looks like code work — propose creating a new repo.',
    };
  }

  return {
    decision: 'none',
    rationale: 'No repo match and task does not appear to be code work.',
  };
}

/**
 * Convenience: list all other tasks that resolve to the same repo. Useful
 * for surfacing "this task and 4 others want this repo — does the mapping
 * make sense?" UX hints.
 */
export function siblingTasksForRepo(repo: string): Task[] {
  const all = listTasks({ limit: 500 });
  const out: Task[] = [];
  for (const candidate of all) {
    const res = resolveTaskRepo(candidate);
    if (res.decision === 'use_existing' && res.repo === repo) {
      out.push(candidate);
    }
  }
  return out;
}
