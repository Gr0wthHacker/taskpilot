/**
 * File-backed storage for per-business status data.
 *
 * Layout under `~/.taskpilot/businesses/<tag>/`:
 *
 *   updates.jsonl   append-only log of every status delta (newest at bottom)
 *   status.json     last computed snapshot (also exposed via the HTTP API)
 *   STATUS.md       human-readable rendering of `status.json`
 *
 * The JSONL is the source-of-truth for deltas; `status.json` + `STATUS.md`
 * are derivable. Deleting either is safe — the next snapshot computation
 * will rewrite them. The directory is created lazily on first write so a
 * fresh install doesn't sprawl empty folders.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { businessTagSchema } from './loader';

export const BUSINESSES_DIR = path.join(TASKPILOT_HOME, 'businesses');

const MAX_UPDATES_RETURNED = 200;

export interface StatusUpdate {
  /** ISO timestamp the update was recorded at. */
  at: string;
  /** Free-text headline — 1 line, max ~280 chars. */
  headline: string;
  /** Optional longer body describing what changed. */
  what_changed?: string;
  /** Optional source — session id, repo, conversation id, etc. */
  source?: string;
  /** Optional links surfaced alongside the entry. */
  links?: Array<{ label: string; url: string }>;
}

function assertTag(tag: string): void {
  const r = businessTagSchema.safeParse(tag);
  if (!r.success) {
    throw new Error(`Invalid business tag: ${JSON.stringify(tag)}`);
  }
}

function businessDir(tag: string): string {
  assertTag(tag);
  return path.join(BUSINESSES_DIR, tag);
}

export function updatesFilePath(tag: string): string {
  return path.join(businessDir(tag), 'updates.jsonl');
}

export function statusJsonPath(tag: string): string {
  return path.join(businessDir(tag), 'status.json');
}

export function statusMdPath(tag: string): string {
  return path.join(businessDir(tag), 'STATUS.md');
}

async function ensureBusinessDir(tag: string): Promise<string> {
  const dir = businessDir(tag);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Append a status update to `<tag>/updates.jsonl`. The file is JSONL so
 * concurrent writers do not corrupt earlier rows. Returns the canonicalised
 * record that was written.
 */
export async function appendUpdate(
  tag: string,
  update: StatusUpdate,
): Promise<StatusUpdate> {
  await ensureBusinessDir(tag);
  const line = `${JSON.stringify(update)}\n`;
  await fs.appendFile(updatesFilePath(tag), line, 'utf8');
  return update;
}

/**
 * Read the most recent N updates for a business (newest first). Tolerant of
 * malformed lines — a broken row is skipped, not surfaced. Returns an empty
 * list when the JSONL doesn't exist.
 */
export async function readUpdates(
  tag: string,
  limit = MAX_UPDATES_RETURNED,
): Promise<StatusUpdate[]> {
  assertTag(tag);
  let text: string;
  try {
    text = await fs.readFile(updatesFilePath(tag), 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: StatusUpdate[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]!) as StatusUpdate;
      if (typeof parsed?.at === 'string' && typeof parsed?.headline === 'string') {
        out.push(parsed);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Persist the rendered status snapshot to `status.json` + `STATUS.md`. */
export async function writeSnapshot(
  tag: string,
  snapshotJson: unknown,
  statusMd: string,
): Promise<void> {
  await ensureBusinessDir(tag);
  await fs.writeFile(
    statusJsonPath(tag),
    `${JSON.stringify(snapshotJson, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(statusMdPath(tag), statusMd, 'utf8');
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
