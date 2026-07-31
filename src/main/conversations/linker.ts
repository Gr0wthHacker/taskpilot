/**
 * Match an ingested conversation to existing tasks.
 *
 * Signals, in order of strength:
 *   1. `session_pin`    — Claude wrote session_id into `task.context.claude_session_id`.
 *   2. `execute_result` — task's result file references this session (handled at ingest of result.json).
 *   3. `cwd_match`      — `task.context.cwd` == session.cwd within ±6h.
 *   4. `tag_match`      — overlap between session topics and task.tags (case-insensitive).
 *
 * File-path overlap (session.files_touched ∩ task.context.attachments) is
 * also checked as a `cwd_match`-equivalent signal — if a session worked on a
 * file the task has attached, that's a strong link.
 *
 * Idempotent — re-running for the same conversation only upgrades link kind.
 */

import { and, gte, lte } from 'drizzle-orm';

import { tasks } from '../../shared/schema.js';
import type { Task } from '../../shared/types.js';
import { getDb } from '../db/index.js';
import {
  linkConversationToTask,
  type LinkInput,
} from '../db/repositories/conversations.js';

import type { ParsedSession } from './parser.js';

function normalizeCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  return cwd.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function taskCwdMatches(task: Task, target: string): boolean {
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return false;
  const candidate = (ctx as Record<string, unknown>).cwd;
  if (typeof candidate !== 'string') return false;
  return normalizeCwd(candidate) === target;
}

function taskSessionPin(task: Task, sessionId: string): boolean {
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return false;
  const pin = (ctx as Record<string, unknown>).claude_session_id;
  return pin === sessionId;
}

function taskFilesOverlap(task: Task, sessionFiles: Set<string>): boolean {
  if (sessionFiles.size === 0) return false;
  const ctx = task.context;
  if (!ctx || typeof ctx !== 'object') return false;
  const attachments = (ctx as Record<string, unknown>).attachments;
  if (!Array.isArray(attachments)) return false;
  for (const a of attachments) {
    if (typeof a === 'string' && sessionFiles.has(normalizePath(a))) return true;
    if (
      a &&
      typeof a === 'object' &&
      typeof (a as { filename?: unknown }).filename === 'string'
    ) {
      if (sessionFiles.has(normalizePath((a as { filename: string }).filename)))
        return true;
    }
  }
  return false;
}

function tagOverlap(task: Task, topics: Set<string>): boolean {
  if (topics.size === 0 || task.tags.length === 0) return false;
  for (const t of task.tags) {
    if (topics.has(t.toLowerCase())) return true;
  }
  return false;
}

export interface AutoLinkResult {
  /** Every task that got linked, regardless of kind. */
  linkedTaskIds: string[];
  /** Subset of linkedTaskIds where the kind is strong enough to propagate side effects (i.e. NOT tag_match). */
  strongLinkedTaskIds: string[];
}

/**
 * Auto-link a just-ingested conversation. Returns the matched task ids so
 * callers can do downstream work (decisions/outputs integration, SSE event).
 */
export function autoLinkConversation(
  conversationId: string,
  session: ParsedSession,
  sessionTopics: string[] = [],
): AutoLinkResult {
  const db = getDb();
  const normCwd = normalizeCwd(session.cwd);
  const sessionFiles = new Set(session.messages.flatMap((m) => m.files_touched).map(normalizePath));
  const topics = new Set(sessionTopics.map((t) => t.toLowerCase()));

  // ±12h window — wider than before since tag/file matches don't depend on
  // tight timing.
  const windowMs = 12 * 60 * 60 * 1_000;
  const startTs = new Date(
    new Date(session.started_at).getTime() - windowMs,
  ).toISOString();
  const endTs = new Date(
    new Date(session.ended_at).getTime() + windowMs,
  ).toISOString();

  const rows = db
    .select()
    .from(tasks)
    .where(and(gte(tasks.updated_at, startTs), lte(tasks.updated_at, endTs)))
    .limit(1000)
    .all();

  const linkedTaskIds: string[] = [];
  const strongLinkedTaskIds: string[] = [];
  for (const row of rows) {
    let ctx: Record<string, unknown> | null = null;
    if (row.context) {
      try {
        const parsed: unknown = JSON.parse(row.context);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          ctx = parsed as Record<string, unknown>;
        }
      } catch {
        ctx = null;
      }
    }
    let tags: string[] = [];
    if (row.tags) {
      try {
        const parsed: unknown = JSON.parse(row.tags);
        if (Array.isArray(parsed)) {
          tags = parsed.filter((t): t is string => typeof t === 'string');
        }
      } catch {
        tags = [];
      }
    }
    const taskShape = { id: row.id, context: ctx, tags } as unknown as Task;

    let link: LinkInput | null = null;
    if (taskSessionPin(taskShape, session.session_id)) {
      link = {
        conversation_id: conversationId,
        task_id: row.id,
        kind: 'session_pin',
        confidence: 1.0,
      };
    } else if (normCwd && taskCwdMatches(taskShape, normCwd)) {
      link = {
        conversation_id: conversationId,
        task_id: row.id,
        kind: 'cwd_match',
        confidence: 0.7,
      };
    } else if (taskFilesOverlap(taskShape, sessionFiles)) {
      link = {
        conversation_id: conversationId,
        task_id: row.id,
        kind: 'cwd_match',
        confidence: 0.6,
      };
    } else if (tagOverlap(taskShape, topics)) {
      link = {
        conversation_id: conversationId,
        task_id: row.id,
        kind: 'tag_match',
        confidence: 0.4,
      };
    }

    if (link) {
      linkConversationToTask(link);
      linkedTaskIds.push(row.id);
      if (link.kind !== 'tag_match') strongLinkedTaskIds.push(row.id);
      if (linkedTaskIds.length >= 20) break; // sanity cap
    }
  }

  return { linkedTaskIds, strongLinkedTaskIds };
}
