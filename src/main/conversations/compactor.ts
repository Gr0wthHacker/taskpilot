/**
 * 30-day rolling compactor.
 *
 * For every conversation older than `conversation_compression_days` (default
 * 30) and not yet compressed:
 *
 *   1. Read the on-disk JSONL, build a sampled excerpt (first N + last N +
 *      every Mth message in between, ~60KB cap).
 *   2. Write a `SummarizeRequest` to `~/.taskpilot/io/summarize/<id>.json`.
 *   3. Claude reads the request (via the `taskpilot_list_pending_summarizes`
 *      MCP tool, the HTTP endpoint, or the auto-drain skill) and either
 *      writes a response file to `~/.taskpilot/io/summarized/` OR calls
 *      `taskpilot_submit_summary` to short-circuit the file dance.
 *   4. The 1-min poller in this module sweeps `IO_SUMMARIZED/` and applies
 *      valid responses, replacing the digest with the narrative summary.
 *
 * Retention pass clears `source_path` past `conversation_retention_days`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  IO_DONE_ARCHIVE_SUMMARIZE,
  IO_SUMMARIZE,
  IO_SUMMARIZED,
} from '../../shared/constants.js';
import {
  summarizeRequestSchema,
  summarizeResponseSchema,
  type SummarizeRequest,
  type SummarizeResponse,
} from '../../shared/io-schemas.js';
import { ioEvents } from '@/main/io/events';
import { indexConversation } from '@/main/search/indexer';
import {
  getConversation,
  listLinksForConversation,
  listPendingArchive,
  listPendingCompaction,
  updateConversation,
} from '../db/repositories/conversations.js';
import * as settingsRepo from '../db/repositories/settings.js';

import { parseSessionFile } from './parser.js';
import { propagateToTask } from './side-effects.js';

const log = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.log(`[conversations:compactor] ${msg}`, ...rest);
const warn = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.warn(`[conversations:compactor] ${msg}`, ...rest);

const COMPACT_TICK_MS = 60 * 60 * 1_000; // 1h
const POLL_TICK_MS = 60 * 1_000; // 1m
const EXCERPT_BYTE_BUDGET = 60_000;
const EXCERPT_HEAD_TAIL = 6;

function compressionDays(): number {
  const raw = settingsRepo.get<number>('conversation_compression_days');
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return 30;
}

function retentionDays(): number | null {
  const raw = settingsRepo.get<number>('conversation_retention_days');
  if (raw === null || raw === undefined) return 365;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return null;
}

function isoDaysAgo(days: number): string {
  const t = Date.now() - days * 24 * 60 * 60 * 1_000;
  return new Date(t).toISOString();
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

const SUMMARIZE_INSTRUCTIONS = [
  'You are compacting an older conversation for the TaskPilot catalogue.',
  'Read the excerpt (or source_path if present) and produce a concise',
  'narrative summary (2–4 short paragraphs) covering: what was asked, what',
  'was decided, what was produced. Then list topic tags and explicit',
  'decisions. The output replaces the pre-compression digest, so the on-disk',
  'JSONL can be deleted later. Return strictly the SummarizeResponse JSON',
  'schema. Submit via taskpilot_submit_summary or by writing',
  '~/.taskpilot/io/summarized/<conversation_id>.json.',
].join(' ');

/**
 * Build a sampled excerpt from the on-disk JSONL. Returns null when the file
 * is missing/unreadable so callers can fall back to the digest-only request.
 *
 * Sampling: first EXCERPT_HEAD_TAIL turns + last EXCERPT_HEAD_TAIL turns +
 * up to ~20 evenly-spaced middle turns. Stops when byte budget is hit.
 */
async function buildExcerpt(sourcePath: string): Promise<string | null> {
  const parsed = await parseSessionFile(sourcePath).catch(() => null);
  if (!parsed || parsed.messages.length === 0) return null;
  const messages = parsed.messages;

  const indices = new Set<number>();
  const head = Math.min(EXCERPT_HEAD_TAIL, messages.length);
  for (let i = 0; i < head; i++) indices.add(i);
  const tailStart = Math.max(messages.length - EXCERPT_HEAD_TAIL, 0);
  for (let i = tailStart; i < messages.length; i++) indices.add(i);
  const middleCount = 20;
  for (let k = 0; k < middleCount; k++) {
    const idx = Math.floor((messages.length * (k + 1)) / (middleCount + 1));
    indices.add(idx);
  }
  const ordered = Array.from(indices).sort((a, b) => a - b);

  const parts: string[] = [];
  let used = 0;
  for (const i of ordered) {
    const m = messages[i];
    if (!m) continue;
    const block = `[#${i} ${m.role}] ${m.text.slice(0, 4_000)}`;
    if (used + block.length + 2 > EXCERPT_BYTE_BUDGET) break;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join('\n\n');
}

/**
 * One compact pass: dispatch summarize requests for any pending conversations.
 */
export async function dispatchPendingCompactions(): Promise<{
  dispatched: number;
}> {
  const enabled = settingsRepo.get<boolean>('conversations_enabled') ?? true;
  if (!enabled) return { dispatched: 0 };

  const cutoff = isoDaysAgo(compressionDays());
  const pending = listPendingCompaction(cutoff, 25);
  let dispatched = 0;

  for (const conv of pending) {
    const reqPath = path.join(IO_SUMMARIZE, `${conv.id}.json`);
    try {
      await fs.stat(reqPath);
      continue; // already pending
    } catch {
      /* not present → write it */
    }

    let excerpt: string | undefined;
    if (conv.source_path) {
      const built = await buildExcerpt(conv.source_path);
      if (built) excerpt = built;
    }

    const req: SummarizeRequest = {
      request_type: 'summarize',
      conversation_id: conv.id,
      source: conv.source,
      source_id: conv.source_id,
      title: conv.title,
      project_path: conv.project_path,
      source_path: conv.source_path,
      started_at: conv.started_at,
      ended_at: conv.ended_at,
      model: conv.model,
      message_count: conv.message_count,
      current_digest: (conv.digest ?? '').slice(0, 200_000) || null,
      ...(excerpt ? { excerpt } : {}),
      topics: conv.topics.slice(0, 64),
      files_touched: conv.files_touched.slice(0, 200),
      instructions: SUMMARIZE_INSTRUCTIONS,
    };

    try {
      summarizeRequestSchema.parse(req);
      await writeJsonAtomic(reqPath, req);
      dispatched += 1;
    } catch (err) {
      warn(`failed to write summarize request for ${conv.id}`, err);
    }
  }

  if (dispatched > 0) log(`dispatched ${dispatched} summarize requests`);
  return { dispatched };
}

/**
 * Apply a summarize response (from disk or programmatic submit) to the
 * matching conversation row. Returns the updated conversation or null if
 * the row is gone.
 */
export function applySummary(response: SummarizeResponse): {
  ok: boolean;
  conversation: ReturnType<typeof getConversation>;
} {
  const updated = updateConversation(response.conversation_id, {
    digest: response.summary,
    topics: response.topics,
    key_decisions: response.key_decisions,
    title: response.title ?? undefined,
    compressed_at: response.summarized_at,
  });
  if (!updated) return { ok: false, conversation: null };

  // Side effects: re-index for search; propagate fresh decisions to linked
  // tasks (skipping tag_match links — same rule as auto-link); emit event;
  // archive any sitting request file so list_pending_summarizes stops
  // returning the now-fulfilled item.
  try {
    indexConversation(updated.id);
  } catch (err) {
    warn(`index after summary failed for ${updated.id}`, err);
  }
  try {
    const links = listLinksForConversation(updated.id);
    for (const link of links) {
      if (link.kind === 'tag_match') continue;
      propagateToTask(updated, link.task_id, []);
    }
  } catch (err) {
    warn('propagate after summary failed', err);
  }
  // Archive the corresponding IO_SUMMARIZE request file (the submit path
  // bypassed the disk-driven ingest, so it never got moved). Best-effort:
  // file may not exist (e.g. summary submitted before compactor ever
  // dispatched a request).
  void (async () => {
    const reqPath = path.join(IO_SUMMARIZE, `${updated.id}.json`);
    try {
      await fs.mkdir(IO_DONE_ARCHIVE_SUMMARIZE, { recursive: true });
      const stamp = new Date().toISOString().replace(/:/g, '-');
      await fs.rename(
        reqPath,
        path.join(
          IO_DONE_ARCHIVE_SUMMARIZE,
          `${stamp}-req-${updated.id}.json`,
        ),
      );
    } catch {
      /* request file may not exist — fine */
    }
  })();
  try {
    ioEvents.emit('conversation_ingested', {
      conversationId: updated.id,
      sessionId: updated.source_id,
      kind: 'compressed',
      linkedTaskIds: listLinksForConversation(updated.id).map((l) => l.task_id),
    });
  } catch (err) {
    warn('emit after summary failed', err);
  }

  return { ok: true, conversation: updated };
}

/**
 * One ingest pass: read every response file in IO_SUMMARIZED and apply it.
 */
export async function ingestPendingSummaries(): Promise<{ ingested: number }> {
  let entries: string[];
  try {
    entries = await fs.readdir(IO_SUMMARIZED);
  } catch {
    return { ingested: 0 };
  }
  let ingested = 0;
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    const fullPath = path.join(IO_SUMMARIZED, entry);
    let parsed: unknown;
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      parsed = JSON.parse(text);
    } catch (err) {
      warn(`bad summarize response ${entry}`, err);
      continue;
    }
    const result = summarizeResponseSchema.safeParse(parsed);
    if (!result.success) {
      warn(`schema-invalid response ${entry}`, result.error.message);
      continue;
    }
    const data = result.data;
    const applied = applySummary(data);
    if (!applied.ok) {
      warn(`response refers to unknown conversation ${data.conversation_id}`);
      continue;
    }
    ingested += 1;
    // Archive request + response together.
    try {
      await fs.mkdir(IO_DONE_ARCHIVE_SUMMARIZE, { recursive: true });
      const stamp = new Date().toISOString().replace(/:/g, '-');
      await fs
        .rename(
          fullPath,
          path.join(IO_DONE_ARCHIVE_SUMMARIZE, `${stamp}-${entry}`),
        )
        .catch(() => undefined);
      const reqPath = path.join(IO_SUMMARIZE, `${data.conversation_id}.json`);
      await fs
        .rename(
          reqPath,
          path.join(
            IO_DONE_ARCHIVE_SUMMARIZE,
            `${stamp}-req-${data.conversation_id}.json`,
          ),
        )
        .catch(() => undefined);
    } catch (err) {
      warn(`failed to archive consumed ${entry}`, err);
    }
  }
  if (ingested > 0) log(`ingested ${ingested} summaries`);
  return { ingested };
}

/**
 * Force a previously-compressed conversation back into the compaction queue
 * on the next tick. Clears `compressed_at`, removes any stale request file,
 * and returns the updated row. Returns null when the id is unknown.
 *
 * Useful when an early summary was weak and the user wants a fresh attempt
 * (e.g. after improving the SUMMARIZE_INSTRUCTIONS or moving to a stronger
 * model).
 */
export async function recompressConversation(
  id: string,
): Promise<ReturnType<typeof getConversation>> {
  const existing = getConversation(id);
  if (!existing) return null;
  const updated = updateConversation(id, { compressed_at: null });
  // Drop any stale request file so dispatchPendingCompactions re-writes a
  // fresh one with whatever current excerpt/digest is on the row.
  const reqPath = path.join(IO_SUMMARIZE, `${id}.json`);
  try {
    await fs.unlink(reqPath);
  } catch {
    /* not present — fine */
  }
  return updated;
}

/**
 * Retention: clear `source_path` on rows past the retention window.
 */
export function archiveOldSources(): { archived: number } {
  const days = retentionDays();
  if (days === null) return { archived: 0 };
  const cutoff = isoDaysAgo(days);
  const pending = listPendingArchive(cutoff, 200);
  let archived = 0;
  for (const conv of pending) {
    updateConversation(conv.id, {
      source_path: null,
      archived_at: new Date().toISOString(),
    });
    archived += 1;
  }
  if (archived > 0) log(`archived ${archived} source pointers (retention)`);
  return { archived };
}

/**
 * List pending summarize requests parsed from disk. Used by the MCP tool
 * and the HTTP endpoint so a remote / programmatic consumer can drain the
 * queue without filesystem access.
 */
export async function listPendingSummarizeRequests(
  limit = 25,
): Promise<SummarizeRequest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(IO_SUMMARIZE);
  } catch {
    return [];
  }
  const requests: SummarizeRequest[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    if (entry.endsWith('.tmp')) continue;
    const fullPath = path.join(IO_SUMMARIZE, entry);
    try {
      const text = await fs.readFile(fullPath, 'utf8');
      const parsed = summarizeRequestSchema.safeParse(JSON.parse(text));
      if (parsed.success) requests.push(parsed.data);
    } catch {
      /* skip malformed */
    }
    if (requests.length >= limit) break;
  }
  return requests;
}

export interface CompactorHandle {
  stop: () => void;
  runNow: () => Promise<{ dispatched: number; ingested: number; archived: number }>;
}

export function startCompactor(): CompactorHandle {
  const compactTimer = setInterval(() => {
    void dispatchPendingCompactions().catch((err) => warn('dispatch failed', err));
    try {
      archiveOldSources();
    } catch (err) {
      warn('archive failed', err);
    }
  }, COMPACT_TICK_MS);

  const pollTimer = setInterval(() => {
    void ingestPendingSummaries().catch((err) => warn('ingest failed', err));
  }, POLL_TICK_MS);

  void dispatchPendingCompactions().catch((err) =>
    warn('initial dispatch failed', err),
  );
  void ingestPendingSummaries().catch((err) =>
    warn('initial ingest failed', err),
  );

  return {
    stop: () => {
      clearInterval(compactTimer);
      clearInterval(pollTimer);
    },
    runNow: async () => {
      const [d, i] = await Promise.all([
        dispatchPendingCompactions(),
        ingestPendingSummaries(),
      ]);
      const a = archiveOldSources();
      return { dispatched: d.dispatched, ingested: i.ingested, archived: a.archived };
    },
  };
}
