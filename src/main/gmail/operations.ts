/**
 * Gmail API operations.
 *
 * Thin wrapper around `google.gmail('v1')` that exposes the subset of
 * functionality TaskPilot needs:
 *  - `listMessages` — search for matching messages (used by capture).
 *  - `getMessage` — fetch a full message, with body extraction.
 *  - `createDraft` — RFC 822 + base64url, stored as draft on the user's account.
 *  - `sendMessage` — send a draft (or build one in-flight) — guarded by
 *    `gmail_send_enabled` setting + `gmail.send` OAuth scope.
 *  - `applyLabel` / `getOrCreateLabel` — label management for the capture loop.
 *
 * The OAuth client comes from `./auth.getOauthClient()`. Send-on-behalf is
 * additionally gated by `isSendAllowed()` — the route layer calls it first
 * so the 403 has a clean error code.
 */

import { google, type gmail_v1 } from 'googleapis';

import {
  GmailApiError,
  GmailAuthError,
  GmailNotConfiguredError,
  getOauthClient,
  isSendAllowed,
} from './auth';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

async function getClient(): Promise<gmail_v1.Gmail> {
  const auth = await getOauthClient();
  return google.gmail({ version: 'v1', auth });
}

function wrapError(err: unknown, fallback: string): never {
  if (
    err instanceof GmailApiError ||
    err instanceof GmailAuthError ||
    err instanceof GmailNotConfiguredError
  ) {
    throw err;
  }
  const e = err as { message?: string; code?: number; response?: { status?: number } };
  const status = e.response?.status ?? (typeof e.code === 'number' ? e.code : 500);
  const message = e.message ?? fallback;
  if (status === 401 || status === 403) {
    throw new GmailAuthError(message, status);
  }
  throw new GmailApiError(message, status);
}

/* -------------------------------------------------------------------------- */
/*  Listing                                                                   */
/* -------------------------------------------------------------------------- */

export interface ListMessagesOptions {
  /**
   * Gmail search query (same syntax as the web UI search box).
   * Examples: `is:starred`, `is:starred newer_than:7d`,
   * `from:foo@example.com label:TaskPilot`.
   */
  q: string;
  maxResults?: number;
  pageToken?: string;
}

export interface MessageRef {
  id: string;
  threadId: string;
}

export async function listMessages(opts: ListMessagesOptions): Promise<{
  messages: MessageRef[];
  nextPageToken?: string;
}> {
  const client = await getClient();
  try {
    const res = await client.users.messages.list({
      userId: 'me',
      q: opts.q,
      maxResults: Math.min(Math.max(opts.maxResults ?? 50, 1), 500),
      pageToken: opts.pageToken,
    });
    const messages: MessageRef[] = (res.data.messages ?? [])
      .filter((m) => typeof m.id === 'string' && typeof m.threadId === 'string')
      .map((m) => ({ id: m.id as string, threadId: m.threadId as string }));
    const out: { messages: MessageRef[]; nextPageToken?: string } = { messages };
    if (res.data.nextPageToken) out.nextPageToken = res.data.nextPageToken;
    return out;
  } catch (err) {
    wrapError(err, 'listMessages failed');
  }
}

/* -------------------------------------------------------------------------- */
/*  Fetch + parse                                                             */
/* -------------------------------------------------------------------------- */

export interface FullMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  bodyText: string;
  permalink: string;
}

function findHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (typeof h.name === 'string' && h.name.toLowerCase() === lower) {
      return typeof h.value === 'string' ? h.value : '';
    }
  }
  return '';
}

function decodeBase64Url(input: string): string {
  // Gmail uses base64url with no padding. Normalize then decode.
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Walk a message part tree and extract the first text/plain body.
 * Falls back to stripped text/html if no plain part exists.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  const parts: gmail_v1.Schema$MessagePart[] = [];
  const visit = (p: gmail_v1.Schema$MessagePart): void => {
    parts.push(p);
    if (Array.isArray(p.parts)) for (const child of p.parts) visit(child);
  };
  visit(payload);

  const findByMime = (mime: string): string => {
    for (const part of parts) {
      if (part.mimeType === mime && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    return '';
  };

  const plain = findByMime('text/plain');
  if (plain) return plain;
  const html = findByMime('text/html');
  if (html) {
    // Crude HTML→text — strip tags, normalize whitespace. Good enough for
    // capture-loop summaries; the user can always click through to Gmail.
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

export function buildPermalink(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${messageId}`;
}

export async function getMessage(messageId: string): Promise<FullMessage> {
  const client = await getClient();
  try {
    const res = await client.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const raw = res.data;
    const headers = raw.payload?.headers;
    const out: FullMessage = {
      id: raw.id ?? messageId,
      threadId: raw.threadId ?? '',
      labelIds: Array.isArray(raw.labelIds) ? raw.labelIds : [],
      snippet: raw.snippet ?? '',
      subject: findHeader(headers, 'Subject'),
      from: findHeader(headers, 'From'),
      to: findHeader(headers, 'To'),
      date: findHeader(headers, 'Date') || null,
      bodyText: extractBody(raw.payload ?? undefined),
      permalink: buildPermalink(raw.id ?? messageId),
    };
    return out;
  } catch (err) {
    wrapError(err, 'getMessage failed');
  }
}

/* -------------------------------------------------------------------------- */
/*  Drafts + send                                                             */
/* -------------------------------------------------------------------------- */

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  /** Optional cc/bcc — comma-separated address lists. */
  cc?: string;
  bcc?: string;
  /**
   * If set, the draft is created as a reply within the existing thread.
   * The server sets In-Reply-To + References headers and threadId on the
   * raw payload so Gmail threads the conversation correctly.
   */
  inReplyToMessageId?: string;
}

export interface DraftResult {
  draft_id: string;
  message_id: string;
}

/**
 * Build the RFC-822 MIME blob for a draft/send. Headers are minimal — no
 * fancy multipart handling. UTF-8 plain body only.
 */
function buildRawMessage(input: DraftInput, headersExtra: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`To: ${input.to}`);
  if (input.cc) lines.push(`Cc: ${input.cc}`);
  if (input.bcc) lines.push(`Bcc: ${input.bcc}`);
  lines.push(`Subject: ${input.subject}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 7bit');
  for (const [k, v] of Object.entries(headersExtra)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('');
  lines.push(input.body);
  const message = lines.join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function createDraft(input: DraftInput): Promise<DraftResult> {
  const client = await getClient();
  // If this is a reply, look up the source message to pull threadId +
  // Message-ID for proper threading. Failures here downgrade to a fresh
  // (un-threaded) draft rather than blowing up.
  let threadId: string | undefined;
  const headersExtra: Record<string, string> = {};
  if (input.inReplyToMessageId) {
    try {
      const source = await getMessage(input.inReplyToMessageId);
      threadId = source.threadId || undefined;
      const sourceHeaders = await client.users.messages.get({
        userId: 'me',
        id: input.inReplyToMessageId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });
      const sourceMessageId = findHeader(
        sourceHeaders.data.payload?.headers,
        'Message-ID',
      );
      const sourceReferences = findHeader(
        sourceHeaders.data.payload?.headers,
        'References',
      );
      if (sourceMessageId) {
        headersExtra['In-Reply-To'] = sourceMessageId;
        headersExtra['References'] = sourceReferences
          ? `${sourceReferences} ${sourceMessageId}`
          : sourceMessageId;
      }
    } catch {
      // Non-fatal — drop threading info if the source can't be fetched.
    }
  }

  const raw = buildRawMessage(input, headersExtra);
  try {
    const res = await client.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          ...(threadId ? { threadId } : {}),
        },
      },
    });
    const draft_id = res.data.id ?? '';
    const message_id = res.data.message?.id ?? '';
    if (!draft_id) throw new GmailApiError('createDraft: missing draft id in response', 502);
    return { draft_id, message_id };
  } catch (err) {
    wrapError(err, 'createDraft failed');
  }
}

export interface SendInput {
  /** Send an existing draft. Mutually exclusive with the inline body fields. */
  draftId?: string;
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  inReplyToMessageId?: string;
}

export interface SendResult {
  message_id: string;
  thread_id: string;
}

/**
 * Send a message. Either via an existing draft id (preferred path — the user
 * already saw it in Gmail) or by constructing one inline. The route layer
 * MUST call `isSendAllowed()` first; we double-check here as a defense in
 * depth.
 */
export async function sendMessage(input: SendInput): Promise<SendResult> {
  if (!(await isSendAllowed())) {
    throw new GmailAuthError(
      'Sending is disabled. Enable "Send on behalf" in Settings → Integrations → Gmail.',
      403,
    );
  }

  const client = await getClient();

  if (input.draftId) {
    try {
      const res = await client.users.drafts.send({
        userId: 'me',
        requestBody: { id: input.draftId },
      });
      return {
        message_id: res.data.id ?? '',
        thread_id: res.data.threadId ?? '',
      };
    } catch (err) {
      wrapError(err, 'sendMessage (draft) failed');
    }
  }

  if (!input.to || !input.subject || !input.body) {
    throw new GmailApiError(
      'sendMessage requires either draftId or (to, subject, body)',
      400,
    );
  }

  const draftInput: DraftInput = {
    to: input.to,
    subject: input.subject,
    body: input.body,
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined ? { bcc: input.bcc } : {}),
    ...(input.inReplyToMessageId !== undefined
      ? { inReplyToMessageId: input.inReplyToMessageId }
      : {}),
  };
  const headersExtra: Record<string, string> = {};
  let threadId: string | undefined;
  if (input.inReplyToMessageId) {
    try {
      const source = await getMessage(input.inReplyToMessageId);
      threadId = source.threadId || undefined;
    } catch {
      /* non-fatal */
    }
  }
  const raw = buildRawMessage(draftInput, headersExtra);
  try {
    const res = await client.users.messages.send({
      userId: 'me',
      requestBody: {
        raw,
        ...(threadId ? { threadId } : {}),
      },
    });
    return {
      message_id: res.data.id ?? '',
      thread_id: res.data.threadId ?? '',
    };
  } catch (err) {
    wrapError(err, 'sendMessage failed');
  }
}

/* -------------------------------------------------------------------------- */
/*  Labels                                                                    */
/* -------------------------------------------------------------------------- */

export async function listLabels(): Promise<gmail_v1.Schema$Label[]> {
  const client = await getClient();
  try {
    const res = await client.users.labels.list({ userId: 'me' });
    return res.data.labels ?? [];
  } catch (err) {
    wrapError(err, 'listLabels failed');
  }
}

/**
 * Look up a label by name, or create it if missing. The created label is
 * always user-visible (visible in label list) but message-collapsed by
 * default. Returns the resolved label id.
 */
export async function getOrCreateLabel(name: string): Promise<string> {
  const client = await getClient();
  try {
    const existing = await listLabels();
    const match = existing.find((l) => l.name === name);
    if (match?.id) return match.id;
    const res = await client.users.labels.create({
      userId: 'me',
      requestBody: {
        name,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    });
    const id = res.data.id;
    if (!id) {
      throw new GmailApiError(`getOrCreateLabel: missing id for "${name}"`, 502);
    }
    return id;
  } catch (err) {
    wrapError(err, 'getOrCreateLabel failed');
  }
}

export interface ApplyLabelOptions {
  add?: string[];
  remove?: string[];
}

export async function applyLabel(
  messageId: string,
  opts: ApplyLabelOptions,
): Promise<void> {
  const client = await getClient();
  // Resolve label names → ids. If a value already looks like an id (Gmail
  // ids are uppercase + underscores), pass it through unchanged.
  const labelsCache = await listLabels();
  const resolveOne = async (nameOrId: string): Promise<string> => {
    const found = labelsCache.find((l) => l.id === nameOrId || l.name === nameOrId);
    if (found?.id) return found.id;
    // Create it if it's a name we haven't seen.
    return getOrCreateLabel(nameOrId);
  };

  const addIds: string[] = [];
  for (const v of opts.add ?? []) {
    addIds.push(await resolveOne(v));
  }
  const removeIds: string[] = [];
  for (const v of opts.remove ?? []) {
    const found = labelsCache.find((l) => l.id === v || l.name === v);
    if (found?.id) removeIds.push(found.id);
  }

  if (addIds.length === 0 && removeIds.length === 0) return;
  try {
    await client.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: addIds.length > 0 ? addIds : undefined,
        removeLabelIds: removeIds.length > 0 ? removeIds : undefined,
      },
    });
  } catch (err) {
    wrapError(err, 'applyLabel failed');
  }
}
