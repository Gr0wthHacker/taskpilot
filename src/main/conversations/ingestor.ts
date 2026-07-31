/**
 * Conversations ingestor.
 *
 * Watches `~/.claude/projects/<project-hash>/*.jsonl` for new + modified
 * session transcripts, parses them via `parseSessionFile`, builds a digest,
 * upserts a `conversations` row, auto-links to tasks, propagates decisions
 * + references to those tasks, indexes into FTS5 search, and emits an
 * `ioEvents.conversation_ingested` event so the UI auto-refreshes.
 *
 * Implementation notes:
 *   - chokidar with a coarse (10-min) polling fallback. Per-file throttle
 *     (60s) plus content-hash dedupe prevents re-parsing the same file when
 *     Claude Code appends to it during a live session.
 *   - dispatchMap is LRU-capped at 2000 entries so long-running installs
 *     don't leak.
 *   - Every step (parse, link, propagate, index, event) is wrapped in
 *     best-effort try/catch — the catalogue must never block the app.
 */

import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { computeCost, lookupPricing } from '@/main/cost-tracking/pricing';
import { ioEvents } from '@/main/io/events';
import { indexConversation } from '@/main/search/indexer';
import {
  createConversation,
  findBySourceId,
  getConversation,
  updateConversation,
} from '../db/repositories/conversations.js';
import * as settingsRepo from '../db/repositories/settings.js';

import { buildDigest } from './digest.js';
import { autoLinkConversation } from './linker.js';
import { parseSessionFile, type ParsedSession } from './parser.js';
import { claudeProjectsDir } from './paths.js';
import { propagateToTask } from './side-effects.js';

const log = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.log(`[conversations] ${msg}`, ...rest);

const warn = (msg: string, ...rest: unknown[]) =>
  // eslint-disable-next-line no-console
  console.warn(`[conversations] ${msg}`, ...rest);

const PER_FILE_MIN_REPARSE_MS = 60_000;
const RECONCILE_TICK_MS = 10 * 60 * 1_000; // 10 min — chokidar handles primary events
const DISPATCH_MAP_MAX = 2_000;

interface ParseDispatch {
  lastDispatched: number;
}

// LRU-ish: Map preserves insertion order; on `set` we delete-then-set so the
// fresh entry moves to the tail. On overflow we delete the oldest (head).
const dispatchMap = new Map<string, ParseDispatch>();

function touchDispatch(filePath: string): void {
  dispatchMap.delete(filePath);
  dispatchMap.set(filePath, { lastDispatched: Date.now() });
  if (dispatchMap.size > DISPATCH_MAP_MAX) {
    const oldest = dispatchMap.keys().next().value;
    if (oldest !== undefined) dispatchMap.delete(oldest);
  }
}

function isEnabled(): boolean {
  const v = settingsRepo.get<boolean>('conversations_enabled');
  return v === null || v === undefined ? true : !!v;
}

function isJsonl(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.jsonl');
}

const unknownModelsLogged = new Set<string>();

/**
 * Compute USD cost from token counts using the existing pricing module.
 * Returns null when no model is known (so we don't store a fake $0).
 * Logs one warning per unseen model so the user knows to extend the
 * pricing table when a session uses a model TaskPilot doesn't know about.
 */
function computeCostFor(parsed: ParsedSession): number | null {
  if (!parsed.model) return null;
  try {
    const pricing = lookupPricing(parsed.model);
    if (!pricing) {
      if (!unknownModelsLogged.has(parsed.model)) {
        unknownModelsLogged.add(parsed.model);
        warn(
          `no pricing entry for model "${parsed.model}" — cost_usd will be null for sessions on this model. Add it to src/main/cost-tracking/pricing.ts HARDCODED_PRICING.`,
        );
      }
      return null;
    }
    const usd = computeCost({
      model: parsed.model,
      input: parsed.input_tokens,
      output: parsed.output_tokens,
      cache_read: parsed.cache_read_tokens,
      cache_creation: parsed.cache_creation_tokens,
    });
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

async function ingestOne(filePath: string): Promise<void> {
  const now = Date.now();
  const prior = dispatchMap.get(filePath);
  if (prior && now - prior.lastDispatched < PER_FILE_MIN_REPARSE_MS) {
    return;
  }
  touchDispatch(filePath);

  let parsed: ParsedSession | null;
  try {
    parsed = await parseSessionFile(filePath);
  } catch (err) {
    warn(`failed to parse ${filePath}`, err);
    return;
  }
  if (!parsed) return;

  const existing = findBySourceId('claude_code', parsed.session_id);
  if (existing && existing.content_hash === parsed.content_hash) {
    return; // unchanged
  }

  const digest = buildDigest(parsed);
  const cost = computeCostFor(parsed);

  let conversationId: string;
  let kind: 'created' | 'updated' = 'created';

  if (existing) {
    kind = 'updated';
    updateConversation(existing.id, {
      source_path: filePath,
      project_path: parsed.cwd,
      title: digest.title,
      started_at: parsed.started_at,
      ended_at: parsed.ended_at,
      model: parsed.model,
      message_count: parsed.messages.length,
      input_tokens: parsed.input_tokens || null,
      output_tokens: parsed.output_tokens || null,
      cache_read_tokens: parsed.cache_read_tokens || null,
      cache_creation_tokens: parsed.cache_creation_tokens || null,
      cost_usd: cost,
      digest: digest.digest,
      topics: digest.topics,
      key_decisions: digest.key_decisions,
      files_touched: digest.files_touched,
      content_hash: parsed.content_hash,
    });
    conversationId = existing.id;
  } else {
    const created = createConversation({
      id: '',
      source: 'claude_code',
      source_id: parsed.session_id,
      source_path: filePath,
      project_path: parsed.cwd,
      title: digest.title,
      started_at: parsed.started_at,
      ended_at: parsed.ended_at,
      model: parsed.model,
      message_count: parsed.messages.length,
      input_tokens: parsed.input_tokens || null,
      output_tokens: parsed.output_tokens || null,
      cache_read_tokens: parsed.cache_read_tokens || null,
      cache_creation_tokens: parsed.cache_creation_tokens || null,
      cost_usd: cost,
      digest: digest.digest,
      topics: digest.topics,
      key_decisions: digest.key_decisions,
      files_touched: digest.files_touched,
      compressed_at: null,
      archived_at: null,
      content_hash: parsed.content_hash,
    });
    conversationId = created.id;
  }

  // Side effects: link, propagate, index, emit.
  let linkedTaskIds: string[] = [];
  let strongLinkedTaskIds: string[] = [];
  try {
    const linkResult = autoLinkConversation(
      conversationId,
      parsed,
      digest.topics,
    );
    linkedTaskIds = linkResult.linkedTaskIds;
    // Only propagate decisions when the link is something stronger than
    // tag overlap — tag_match alone is too noisy to mutate task decision logs.
    strongLinkedTaskIds = linkResult.strongLinkedTaskIds;
  } catch (err) {
    warn('auto-link failed', err);
  }

  if (strongLinkedTaskIds.length > 0) {
    const conv = getConversation(conversationId);
    if (conv) {
      const smallCode = parsed.messages
        .flatMap((m) => m.code_blocks)
        .filter((b) => b.length > 0 && b.length <= 1024);
      for (const taskId of strongLinkedTaskIds) {
        try {
          propagateToTask(conv, taskId, smallCode);
        } catch (err) {
          warn(`propagate to task ${taskId} failed`, err);
        }
      }
    }
  }

  try {
    indexConversation(conversationId);
  } catch (err) {
    warn('search index failed', err);
  }

  try {
    ioEvents.emit('conversation_ingested', {
      conversationId,
      sessionId: parsed.session_id,
      kind,
      linkedTaskIds,
    });
  } catch (err) {
    warn('emit failed', err);
  }
}

export interface ReconcileOptions {
  /** When true, count files that would be ingested without actually ingesting. */
  dry_run?: boolean;
  /** Hard cap on files processed in this call. Default 5000. */
  max_sessions?: number;
}

export interface ReconcileResult {
  scanned: number;
  /** Only populated when dry_run=true — count without DB writes. */
  would_scan?: number;
}

/**
 * Walk every existing JSONL once. Called at boot AND from the manual
 * `/api/conversations/reconcile` endpoint.
 *
 * On a fresh install with a year of Claude Code history a full reconcile
 * can read hundreds of JSONL files. `max_sessions` caps the per-call work
 * so callers can incrementally drain large backlogs; `dry_run` returns
 * the count without ingesting so the UI can warn before kicking off a
 * long-running operation.
 */
export async function reconcile(
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  if (!isEnabled()) return { scanned: 0 };
  const dryRun = opts.dry_run === true;
  const maxSessions = Math.max(1, Math.min(opts.max_sessions ?? 5_000, 50_000));
  const root = claudeProjectsDir();
  const fs = await import('node:fs/promises');
  let scanned = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    warn(`projects root not readable: ${root}`, err);
    return { scanned: 0 };
  }
  for (const entry of entries) {
    const dir = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!isJsonl(f)) continue;
      if (scanned >= maxSessions) break;
      const full = path.join(dir, f);
      if (dryRun) {
        scanned += 1;
        continue;
      }
      // bypass throttle on the boot reconcile by clearing the dispatch entry
      dispatchMap.delete(full);
      await ingestOne(full);
      scanned += 1;
    }
    if (scanned >= maxSessions) break;
  }
  return dryRun ? { scanned: 0, would_scan: scanned } : { scanned };
}

export interface ConversationIngestorHandle {
  stop: () => Promise<void>;
  rescan: () => Promise<ReconcileResult>;
}

export function startConversationIngestor(): ConversationIngestorHandle {
  if (!isEnabled()) {
    log('disabled via conversations_enabled — ingestor not started');
    return {
      stop: async () => {
        /* noop */
      },
      rescan: async () => ({ scanned: 0 }),
    };
  }

  const root = claudeProjectsDir();
  log(`watching ${root}`);
  let watcher: FSWatcher | null = null;

  try {
    watcher = chokidar.watch(path.join(root, '**', '*.jsonl'), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      usePolling: false,
    });
    watcher.on('add', (p) => void ingestOne(p));
    watcher.on('change', (p) => void ingestOne(p));
    watcher.on('error', (err) => warn('watcher error', err));
  } catch (err) {
    warn('failed to start chokidar', err);
  }

  // Coarse polling fallback. Chokidar handles the primary event stream; this
  // is just belt-and-suspenders for Windows fs-event misses on writes from
  // external processes (Claude Code in particular).
  const pollHandle = setInterval(() => {
    void reconcile().catch((err) => warn('poll reconcile failed', err));
  }, RECONCILE_TICK_MS);

  return {
    stop: async () => {
      clearInterval(pollHandle);
      if (watcher) {
        try {
          await watcher.close();
        } catch {
          /* swallow */
        }
      }
      log('ingestor stopped');
    },
    rescan: () => reconcile(),
  };
}
