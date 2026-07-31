/**
 * Match knowledge resources to a task.
 *
 * Two-stage, mirroring the design decision: (1) SCOPE candidates to the
 * task's business by matching the task's tags against existing business
 * folders; (2) RANK within that scope by keyword overlap (same scoring shape
 * as `skill-binding.ts`). The final semantic selection happens downstream —
 * the Claude agent reads the injected candidate menu + sidecars and pulls in
 * what's actually relevant.
 *
 * If a business matches but nothing scores, we still surface the top files so
 * a generic "task about Leal" sees the Leal catalog rather than nothing.
 */

import type { KnowledgeMatch, KnowledgeResource, Task } from '@/shared/types';

import { readCatalog } from './catalog';
import { listBusinesses } from './indexer';

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreResource(
  resource: KnowledgeResource,
  taskTokens: ReadonlySet<string>,
): number {
  const keywordTokens = new Set(resource.keywords.map((k) => k.toLowerCase()));
  const summaryTokens = new Set(tokenize(resource.summary));
  const titleTokens = new Set(tokenize(resource.title));

  let score = 0;
  for (const t of taskTokens) {
    if (titleTokens.has(t)) score += 4;
    if (keywordTokens.has(t)) score += 3;
    if (summaryTokens.has(t)) score += 1;
    for (const k of keywordTokens) {
      if (k !== t && k.includes(t)) score += 1;
    }
  }
  return score;
}

/**
 * Resolve which business folders a task belongs to. A task belongs to a
 * business when one of its tags equals a business folder name
 * (case-insensitive). Returns every match (a task could be tagged twice).
 */
export async function businessesForTask(task: Task): Promise<string[]> {
  const businesses = await listBusinesses();
  if (businesses.length === 0) return [];
  const lower = new Map(businesses.map((b) => [b.toLowerCase(), b]));
  const out: string[] = [];
  for (const tag of task.tags) {
    const hit = lower.get(tag.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Pure ranker: score + sort + slice a candidate set against a task. Shared by
 * the async and sync match entrypoints so the scoring logic lives in one place.
 */
export function rankResources(
  candidates: KnowledgeResource[],
  task: Task,
  limit: number,
): KnowledgeMatch[] {
  if (candidates.length === 0) return [];
  const corpus = [
    task.title,
    task.description ?? '',
    task.agent_instructions ?? '',
    task.tags.join(' '),
  ].join(' ');
  const tokens = new Set(tokenize(corpus));

  return candidates
    .map((resource) => ({ resource, score: scoreResource(resource, tokens) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break: newer first, then filename.
      if (a.resource.indexed_at !== b.resource.indexed_at) {
        return b.resource.indexed_at.localeCompare(a.resource.indexed_at);
      }
      return a.resource.file.localeCompare(b.resource.file);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * Top-N knowledge resources for a task. Empty array when no business matches
 * or no resources exist. Async — used by the HTTP API. The derive/execute
 * injection seam uses the sync variant in `./sync`.
 */
export async function matchKnowledgeForTask(
  task: Task,
  limit = 5,
): Promise<KnowledgeMatch[]> {
  const businesses = await businessesForTask(task);
  if (businesses.length === 0) return [];

  const candidates: KnowledgeResource[] = [];
  for (const business of businesses) {
    candidates.push(...(await readCatalog(business)));
  }
  return rankResources(candidates, task, limit);
}
