/**
 * Generic webhook dispatcher.
 *
 * Given a request body (raw bytes + parsed JSON), a webhook config, and
 * its mapping rules, the dispatcher:
 *
 *   1. Verifies the HMAC signature against `config.signature_algorithm`
 *      using the configured `signature_header`. `algorithm: none` skips
 *      verification (only ever appropriate for trusted local networks).
 *   2. Walks `mapping_rules` in order. Each rule whose `match` resolves
 *      truthy executes its `template` substitution and then performs the
 *      associated action.
 *   3. Returns a summary of what fired.
 *
 * Template substitution uses `{{path.to.field}}` syntax — paths are
 * dotted JSON access. Missing paths render as an empty string so a
 * mistyped path doesn't blow up the whole rule (it just creates a task
 * with a blank field, which is visible to the user).
 *
 * Wave 13 — Agent M.
 */

import crypto from 'node:crypto';

import {
  createTask,
  getTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import type { Task, TaskPriority } from '@/shared/types';

import type { MappingRule, WebhookConfig } from './registry';

/* -------------------------------------------------------------------------- */
/*  Path resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a dotted path against a parsed JSON object. Returns `undefined`
 * when any segment along the way is missing. Array indices written as
 * `items.0.name` are supported.
 */
export function resolvePath(obj: unknown, path: string): unknown {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  const segments = path.split('.');
  let cursor: unknown = obj;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isFinite(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[seg];
      continue;
    }
    return undefined;
  }
  return cursor;
}

/* -------------------------------------------------------------------------- */
/*  Template substitution                                                     */
/* -------------------------------------------------------------------------- */

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Replace `{{path.to.value}}` placeholders with the resolved value from the
 * payload. Resolved values are stringified — `null`/`undefined` collapse to
 * empty string; objects use `JSON.stringify` so a template that references
 * a nested object yields something readable rather than `[object Object]`.
 */
export function renderTemplate(template: string, payload: unknown): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const value = resolvePath(payload, path);
    return formatValue(value);
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/*  Match evaluation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `rule.match` is satisfied when the value at `match.path` equals
 * `match.equals`. The comparison is permissive: both sides are coerced to
 * string for the common case where webhook payloads send `42` and the
 * config string says `"42"`. A rule without `match` always fires.
 */
export function ruleMatches(rule: MappingRule, payload: unknown): boolean {
  if (!rule.match) return true;
  const actual = resolvePath(payload, rule.match.path);
  const expected = rule.match.equals;
  // Strict equality first — avoids surprising "0" === false collapses.
  if (actual === expected) return true;
  // Then string-coerced equality for the common scalar mismatch.
  if (actual === undefined || actual === null) return false;
  if (expected === undefined || expected === null) return false;
  return String(actual) === String(expected);
}

/* -------------------------------------------------------------------------- */
/*  Signature verification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Verify an HMAC signature on `rawBody` against `secret`. The provided
 * signature can be the raw hex digest OR prefixed with the algorithm name
 * (`sha256=…`, `sha1=…`) — both forms are common in the wild.
 */
export function verifyHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  algorithm: 'sha256' | 'sha1',
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const prefix = `${algorithm}=`;
  const candidate = signatureHeader.startsWith(prefix)
    ? signatureHeader.slice(prefix.length)
    : signatureHeader;
  const expected = crypto
    .createHmac(algorithm, secret)
    .update(rawBody)
    .digest('hex');
  if (candidate.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(candidate, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

export interface DispatchResult {
  /** Number of rules whose match fired. */
  triggered_rules: number;
  created_tasks: string[];
  updated_tasks: string[];
  /** Per-rule outcome for the test endpoint. Each entry corresponds to a
   *  rule from the config in order. */
  rule_outcomes: Array<{
    matched: boolean;
    action?: MappingRule['action'];
    task_id?: string;
    error?: string;
  }>;
}

export interface DispatchOptions {
  /** When true, walk rules and resolve templates but DON'T touch the DB.
   *  Used by the `/test` endpoint. */
  dryRun?: boolean;
}

/**
 * Execute every matching rule against the parsed payload. Errors thrown
 * by one rule's action don't stop the remaining rules — each rule's
 * outcome is recorded independently.
 */
export function dispatch(
  config: WebhookConfig,
  payload: unknown,
  options: DispatchOptions = {},
): DispatchResult {
  const result: DispatchResult = {
    triggered_rules: 0,
    created_tasks: [],
    updated_tasks: [],
    rule_outcomes: [],
  };

  const dryRun = options.dryRun === true;

  for (const rule of config.mapping_rules) {
    const matched = ruleMatches(rule, payload);
    if (!matched) {
      result.rule_outcomes.push({ matched: false });
      continue;
    }
    result.triggered_rules += 1;

    try {
      const outcome = runAction(rule, payload, dryRun);
      result.rule_outcomes.push({
        matched: true,
        action: rule.action,
        task_id: outcome.task_id,
      });
      if (!dryRun && outcome.task_id) {
        if (outcome.created) {
          result.created_tasks.push(outcome.task_id);
        } else {
          result.updated_tasks.push(outcome.task_id);
        }
      }
    } catch (err) {
      result.rule_outcomes.push({
        matched: true,
        action: rule.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

interface ActionOutcome {
  task_id?: string;
  created?: boolean;
}

function runAction(
  rule: MappingRule,
  payload: unknown,
  dryRun: boolean,
): ActionOutcome {
  const t = rule.template;
  const title = t.title ? renderTemplate(t.title, payload) : undefined;
  const description = t.description
    ? renderTemplate(t.description, payload)
    : undefined;
  const taskId = t.task_id ? renderTemplate(t.task_id, payload) : undefined;
  const note = t.note ? renderTemplate(t.note, payload) : undefined;

  if (rule.action === 'create_task') {
    if (!title || title.trim().length === 0) {
      throw new Error('create_task rule requires a non-empty title template');
    }
    if (dryRun) {
      return { task_id: '(dry-run)', created: true };
    }
    const created = createTask({
      title: title.trim().slice(0, 500),
      description: description ?? null,
      status: 'inbox',
      priority: (t.priority as TaskPriority | undefined) ?? 'p2',
      tags: Array.isArray(t.tags)
        ? t.tags.map((tag) => renderTemplate(tag, payload))
        : undefined,
      agent_method: t.agent_method ?? 'human_only',
      context: { source: 'webhook' },
    });
    return { task_id: created.id, created: true };
  }

  if (rule.action === 'update_task') {
    if (!taskId) {
      throw new Error('update_task rule requires a task_id template');
    }
    if (dryRun) {
      return { task_id: taskId };
    }
    const updated = updateTask(taskId, {
      ...(title ? { title: title.slice(0, 500) } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(t.priority ? { priority: t.priority as TaskPriority } : {}),
    });
    if (!updated) {
      throw new Error(`Task ${taskId} not found`);
    }
    return { task_id: updated.id };
  }

  if (rule.action === 'comment_task') {
    if (!taskId) {
      throw new Error('comment_task rule requires a task_id template');
    }
    const noteBody = note ?? description ?? '';
    if (noteBody.trim().length === 0) {
      throw new Error(
        'comment_task rule requires a non-empty note or description template',
      );
    }
    if (dryRun) {
      return { task_id: taskId };
    }
    const target = getTask(taskId);
    if (!target) {
      throw new Error(`Task ${taskId} not found`);
    }
    const ctx = (target.context ?? {}) as Record<string, unknown>;
    const existingNotes = Array.isArray(ctx.notes)
      ? (ctx.notes as Array<Record<string, unknown>>)
      : [];
    existingNotes.push({
      note: noteBody.slice(0, 5_000),
      source: 'webhook',
      at: new Date().toISOString(),
    });
    const updated = updateTask(target.id, {
      context: { ...ctx, notes: existingNotes },
    });
    return { task_id: updated?.id ?? target.id };
  }

  throw new Error(`Unknown action: ${rule.action as string}`);
}

/* -------------------------------------------------------------------------- */
/*  Convenience: resolve a config + verify signature in one go                */
/* -------------------------------------------------------------------------- */

export interface VerifyResult {
  ok: boolean;
  /** Failure code when ok is false. Maps to a 401 / 403. */
  code?: 'invalid_signature' | 'secret_required' | 'algorithm_disabled';
  message?: string;
}

export function verifySignature(
  config: WebhookConfig,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): VerifyResult {
  if (config.signature_algorithm === 'none') {
    // Explicitly opted out. Accept anything.
    return { ok: true };
  }
  if (!config.secret) {
    // The user picked sha256/sha1 but never set a secret. Don't silently
    // accept — fail loudly so they catch the misconfiguration.
    return {
      ok: false,
      code: 'secret_required',
      message: 'Webhook secret is not configured',
    };
  }
  const ok = verifyHmac(
    rawBody,
    signatureHeader,
    config.secret,
    config.signature_algorithm,
  );
  if (!ok) {
    return {
      ok: false,
      code: 'invalid_signature',
      message: 'Signature did not match',
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Test-only re-exports                                                      */
/* -------------------------------------------------------------------------- */

export type { Task };
