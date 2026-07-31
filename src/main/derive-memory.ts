/**
 * Derivation memory (Wave 12 intelligence layer).
 *
 * When the user (or auto-derive) kicks off a new task's decomposition, we
 * look up the closest 3-5 prior tasks that were already DONE and whose
 * derivations the user accepted. Their structure is injected into the new
 * derive request as a "Previously you decomposed similar tasks like this"
 * block so Claude can mimic patterns that worked.
 *
 * Similarity is computed cheaply:
 *
 *   - Jaccard overlap between the two tasks' tag sets.
 *   - Bag-of-words cosine on title (and description, if available).
 *
 * The final score is the average. Anything ≤ 0 gets filtered out. We cap
 * the rendered context block at ~2000 characters so a busy user's archive
 * doesn't blow up the derivation request size.
 */

import { listTasks, getChildren } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

/** Soft cap on the size of the rendered memory block (chars). */
const MAX_CONTEXT_CHARS = 2_000;

/** Stopwords stripped before BoW comparison. Keeping it tiny — the universe is
 * small, and we don't want to discard genuinely useful task verbs like "write". */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'of',
  'to',
  'for',
  'with',
  'in',
  'on',
  'at',
  'by',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'this',
  'that',
  'it',
  'as',
  'from',
  'into',
]);

/* -------------------------------------------------------------------------- */
/*  Scoring                                                                   */
/* -------------------------------------------------------------------------- */

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity between two string sets: |A ∩ B| / |A ∪ B|. Returns 0
 * when both sets are empty (rather than NaN).
 */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Cosine similarity on bag-of-words. Each side is represented by a frequency
 * map; the dot product divided by the magnitude product is the cosine.
 */
function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [token, aw] of a) {
    const bw = b.get(token);
    if (bw !== undefined) dot += aw * bw;
  }
  const magA = Math.sqrt([...a.values()].reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt([...b.values()].reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

function bagOfWords(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * Composite similarity score between two tasks. Equal-weighted average of
 * Jaccard (tags) and cosine (title + description). In [0, 1].
 */
export function similarityScore(a: Task, b: Task): number {
  const tagsA = new Set(a.tags.map((t) => t.toLowerCase()));
  const tagsB = new Set(b.tags.map((t) => t.toLowerCase()));
  const tagSim = jaccard(tagsA, tagsB);

  const textA = bagOfWords(`${a.title} ${a.description ?? ''}`);
  const textB = bagOfWords(`${b.title} ${b.description ?? ''}`);
  const titleSim = cosine(textA, textB);

  return (tagSim + titleSim) / 2;
}

/* -------------------------------------------------------------------------- */
/*  Lookup                                                                    */
/* -------------------------------------------------------------------------- */

export interface SimilarTaskMatch {
  task: Task;
  score: number;
}

/**
 * Find the closest prior `done` tasks to the given source, ranked by
 * {@link similarityScore} descending. The source itself is excluded.
 *
 * Implementation note: we list with `include_archived: true` and `status:
 * 'done'`. That status filter is the cheap way to limit the candidate set to
 * tasks whose derivation patterns are presumably useful.
 */
export function findSimilarDoneTasks(
  task: Task,
  limit = 5,
): SimilarTaskMatch[] {
  if (limit <= 0) return [];
  // Only DONE tasks are eligible — they actually finished. We include
  // archived ones too: a user might have archived a successful, well-derived
  // task for hygiene reasons, but its structure is still informative.
  const candidates = listTasks({
    status: 'done',
    include_archived: true,
    limit: 500,
  });
  const scored: SimilarTaskMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.id === task.id) continue;
    const score = similarityScore(task, candidate);
    if (score <= 0) continue;
    scored.push({ task: candidate, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Ties broken by recency — newer done tasks win because they reflect
    // more recent patterns/style.
    return b.task.updated_at.localeCompare(a.task.updated_at);
  });
  return scored.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the markdown block that gets folded into a derive request's
 * `instructions` field. Returns `''` when there's nothing useful to include
 * so callers can skip appending an empty section.
 *
 * Format:
 *
 *   ## Past similar tasks
 *
 *   ### <Title> (tags: a, b)
 *   Decomposed into:
 *     - child title 1
 *     - child title 2
 *
 *   ### <Title> ...
 *
 * The block is hard-capped at {@link MAX_CONTEXT_CHARS} so it doesn't dwarf
 * the request payload.
 */
export function summarizeForContext(matches: SimilarTaskMatch[]): string {
  if (matches.length === 0) return '';
  const lines: string[] = ['## Past similar tasks'];
  for (const match of matches) {
    const t = match.task;
    const tagSuffix =
      t.tags.length > 0 ? ` (tags: ${t.tags.slice(0, 5).join(', ')})` : '';
    lines.push('');
    lines.push(`### ${t.title}${tagSuffix}`);
    const children = getChildren(t.id);
    if (children.length === 0) {
      lines.push('(no recorded derivatives)');
    } else {
      lines.push('Decomposed into:');
      for (const child of children.slice(0, 8)) {
        const status = child.status === 'done' ? '' : ` [${child.status}]`;
        lines.push(`- ${child.title}${status}`);
      }
      if (children.length > 8) {
        lines.push(`- … and ${children.length - 8} more`);
      }
    }
  }
  const joined = lines.join('\n');
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  // Truncate gracefully on a newline boundary so we never cut a sentence in
  // half mid-token.
  const truncated = joined.slice(0, MAX_CONTEXT_CHARS);
  const lastNewline = truncated.lastIndexOf('\n');
  const safe = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;
  return `${safe}\n…(truncated)`;
}

/**
 * One-shot: look up similar tasks and render the memory block in a single
 * call. Convenience for the derive route.
 *
 * Returns `{ block, count }` where `count` is how many memories were
 * actually surfaced (so the route can attach a `derived_memory_count` flag
 * to the derivation context payload).
 */
export interface DerivationMemoryBundle {
  block: string;
  count: number;
}

export function buildDerivationMemory(
  task: Task,
  limit = 5,
): DerivationMemoryBundle {
  const matches = findSimilarDoneTasks(task, limit);
  const block = summarizeForContext(matches);
  return { block, count: matches.length };
}
