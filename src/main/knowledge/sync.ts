/**
 * Synchronous knowledge matching + block building, for the derive/execute
 * injection seam (which runs synchronously alongside better-sqlite3 reads).
 *
 * Catalogs are tiny JSON files, so reading them with `fs.readFileSync` on the
 * request path is cheap and avoids threading async through
 * `appendIntelligenceBlocks` / `writeExecuteRequest`. All reads are defensive.
 */

import fs from 'node:fs';

import type { KnowledgeMatch, KnowledgeResource, Task } from '@/shared/types';

import { catalogPath, KNOWLEDGE_DIR } from './paths';
import { rankResources } from './match';

function listBusinessesSync(): string[] {
  try {
    return fs
      .readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readCatalogSync(business: string): KnowledgeResource[] {
  try {
    const raw = fs.readFileSync(catalogPath(business), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is KnowledgeResource =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as KnowledgeResource).file === 'string',
    );
  } catch {
    return [];
  }
}

function businessesForTaskSync(task: Task): string[] {
  const businesses = listBusinessesSync();
  if (businesses.length === 0) return [];
  const lower = new Map(businesses.map((b) => [b.toLowerCase(), b]));
  const out: string[] = [];
  for (const tag of task.tags) {
    const hit = lower.get(tag.toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Synchronous top-N match for the injection seam. Never throws. */
export function matchKnowledgeForTaskSync(task: Task, limit = 5): KnowledgeMatch[] {
  try {
    const businesses = businessesForTaskSync(task);
    if (businesses.length === 0) return [];
    const candidates: KnowledgeResource[] = [];
    for (const business of businesses) candidates.push(...readCatalogSync(business));
    return rankResources(candidates, task, limit);
  } catch {
    return [];
  }
}

/**
 * Build the `---KNOWLEDGE---` instructions block for a task. Lists matched
 * resources (title, one-line summary, sidecar path) and tells the agent to
 * read the relevant sidecars before acting. Returns '' when nothing matches.
 */
export function buildKnowledgeBlock(task: Task): string {
  const matches = matchKnowledgeForTaskSync(task, 6);
  if (matches.length === 0) return '';

  const lines: string[] = [
    '---KNOWLEDGE---',
    'Local knowledge matched to this task (scoped to its business folder).',
    'Read the sidecar text for any resource relevant to this task before acting.',
    'Ignore the ones that are not relevant — this is a candidate menu, not a checklist.',
    '',
  ];
  for (const { resource } of matches) {
    const readable = resource.sidecar_path ?? resource.source_path;
    lines.push(`- ${resource.title}`);
    if (resource.summary) lines.push(`  ${resource.summary}`);
    lines.push(`  read: ${readable}`);
  }
  return lines.join('\n');
}

/**
 * Build the machine-readable `knowledge_paths` array for an execute request's
 * context. Returns [] when nothing matches.
 */
export function resolveKnowledgePaths(task: Task): Array<{
  business: string;
  file: string;
  title: string;
  source_path: string;
  sidecar_path: string | null;
  extracted: boolean;
  score: number;
}> {
  return matchKnowledgeForTaskSync(task, 6).map(({ resource, score }) => ({
    business: resource.business,
    file: resource.file,
    title: resource.title,
    source_path: resource.source_path,
    sidecar_path: resource.sidecar_path,
    extracted: resource.extracted,
    score,
  }));
}
