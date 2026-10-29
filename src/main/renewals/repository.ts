/**
 * Renewals repository (T704).
 *
 * Raw SQL over `getSqlite()`, matching the delivery repository. Tables come
 * from the v12 inline migration. Schedule fields (state, days until due,
 * next reminder) are derived on read with the shared helpers in
 * `@/shared/renewals`, so the API, the engine and the renderer agree.
 */

import { nanoid } from 'nanoid';

import { getSqlite } from '@/main/db';
import { DELIVERY_OWNER_TYPES, type DeliveryOwnerType } from '@/shared/delivery';
import {
  RENEWAL_ITEM_TYPES,
  RENEWAL_TYPE_DEFAULTS,
  RenewalInputError,
  computeRenewalSchedule,
  formatRecurrence,
  normalizeLeadTimes,
  parseDateOnly,
  parseRecurrence,
  type Renewal,
  type RenewalItemType,
  type RenewalReminder,
  type RenewalReminderWithRenewal,
  type RenewalState,
  type RenewalWithSchedule,
  type ReminderStatus,
} from '@/shared/renewals';

export class RenewalError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'RenewalError';
  }
}

/** Re-throw shared input errors as repository errors so routes map them to 400. */
export function asRenewalError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RenewalInputError) throw new RenewalError('invalid', err.message);
    throw err;
  }
}

function nowIso(now: number): string {
  return new Date(now).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Row mapping                                                               */
/* -------------------------------------------------------------------------- */

interface RenewalRow {
  id: string;
  client: string;
  item_type: string;
  label: string;
  due_date: string;
  recurrence: string;
  lead_times: string;
  owner_type: string;
  owner_name: string | null;
  venture: string | null;
  notes: string | null;
  client_visible: number;
  active: number;
  last_renewed_at: string | null;
  created_at: string;
  updated_at: string;
}

function parseLeadTimesColumn(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return normalizeLeadTimes(parsed.map(Number));
  } catch {
    /* fall through */
  }
  return [30];
}

function rowToRenewal(r: RenewalRow): Renewal {
  return {
    ...r,
    item_type: r.item_type as RenewalItemType,
    owner_type: r.owner_type as DeliveryOwnerType,
    lead_times: parseLeadTimesColumn(r.lead_times),
    client_visible: r.client_visible === 1,
    active: r.active === 1,
  };
}

interface ReminderRow {
  id: string;
  renewal_id: string;
  cycle_due_date: string;
  lead_days: number;
  trigger_date: string;
  status: string;
  delivery_item_id: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

function rowToReminder(r: ReminderRow): RenewalReminder {
  return { ...r, lead_days: Number(r.lead_days), status: r.status as ReminderStatus };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

function requireText(value: string | undefined, field: string): string {
  const v = (value ?? '').trim();
  if (!v) throw new RenewalError('invalid', `${field} is required`);
  if (v.length > 300) throw new RenewalError('invalid', `${field} is too long`);
  return v;
}

function requireDate(value: string, field: string): string {
  const d = parseDateOnly(value);
  if (!d) throw new RenewalError('invalid', `${field} must be a date (YYYY-MM-DD): ${value}`);
  return d;
}

function requireItemType(value: string): RenewalItemType {
  if (!(RENEWAL_ITEM_TYPES as readonly string[]).includes(value)) {
    throw new RenewalError('invalid', `Unknown item type: ${value}`);
  }
  return value as RenewalItemType;
}

function requireOwnerType(value: string): DeliveryOwnerType {
  if (!(DELIVERY_OWNER_TYPES as readonly string[]).includes(value)) {
    throw new RenewalError('invalid', `Unknown owner type: ${value}`);
  }
  return value as DeliveryOwnerType;
}

function canonicalRecurrence(raw: string): string {
  return asRenewalError(() => formatRecurrence(parseRecurrence(raw)));
}

function canonicalLeadTimes(raw: ReadonlyArray<number> | string): number[] {
  return asRenewalError(() => normalizeLeadTimes(raw));
}

/* -------------------------------------------------------------------------- */
/*  CRUD                                                                      */
/* -------------------------------------------------------------------------- */

export interface CreateRenewalInput {
  client: string;
  item_type: string;
  label: string;
  due_date: string;
  /** Defaults to the item type's recurrence. */
  recurrence?: string;
  /** Defaults to the item type's lead times. */
  lead_times?: ReadonlyArray<number> | string;
  owner_type?: string;
  owner_name?: string | null;
  venture?: string | null;
  notes?: string | null;
  client_visible?: boolean;
  active?: boolean;
}

export function getRenewal(id: string): Renewal | null {
  const row = getSqlite().prepare('SELECT * FROM renewals WHERE id = ?').get(id) as RenewalRow | undefined;
  return row ? rowToRenewal(row) : null;
}

/** Normalize and validate a create payload without writing it. Used by CSV import. */
export function prepareRenewal(input: CreateRenewalInput): Omit<
  Renewal,
  'id' | 'created_at' | 'updated_at' | 'last_renewed_at'
> {
  const item_type = requireItemType(input.item_type);
  const defaults = RENEWAL_TYPE_DEFAULTS[item_type];
  return {
    client: requireText(input.client, 'client'),
    item_type,
    label: requireText(input.label, 'label'),
    due_date: requireDate(input.due_date, 'due_date'),
    recurrence: canonicalRecurrence(input.recurrence ?? defaults.recurrence),
    lead_times: canonicalLeadTimes(input.lead_times ?? defaults.lead_times),
    owner_type: requireOwnerType(input.owner_type ?? 'jack'),
    owner_name: input.owner_name?.trim() || null,
    venture: input.venture?.trim() || null,
    notes: input.notes?.trim() || null,
    client_visible: input.client_visible ?? false,
    active: input.active ?? true,
  };
}

export function createRenewal(input: CreateRenewalInput, now: number = Date.now()): Renewal {
  const r = prepareRenewal(input);
  const id = nanoid(12);
  const ts = nowIso(now);
  getSqlite()
    .prepare(
      `INSERT INTO renewals (
        id, client, item_type, label, due_date, recurrence, lead_times, owner_type, owner_name,
        venture, notes, client_visible, active, last_renewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      r.client,
      r.item_type,
      r.label,
      r.due_date,
      r.recurrence,
      JSON.stringify(r.lead_times),
      r.owner_type,
      r.owner_name,
      r.venture,
      r.notes,
      r.client_visible ? 1 : 0,
      r.active ? 1 : 0,
      ts,
      ts,
    );
  return getRenewal(id)!;
}

export type UpdateRenewalInput = Partial<CreateRenewalInput>;

export function updateRenewal(id: string, patch: UpdateRenewalInput, now: number = Date.now()): Renewal | null {
  const current = getRenewal(id);
  if (!current) return null;
  const next = prepareRenewal({
    client: patch.client ?? current.client,
    item_type: patch.item_type ?? current.item_type,
    label: patch.label ?? current.label,
    due_date: patch.due_date ?? current.due_date,
    recurrence: patch.recurrence ?? current.recurrence,
    lead_times: patch.lead_times ?? current.lead_times,
    owner_type: patch.owner_type ?? current.owner_type,
    owner_name: patch.owner_name !== undefined ? patch.owner_name : current.owner_name,
    venture: patch.venture !== undefined ? patch.venture : current.venture,
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    client_visible: patch.client_visible ?? current.client_visible,
    active: patch.active ?? current.active,
  });
  getSqlite()
    .prepare(
      `UPDATE renewals SET
        client = ?, item_type = ?, label = ?, due_date = ?, recurrence = ?, lead_times = ?,
        owner_type = ?, owner_name = ?, venture = ?, notes = ?, client_visible = ?, active = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.client,
      next.item_type,
      next.label,
      next.due_date,
      next.recurrence,
      JSON.stringify(next.lead_times),
      next.owner_type,
      next.owner_name,
      next.venture,
      next.notes,
      next.client_visible ? 1 : 0,
      next.active ? 1 : 0,
      nowIso(now),
      id,
    );
  return getRenewal(id);
}

export function deleteRenewal(id: string): boolean {
  return getSqlite().prepare('DELETE FROM renewals WHERE id = ?').run(id).changes > 0;
}

/** Advance to the next cycle (or deactivate a one-time renewal). Engine and "mark renewed" share this. */
export function rollRenewal(id: string, renewedAt: string, now: number = Date.now()): Renewal | null {
  const current = getRenewal(id);
  if (!current) return null;
  const schedule = computeRenewalSchedule(current, now);
  const db = getSqlite();
  if (schedule.next_due_date) {
    db.prepare('UPDATE renewals SET due_date = ?, last_renewed_at = ?, updated_at = ? WHERE id = ?').run(
      schedule.next_due_date,
      renewedAt,
      nowIso(now),
      id,
    );
  } else {
    db.prepare('UPDATE renewals SET active = 0, last_renewed_at = ?, updated_at = ? WHERE id = ?').run(
      renewedAt,
      nowIso(now),
      id,
    );
  }
  return getRenewal(id);
}

/** Delivery item created for this renewal's current cycle, if any. */
export function currentCycleItemId(renewalId: string, cycleDueDate: string): string | null {
  const row = getSqlite()
    .prepare(
      `SELECT delivery_item_id AS id FROM renewal_reminders
       WHERE renewal_id = ? AND cycle_due_date = ? AND delivery_item_id IS NOT NULL
       ORDER BY lead_days DESC LIMIT 1`,
    )
    .get(renewalId, cycleDueDate) as { id: string } | undefined;
  return row?.id ?? null;
}

export interface ListRenewalsFilter {
  client?: string;
  item_type?: RenewalItemType;
  state?: RenewalState[];
  include_inactive?: boolean;
  client_visible?: boolean;
}

export function listRenewals(filter: ListRenewalsFilter = {}, now: number = Date.now()): RenewalWithSchedule[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.client) {
    where.push('client = ?');
    params.push(filter.client);
  }
  if (filter.item_type) {
    where.push('item_type = ?');
    params.push(filter.item_type);
  }
  if (!filter.include_inactive) where.push('active = 1');
  if (filter.client_visible !== undefined) {
    where.push('client_visible = ?');
    params.push(filter.client_visible ? 1 : 0);
  }
  const sql = `SELECT * FROM renewals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY due_date, client, label`;
  const rows = getSqlite().prepare(sql).all(...params) as RenewalRow[];
  const states = filter.state && filter.state.length > 0 ? new Set(filter.state) : null;
  return rows
    .map(rowToRenewal)
    .map((r) => ({
      ...r,
      schedule: computeRenewalSchedule(r, now),
      current_item_id: currentCycleItemId(r.id, r.due_date),
    }))
    .filter((r) => !states || states.has(r.schedule.state));
}

export function listRenewalClients(): string[] {
  return (
    getSqlite().prepare('SELECT DISTINCT client AS v FROM renewals ORDER BY client').all() as Array<{ v: string }>
  ).map((r) => r.v);
}

/* -------------------------------------------------------------------------- */
/*  Reminders                                                                 */
/* -------------------------------------------------------------------------- */

export function listCycleReminders(renewalId: string, cycleDueDate: string): RenewalReminder[] {
  return (
    getSqlite()
      .prepare('SELECT * FROM renewal_reminders WHERE renewal_id = ? AND cycle_due_date = ? ORDER BY lead_days DESC')
      .all(renewalId, cycleDueDate) as ReminderRow[]
  ).map(rowToReminder);
}

export interface InsertReminderInput {
  renewal_id: string;
  cycle_due_date: string;
  lead_days: number;
  trigger_date: string;
  status: ReminderStatus;
  delivery_item_id: string | null;
}

/** Insert unless the (renewal, cycle, lead) row exists. Returns the row or null when it already existed. */
export function insertReminder(input: InsertReminderInput, now: number = Date.now()): RenewalReminder | null {
  const id = nanoid(12);
  const res = getSqlite()
    .prepare(
      `INSERT OR IGNORE INTO renewal_reminders
        (id, renewal_id, cycle_due_date, lead_days, trigger_date, status, delivery_item_id, acknowledged_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      input.renewal_id,
      input.cycle_due_date,
      input.lead_days,
      input.trigger_date,
      input.status,
      input.delivery_item_id,
      nowIso(now),
    );
  if (res.changes === 0) return null;
  return rowToReminder(
    getSqlite().prepare('SELECT * FROM renewal_reminders WHERE id = ?').get(id) as ReminderRow,
  );
}

export function linkCycleReminders(renewalId: string, cycleDueDate: string, deliveryItemId: string): void {
  getSqlite()
    .prepare(
      `UPDATE renewal_reminders SET delivery_item_id = ?
       WHERE renewal_id = ? AND cycle_due_date = ? AND delivery_item_id IS NULL`,
    )
    .run(deliveryItemId, renewalId, cycleDueDate);
}

export function listReminders(
  opts: { include_acknowledged?: boolean; limit?: number } = {},
): RenewalReminderWithRenewal[] {
  const rows = getSqlite()
    .prepare(
      `SELECT rr.*, r.client AS client, r.label AS label, r.item_type AS item_type
       FROM renewal_reminders rr JOIN renewals r ON r.id = rr.renewal_id
       WHERE rr.status = 'sent' ${opts.include_acknowledged ? '' : 'AND rr.acknowledged_at IS NULL'}
       ORDER BY rr.trigger_date DESC, rr.created_at DESC
       LIMIT ?`,
    )
    .all(Math.min(Math.max(opts.limit ?? 100, 1), 500)) as Array<
    ReminderRow & { client: string; label: string; item_type: string }
  >;
  return rows.map((r) => ({
    ...rowToReminder(r),
    client: r.client,
    label: r.label,
    item_type: r.item_type as RenewalItemType,
  }));
}

export function acknowledgeReminder(id: string, now: number = Date.now()): boolean {
  return (
    getSqlite()
      .prepare('UPDATE renewal_reminders SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL')
      .run(nowIso(now), id).changes > 0
  );
}
