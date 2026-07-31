/**
 * Recurring schedules repository.
 *
 * Owns all DB access for the `recurring_schedules` table. Like the goals
 * and tasks repos, this module is the (de)serialization boundary for the
 * JSON-encoded `child_templates` column and surfaces the public
 * {@link RecurringSchedule} shape from `src/shared/types.ts`.
 *
 * better-sqlite3 is synchronous, so every function returns immediately.
 */

import { and, asc, eq, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import {
  recurringSchedules,
  type RecurringScheduleRow,
} from '../../../shared/schema.js';

import { getDb } from '../index.js';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type RecurrenceKindString =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly';

/**
 * One child task to materialize per fan-out slot. `{repo}` etc. tokens in
 * `title_template` / `instructions_template` are interpolated at fire time by
 * the schedules domain module — the repo doesn't see them.
 */
export interface ChildTemplate {
  title_template: string;
  instructions_template?: string;
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  tags?: string[];
  agent_method?: 'human_only' | 'cli' | 'cowork' | 'either';
  agent_executable?: boolean;
  permission_profile?:
    | 'trusted-local'
    | 'sandboxed'
    | 'read-only-research'
    | 'github-pr';
}

export interface RecurringSchedule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  recurrence_kind: RecurrenceKindString;
  recurrence_interval: number;
  next_fire_at: string;
  last_fired_at: string | null;
  fan_out_goal_id: string | null;
  child_templates: ChildTemplate[];
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  recurrence_kind: RecurrenceKindString;
  recurrence_interval?: number;
  next_fire_at: string;
  fan_out_goal_id?: string | null;
  child_templates: ChildTemplate[];
}

export interface UpdateScheduleInput {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  recurrence_kind?: RecurrenceKindString;
  recurrence_interval?: number;
  next_fire_at?: string;
  last_fired_at?: string | null;
  fan_out_goal_id?: string | null;
  child_templates?: ChildTemplate[];
}

/* -------------------------------------------------------------------------- */
/*  Serialization                                                             */
/* -------------------------------------------------------------------------- */

function newId(): string {
  return nanoid(12);
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeChildren(children: ChildTemplate[]): string {
  return JSON.stringify(children);
}

/**
 * Parse the JSON child_templates blob defensively — a malformed row should
 * surface as an empty array, not crash callers.
 */
function parseChildren(raw: string): ChildTemplate[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ChildTemplate[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const title = obj.title_template;
      if (typeof title !== 'string' || title.length === 0) continue;
      const c: ChildTemplate = { title_template: title };
      if (typeof obj.instructions_template === 'string') {
        c.instructions_template = obj.instructions_template;
      }
      if (
        obj.priority === 'p0' ||
        obj.priority === 'p1' ||
        obj.priority === 'p2' ||
        obj.priority === 'p3'
      ) {
        c.priority = obj.priority;
      }
      if (Array.isArray(obj.tags)) {
        const tags = obj.tags.filter((t): t is string => typeof t === 'string');
        if (tags.length > 0) c.tags = tags;
      }
      if (
        obj.agent_method === 'human_only' ||
        obj.agent_method === 'cli' ||
        obj.agent_method === 'cowork' ||
        obj.agent_method === 'either'
      ) {
        c.agent_method = obj.agent_method;
      }
      if (typeof obj.agent_executable === 'boolean') {
        c.agent_executable = obj.agent_executable;
      }
      if (
        obj.permission_profile === 'trusted-local' ||
        obj.permission_profile === 'sandboxed' ||
        obj.permission_profile === 'read-only-research' ||
        obj.permission_profile === 'github-pr'
      ) {
        c.permission_profile = obj.permission_profile;
      }
      out.push(c);
    }
    return out;
  } catch {
    return [];
  }
}

function rowToSchedule(row: RecurringScheduleRow): RecurringSchedule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === true || (row.enabled as unknown as number) === 1,
    recurrence_kind: row.recurrence_kind as RecurrenceKindString,
    recurrence_interval: row.recurrence_interval,
    next_fire_at: row.next_fire_at,
    last_fired_at: row.last_fired_at,
    fan_out_goal_id: row.fan_out_goal_id,
    child_templates: parseChildren(row.child_templates),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

const VALID_KINDS: ReadonlySet<RecurrenceKindString> = new Set([
  'daily',
  'weekdays',
  'weekly',
  'monthly',
]);

function assertValidKind(kind: string): asserts kind is RecurrenceKindString {
  if (!VALID_KINDS.has(kind as RecurrenceKindString)) {
    throw new Error(
      `Invalid recurrence_kind "${kind}". Allowed: ${[...VALID_KINDS].join(', ')}.`,
    );
  }
}

function assertChildrenNonEmpty(children: ChildTemplate[]): void {
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error(
      'child_templates must contain at least one entry — otherwise a fire creates no tasks.',
    );
  }
  for (const c of children) {
    if (!c.title_template || c.title_template.trim().length === 0) {
      throw new Error('Every child template requires a non-empty title_template.');
    }
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${label} must be a valid ISO timestamp (got ${JSON.stringify(value)}).`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function listSchedules(
  options: { onlyEnabled?: boolean } = {},
): RecurringSchedule[] {
  const db = getDb();
  let q = db.select().from(recurringSchedules).$dynamic();
  if (options.onlyEnabled) {
    q = q.where(eq(recurringSchedules.enabled, true));
  }
  const rows = q.orderBy(asc(recurringSchedules.next_fire_at)).all();
  return rows.map(rowToSchedule);
}

export function getSchedule(id: string): RecurringSchedule | null {
  const db = getDb();
  const row = db
    .select()
    .from(recurringSchedules)
    .where(eq(recurringSchedules.id, id))
    .get();
  return row ? rowToSchedule(row) : null;
}

/**
 * Every enabled schedule whose `next_fire_at` is at or before `now`. Used by
 * the scheduler tick to figure out what to fan out.
 */
export function listDueSchedules(now: Date): RecurringSchedule[] {
  const db = getDb();
  const rows = db
    .select()
    .from(recurringSchedules)
    .where(
      and(
        eq(recurringSchedules.enabled, true),
        lte(recurringSchedules.next_fire_at, now.toISOString()),
      ),
    )
    .orderBy(asc(recurringSchedules.next_fire_at))
    .all();
  return rows.map(rowToSchedule);
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export function createSchedule(input: CreateScheduleInput): RecurringSchedule {
  assertValidKind(input.recurrence_kind);
  assertChildrenNonEmpty(input.child_templates);
  assertIsoTimestamp(input.next_fire_at, 'next_fire_at');

  const id = newId();
  const now = nowIso();
  const db = getDb();
  db.insert(recurringSchedules)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      enabled: input.enabled ?? true,
      recurrence_kind: input.recurrence_kind,
      recurrence_interval: input.recurrence_interval ?? 1,
      next_fire_at: input.next_fire_at,
      last_fired_at: null,
      fan_out_goal_id: input.fan_out_goal_id ?? null,
      child_templates: serializeChildren(input.child_templates),
      created_at: now,
      updated_at: now,
    })
    .run();
  return getSchedule(id)!;
}

export function updateSchedule(
  id: string,
  patch: UpdateScheduleInput,
): RecurringSchedule | null {
  const existing = getSchedule(id);
  if (!existing) return null;

  if (patch.recurrence_kind !== undefined) {
    assertValidKind(patch.recurrence_kind);
  }
  if (patch.child_templates !== undefined) {
    assertChildrenNonEmpty(patch.child_templates);
  }
  if (patch.next_fire_at !== undefined) {
    assertIsoTimestamp(patch.next_fire_at, 'next_fire_at');
  }
  if (patch.last_fired_at !== undefined && patch.last_fired_at !== null) {
    assertIsoTimestamp(patch.last_fired_at, 'last_fired_at');
  }

  const now = nowIso();
  const updates: Partial<RecurringScheduleRow> = {
    updated_at: now,
  };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  if (patch.recurrence_kind !== undefined) {
    updates.recurrence_kind = patch.recurrence_kind;
  }
  if (patch.recurrence_interval !== undefined) {
    updates.recurrence_interval = patch.recurrence_interval;
  }
  if (patch.next_fire_at !== undefined) {
    updates.next_fire_at = patch.next_fire_at;
  }
  if (patch.last_fired_at !== undefined) {
    updates.last_fired_at = patch.last_fired_at;
  }
  if (patch.fan_out_goal_id !== undefined) {
    updates.fan_out_goal_id = patch.fan_out_goal_id;
  }
  if (patch.child_templates !== undefined) {
    updates.child_templates = serializeChildren(patch.child_templates);
  }

  const db = getDb();
  db.update(recurringSchedules)
    .set(updates)
    .where(eq(recurringSchedules.id, id))
    .run();
  return getSchedule(id);
}

export function deleteSchedule(id: string): boolean {
  const db = getDb();
  const result = db
    .delete(recurringSchedules)
    .where(eq(recurringSchedules.id, id))
    .run();
  return result.changes > 0;
}
