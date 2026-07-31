/**
 * Read side of the encrypted audit log. Powers `GET /api/audit/recent` and the
 * future renderer Audit view.
 *
 * Files are JSONL — read each line, decrypt independently, drop malformed
 * rows. Newest events are at the END of each file (append-only), so we read
 * the last N files newest-first and then iterate each file's lines bottom-up
 * until we hit `limit`.
 *
 * The reader is intentionally synchronous: better-sqlite3 + Express handlers
 * are sync, the data volumes are tiny (a few thousand short events per file
 * even on a chatty day), and a sync read keeps the route handler trivial.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AUDIT_DIR } from '@/shared/constants';

import { type AuditEvent, deserializeAuditLine } from './log';

/* -------------------------------------------------------------------------- */
/*  Filename helpers                                                           */
/* -------------------------------------------------------------------------- */

const FILE_REGEX = /^ambient-(\d{4})-(\d{2})\.jsonl\.enc$/;

interface AuditFileEntry {
  path: string;
  /** `YYYY-MM` — newest sorts to the end alphabetically, so we iterate desc. */
  key: string;
}

/**
 * List every per-month audit file in the audit directory, sorted descending
 * (newest first). Missing directory → empty list.
 */
function listAuditFiles(): AuditFileEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(AUDIT_DIR);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    return [];
  }
  const entries: AuditFileEntry[] = [];
  for (const name of names) {
    const m = FILE_REGEX.exec(name);
    if (!m) continue;
    entries.push({
      path: path.join(AUDIT_DIR, name),
      key: `${m[1]}-${m[2]}`,
    });
  }
  entries.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return entries;
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReadRecentAuditEventsOptions {
  /** Default 100. Capped at 5000 to protect the HTTP route. */
  limit?: number;
  /** Filter: only return events whose kind matches. Case-sensitive. */
  kind?: string;
  /** Filter: only return events with ts >= since (ISO string). */
  since?: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 5_000;

/**
 * Return the most recent decrypted events, newest first.
 *
 * Honors the optional `kind` + `since` filters. Skips any line that fails to
 * decode — the underlying log is append-only and crash-tolerant, but rotation
 * or external edits could still leave a torn row.
 */
export function readRecentAuditEvents(
  options: ReadRecentAuditEventsOptions = {},
): AuditEvent[] {
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)),
  );
  const out: AuditEvent[] = [];
  const files = listAuditFiles();

  for (const file of files) {
    if (out.length >= limit) break;
    let raw: string;
    try {
      raw = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    // Walk lines bottom-up so the newest event lands first in `out`.
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || line.length === 0) continue;
      const event = deserializeAuditLine(line);
      if (!event) continue;
      if (options.kind && event.kind !== options.kind) continue;
      if (options.since && event.ts < options.since) continue;
      out.push(event);
      if (out.length >= limit) break;
    }
  }

  return out;
}

/**
 * Count the number of readable audit files. Used by the status route + tests.
 */
export function countAuditFiles(): number {
  return listAuditFiles().length;
}
