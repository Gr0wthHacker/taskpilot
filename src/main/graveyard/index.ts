/**
 * Decision graveyard — every kill / abandon / skip / "no" recorded.
 *
 * Purpose: stop the loop where the same idea gets re-proposed every few
 * weeks. When a future Claude session searches recall, abandonment hits
 * surface so the response is "you killed this on 2026-03-04 because X"
 * instead of "great idea, here's how to start."
 *
 * File-backed at `~/.taskpilot/graveyard/entries.jsonl` — append-only,
 * grep-friendly. Each row carries enough context (subject, reason,
 * source, business) to be useful to a search hit.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';

export const GRAVEYARD_DIR = path.join(TASKPILOT_HOME, 'graveyard');
export const GRAVEYARD_FILE = path.join(GRAVEYARD_DIR, 'entries.jsonl');

export type GraveyardKind = 'killed' | 'abandoned' | 'skipped' | 'rejected';

export interface GraveyardEntry {
  /** When the decision was recorded. */
  at: string;
  kind: GraveyardKind;
  /** Short subject — the thing that was rejected. Max ~280 chars. */
  subject: string;
  /** Optional explanation. Why this didn't make the cut. */
  reason?: string;
  /** Business tag if scoped, else null/undefined. */
  business?: string | null;
  /** Free-form pointer back to a task id, conversation id, draft slug, etc. */
  source?: string;
}

const MAX_RETURNED = 500;

async function ensureDir(): Promise<void> {
  await fs.mkdir(GRAVEYARD_DIR, { recursive: true });
}

/** Append a single decision to the graveyard. */
export async function recordGraveyardEntry(entry: GraveyardEntry): Promise<void> {
  await ensureDir();
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(GRAVEYARD_FILE, line, 'utf8');
}

/**
 * Read the most recent N entries, newest first. Tolerant of malformed
 * rows — skips, doesn't throw. Empty when no file yet.
 */
export async function listGraveyardEntries(
  limit = MAX_RETURNED,
): Promise<GraveyardEntry[]> {
  let text: string;
  try {
    text = await fs.readFile(GRAVEYARD_FILE, 'utf8');
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }
    throw err;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: GraveyardEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as GraveyardEntry;
      if (typeof parsed?.subject === 'string' && typeof parsed?.at === 'string') {
        out.push(parsed);
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Find graveyard entries whose subject + reason matches a free-text query.
 * Case-insensitive substring; no FTS5 dependency — graveyard rows are few
 * and we want this to work even when the index isn't available. Optional
 * `business` scope filters to that tag.
 */
export async function searchGraveyard(args: {
  query: string;
  business?: string;
  limit?: number;
}): Promise<GraveyardEntry[]> {
  const limit = args.limit ?? 10;
  const needle = args.query.toLowerCase().trim();
  if (!needle) return [];
  const all = await listGraveyardEntries(MAX_RETURNED);
  return all
    .filter((e) => {
      if (args.business && e.business !== args.business) return false;
      const haystack = `${e.subject} ${e.reason ?? ''}`.toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, limit);
}
