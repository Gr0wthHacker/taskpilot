/**
 * Gmail → TaskPilot capture loop.
 *
 * Polls Gmail every ~2 minutes for messages matching the user's capture
 * query (default `is:starred newer_than:7d`). New message ids are
 * deduped against the persisted `gmail_messages_imported` setting; each
 * new message becomes an inbox task with the message id stored in
 * `task.context.gmail_message_id` so the task and the source email stay
 * linked.
 *
 * The loop respects `agent_paused`. Gmail not configured / not authed is
 * a quiet no-op so app boot isn't blocked by missing setup.
 */

import * as settingsRepo from '@/main/db/repositories/settings';
import * as tasksRepo from '@/main/db/repositories/tasks';

import {
  GmailAuthError,
  GmailNotConfiguredError,
  getStatus,
} from './auth';
import {
  applyLabel,
  getMessage,
  getOrCreateLabel,
  listMessages,
  type FullMessage,
} from './operations';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const POLL_INTERVAL_MS = 2 * 60 * 1_000;
const IMPORTED_CAP = 1_000;
const DEFAULT_QUERY = 'is:starred newer_than:7d';
const DEFAULT_IMPORT_LABEL = 'TaskPilot/imported';

/* -------------------------------------------------------------------------- */
/*  Settings helpers                                                          */
/* -------------------------------------------------------------------------- */

function readCaptureQuery(): string {
  try {
    const raw = settingsRepo.get<unknown>('gmail_capture_query');
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  } catch {
    /* fall through */
  }
  return DEFAULT_QUERY;
}

function readImportLabel(): string {
  try {
    const raw = settingsRepo.get<unknown>('gmail_import_label');
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  } catch {
    /* fall through */
  }
  return DEFAULT_IMPORT_LABEL;
}

function readImportedIds(): string[] {
  try {
    const raw = settingsRepo.get<unknown>('gmail_messages_imported');
    if (Array.isArray(raw)) {
      return raw.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
}

function persistImportedIds(ids: string[]): void {
  // Keep the most recent IMPORTED_CAP — older ids fall off so the setting
  // payload stays bounded. Newest at the front.
  const trimmed = ids.slice(0, IMPORTED_CAP);
  settingsRepo.set('gmail_messages_imported', trimmed);
}

function isAgentPaused(): boolean {
  try {
    const raw = settingsRepo.get<unknown>('agent_paused');
    return raw === true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Task creation                                                             */
/* -------------------------------------------------------------------------- */

function looksLikeFollowUp(subject: string): boolean {
  // Strip leading whitespace; case-insensitive match for the common reply
  // prefixes. We treat anything that's already a reply as needing a
  // "Re:" title (mirrors what a human-written follow-up would look like).
  const trimmed = subject.trimStart();
  return /^(re:|fwd:|fw:)/i.test(trimmed);
}

function buildTaskTitle(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return 'Gmail: (no subject)';
  if (looksLikeFollowUp(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

function buildTaskDescription(msg: FullMessage): string {
  const head = (msg.bodyText || msg.snippet || '').slice(0, 2_000);
  const sep = head.length > 0 ? '\n\n' : '';
  return `${head}${sep}— From Gmail: ${msg.permalink}`;
}

/**
 * Convert any Gmail labels matching the `tp-<tag>` convention into
 * TaskPilot tags. Built-in labels (INBOX, SENT, etc.) are ignored.
 */
function tagsFromLabels(labelIds: string[]): string[] {
  const out: string[] = ['gmail'];
  for (const id of labelIds) {
    if (id.startsWith('Label_')) continue;
    if (id.startsWith('tp-')) out.push(id.slice(3));
  }
  return out;
}

export interface CaptureResult {
  imported: number;
  skipped: number;
  errors: Array<{ messageId?: string; error: string }>;
}

/**
 * Run one capture pass. Idempotent — already-imported ids are skipped.
 * Safe to call from a route handler or the periodic loop.
 *
 * Returns counts even when Gmail isn't configured — callers can surface
 * `imported: 0` without erroring out.
 */
export async function captureOnce(): Promise<CaptureResult> {
  const result: CaptureResult = { imported: 0, skipped: 0, errors: [] };

  // Pre-flight: connection state + pause check.
  if (isAgentPaused()) return result;
  let status;
  try {
    status = await getStatus();
  } catch {
    return result;
  }
  if (!status.connected) return result;

  const query = readCaptureQuery();
  const importLabel = readImportLabel();
  let importedIds = readImportedIds();
  const importedSet = new Set(importedIds);

  let messages: Awaited<ReturnType<typeof listMessages>>['messages'];
  try {
    const listed = await listMessages({ q: query, maxResults: 50 });
    messages = listed.messages;
  } catch (err) {
    if (err instanceof GmailNotConfiguredError || err instanceof GmailAuthError) {
      return result;
    }
    result.errors.push({ error: (err as Error).message });
    return result;
  }

  // Resolve the import label id once per pass — applying it to each new
  // message is what makes the user able to filter "TaskPilot already saw
  // this" inside Gmail.
  let importLabelId: string | null = null;
  if (importLabel) {
    try {
      importLabelId = await getOrCreateLabel(importLabel);
    } catch {
      importLabelId = null;
    }
  }

  for (const ref of messages) {
    if (importedSet.has(ref.id)) {
      result.skipped += 1;
      continue;
    }
    let msg: FullMessage;
    try {
      msg = await getMessage(ref.id);
    } catch (err) {
      result.errors.push({ messageId: ref.id, error: (err as Error).message });
      continue;
    }

    try {
      tasksRepo.createTask({
        title: buildTaskTitle(msg.subject),
        description: buildTaskDescription(msg),
        status: 'inbox',
        priority: 'p2',
        agent_method: 'human_only',
        agent_executable: false,
        tags: tagsFromLabels(msg.labelIds),
        context: {
          gmail_message_id: msg.id,
          gmail_thread_id: msg.threadId,
          gmail_from: msg.from,
          gmail_subject: msg.subject,
          gmail_permalink: msg.permalink,
          gmail_snippet: msg.snippet,
        },
      });
    } catch (err) {
      result.errors.push({ messageId: ref.id, error: (err as Error).message });
      continue;
    }

    importedSet.add(ref.id);
    importedIds = [ref.id, ...importedIds];
    result.imported += 1;

    if (importLabelId) {
      try {
        await applyLabel(msg.id, { add: [importLabelId] });
      } catch (err) {
        // Labeling failure is informational — task already exists.
        result.errors.push({
          messageId: ref.id,
          error: `label apply failed: ${(err as Error).message}`,
        });
      }
    }
  }

  persistImportedIds(importedIds);
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Background loop                                                           */
/* -------------------------------------------------------------------------- */

let intervalHandle: NodeJS.Timeout | null = null;
let running = false;

async function runSafely(reason: string): Promise<void> {
  if (running) return;
  running = true;
  try {
    const res = await captureOnce();
    if (res.imported > 0 || res.errors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[gmail/capture] ${reason}: imported=${res.imported} skipped=${res.skipped} errors=${res.errors.length}`,
      );
      for (const err of res.errors) {
        // eslint-disable-next-line no-console
        console.warn('[gmail/capture] error', err);
      }
    }
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.error('[gmail/capture] unexpected:', (err as Error).message);
  } finally {
    running = false;
  }
}

/**
 * Kick off the periodic capture loop. Idempotent — calling twice is a no-op.
 * The first pass runs immediately (best-effort) and subsequent passes run
 * every POLL_INTERVAL_MS. Stop the loop with `stopGmailCapture()`.
 */
export function startGmailCapture(): void {
  if (intervalHandle !== null) return;
  void runSafely('startup');
  intervalHandle = setInterval(() => {
    void runSafely('interval');
  }, POLL_INTERVAL_MS);
}

export function stopGmailCapture(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
