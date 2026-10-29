/**
 * Renewal engine contract (T704).
 *
 * A renewal is a dated obligation for a client (state license, CAQH
 * attestation, DEA registration, risk assessment, BAA review, site rescan or
 * anything custom) that repeats on a fixed cadence. Reminders fire and a
 * Delivery queue item is created when the due date comes inside one of the
 * configured lead times (for example 90, 60 and 30 days out).
 *
 * All date math lives here so the main-process engine, the API and the
 * renderer compute the same trigger dates, states and next due dates. Dates
 * are calendar days (`YYYY-MM-DD`). "Today" and due-day deadlines follow the
 * America/New_York calendar (`RENEWAL_TIME_ZONE`), so a reminder fires on
 * Jack's calendar day, not the UTC one. Keep this module free of Node and DOM
 * imports.
 */

import type { DeliveryOwnerType } from './delivery';

export const RENEWAL_ITEM_TYPES = [
  'state_license',
  'caqh_attestation',
  'dea',
  'risk_assessment',
  'baa',
  'site_rescan',
  'custom',
] as const;
export type RenewalItemType = (typeof RENEWAL_ITEM_TYPES)[number];

export const RENEWAL_ITEM_TYPE_LABELS: Record<RenewalItemType, string> = {
  state_license: 'State license',
  caqh_attestation: 'CAQH attestation',
  dea: 'DEA registration',
  risk_assessment: 'Risk assessment',
  baa: 'BAA',
  site_rescan: 'Site rescan',
  custom: 'Custom',
};

/**
 * Starting values offered when a renewal is created without a recurrence or
 * lead times. Every renewal stores its own values, so these are only
 * defaults; edit them per row when a state or contract differs.
 */
export const RENEWAL_TYPE_DEFAULTS: Record<RenewalItemType, { recurrence: string; lead_times: number[] }> = {
  state_license: { recurrence: '2y', lead_times: [90, 60, 30] },
  caqh_attestation: { recurrence: '120d', lead_times: [30, 14, 7] },
  dea: { recurrence: '3y', lead_times: [90, 60, 30] },
  risk_assessment: { recurrence: '1y', lead_times: [60, 30] },
  baa: { recurrence: '1y', lead_times: [60, 30] },
  site_rescan: { recurrence: '3m', lead_times: [14, 7] },
  custom: { recurrence: 'none', lead_times: [30] },
};

/** Calendar-day state of a renewal relative to today. */
export const RENEWAL_STATES = ['overdue', 'due_soon', 'upcoming', 'inactive'] as const;
export type RenewalState = (typeof RENEWAL_STATES)[number];

export const RENEWAL_STATE_LABELS: Record<RenewalState, string> = {
  overdue: 'Overdue',
  due_soon: 'Due soon',
  upcoming: 'Upcoming',
  inactive: 'Inactive',
};

export class RenewalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenewalInputError';
  }
}

/* -------------------------------------------------------------------------- */
/*  Calendar dates                                                            */
/* -------------------------------------------------------------------------- */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function fromParts(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  // Reject roll-overs like 2026-02-30.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse `YYYY-MM-DD` or US `M/D/YYYY` into a canonical `YYYY-MM-DD`.
 * Returns null for anything else, including impossible dates.
 */
export function parseDateOnly(raw: string): string | null {
  const s = raw.trim();
  let m = DATE_RE.exec(s);
  if (m) return fromParts(Number(m[1]), Number(m[2]), Number(m[3]));
  m = US_DATE_RE.exec(s);
  if (m) return fromParts(Number(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

function dateMs(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) throw new RenewalInputError(`Not a YYYY-MM-DD date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function msToDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Calendar used for "today", reminder days and due-day deadlines. */
export const RENEWAL_TIME_ZONE = 'America/New_York';

let zoneFormat: Intl.DateTimeFormat | null = null;

/** Wall-clock parts of `ms` in RENEWAL_TIME_ZONE, as a UTC timestamp (seconds precision). */
function zoneWallMs(ms: number): number {
  zoneFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: RENEWAL_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const p of zoneFormat.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
}

/** Calendar date of an instant in RENEWAL_TIME_ZONE. */
export function dateInRenewalZone(ms: number): string {
  return msToDate(zoneWallMs(ms));
}

/** Calendar date of an ISO timestamp in RENEWAL_TIME_ZONE, or null when it does not parse. */
export function isoToRenewalDate(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : dateInRenewalZone(ms);
}

/** The instant `date` begins (00:00) in RENEWAL_TIME_ZONE. */
export function renewalDayStartMs(date: string): number {
  const wall = dateMs(date);
  // Offset at a first guess, then again at the result so DST changes land right.
  let t = wall - (zoneWallMs(wall) - wall);
  t = wall - (zoneWallMs(t) - t);
  return t;
}

/** Today's calendar date in RENEWAL_TIME_ZONE (America/New_York). */
export function renewalToday(now: number = Date.now()): string {
  return dateInRenewalZone(now);
}

/** Current month as `YYYY-MM` in RENEWAL_TIME_ZONE. */
export function monthOf(now: number = Date.now()): string {
  return renewalToday(now).slice(0, 7);
}

export function addDays(date: string, days: number): string {
  return msToDate(dateMs(date) + days * MS_PER_DAY);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / MS_PER_DAY);
}

/** Add months, clamping the day so Jan 31 + 1 month is Feb 28 (or 29). */
export function addMonths(date: string, months: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RenewalInputError(`Not a YYYY-MM-DD date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const target = mo + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return msToDate(Date.UTC(ty, tm, Math.min(d, lastDay)));
}

/**
 * The Delivery queue deadline for a renewal due on `date`: the end of that
 * calendar day in America/New_York, so a renewal due today is not breached
 * until tomorrow on Jack's calendar.
 */
export function dueDateToDeadlineIso(date: string): string {
  return new Date(renewalDayStartMs(addDays(date, 1)) - 1000).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Recurrence                                                                */
/* -------------------------------------------------------------------------- */

export type RecurrenceUnit = 'd' | 'm' | 'y';

/** Null means the renewal does not repeat. */
export type Recurrence = { unit: RecurrenceUnit; interval: number } | null;

const UNIT_WORDS: Record<string, RecurrenceUnit> = {
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'd',
  m: 'm',
  mo: 'm',
  month: 'm',
  months: 'm',
  y: 'y',
  yr: 'y',
  year: 'y',
  years: 'y',
};

const NAMED: Record<string, Recurrence> = {
  '': null,
  none: null,
  once: null,
  'one-time': null,
  never: null,
  monthly: { unit: 'm', interval: 1 },
  quarterly: { unit: 'm', interval: 3 },
  semiannual: { unit: 'm', interval: 6 },
  'semi-annual': { unit: 'm', interval: 6 },
  annual: { unit: 'y', interval: 1 },
  annually: { unit: 'y', interval: 1 },
  yearly: { unit: 'y', interval: 1 },
  biennial: { unit: 'y', interval: 2 },
  biennially: { unit: 'y', interval: 2 },
  triennial: { unit: 'y', interval: 3 },
};

const MAX_INTERVAL: Record<RecurrenceUnit, number> = { d: 3650, m: 120, y: 10 };

/**
 * Parse a recurrence. Canonical forms are `none`, `120d`, `3m` and `2y`.
 * Also accepts `yearly`, `quarterly`, `every 2 years`, `4 months`, `2w`
 * (weeks become days). Throws RenewalInputError on anything else.
 */
export function parseRecurrence(raw: string | null | undefined): Recurrence {
  const s = (raw ?? '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAMED, s)) return NAMED[s] ?? null;
  const m = /^(?:every\s+)?(\d+)\s*([a-z]+)$/.exec(s);
  if (!m) throw new RenewalInputError(`Unrecognized recurrence: ${raw}`);
  let interval = Number(m[1]);
  const word = m[2];
  const unit = UNIT_WORDS[word] ?? (word === 'week' || word === 'weeks' ? 'd' : undefined);
  if (!unit) throw new RenewalInputError(`Unrecognized recurrence unit: ${raw}`);
  if (word === 'w' || word === 'week' || word === 'weeks') interval *= 7;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL[unit]) {
    throw new RenewalInputError(`Recurrence interval out of range: ${raw}`);
  }
  return { unit, interval };
}

export function formatRecurrence(r: Recurrence): string {
  return r ? `${r.interval}${r.unit}` : 'none';
}

export function describeRecurrence(r: Recurrence): string {
  if (!r) return 'One time';
  const word = { d: 'day', m: 'month', y: 'year' }[r.unit];
  return r.interval === 1 ? `Every ${word}` : `Every ${r.interval} ${word}s`;
}

/** Due date of the cycle after `due`, or null when the renewal does not repeat. */
export function nextDueDate(due: string, recurrence: Recurrence): string | null {
  if (!recurrence) return null;
  if (recurrence.unit === 'd') return addDays(due, recurrence.interval);
  if (recurrence.unit === 'm') return addMonths(due, recurrence.interval);
  return addMonths(due, recurrence.interval * 12);
}

/* -------------------------------------------------------------------------- */
/*  Lead times and triggers                                                   */
/* -------------------------------------------------------------------------- */

export const MAX_LEAD_DAYS = 730;
export const MAX_LEAD_TIMES = 8;

/**
 * Normalize lead times: whole days, 0..730, de-duplicated, largest first.
 * Accepts an array or a string like `90/60/30`, `90;60;30` or `90 60 30`.
 */
export function normalizeLeadTimes(input: ReadonlyArray<number> | string): number[] {
  const parts =
    typeof input === 'string'
      ? input
          .split(/[\s,;/|]+/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => Number(p.replace(/d$/i, '')))
      : [...input];
  const out = new Set<number>();
  for (const n of parts) {
    if (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_DAYS) {
      throw new RenewalInputError(`Lead times must be whole days between 0 and ${MAX_LEAD_DAYS}`);
    }
    out.add(n);
  }
  if (out.size === 0) throw new RenewalInputError('At least one lead time is required');
  if (out.size > MAX_LEAD_TIMES) throw new RenewalInputError(`At most ${MAX_LEAD_TIMES} lead times`);
  return [...out].sort((a, b) => b - a);
}

export interface LeadTrigger {
  lead_days: number;
  /** Calendar day the reminder fires: due date minus lead_days. */
  trigger_date: string;
}

/** One trigger per lead time, earliest trigger (largest lead) first. */
export function leadTimeTriggers(due: string, leadTimes: ReadonlyArray<number>): LeadTrigger[] {
  return normalizeLeadTimes(leadTimes).map((lead) => ({ lead_days: lead, trigger_date: addDays(due, -lead) }));
}

/** Triggers whose date is today or earlier. */
export function reachedTriggers(due: string, leadTimes: ReadonlyArray<number>, today: string): LeadTrigger[] {
  return leadTimeTriggers(due, leadTimes).filter((t) => t.trigger_date <= today);
}

/** The next trigger after today, or null when every trigger has fired. */
export function nextTrigger(due: string, leadTimes: ReadonlyArray<number>, today: string): LeadTrigger | null {
  return leadTimeTriggers(due, leadTimes).find((t) => t.trigger_date > today) ?? null;
}

/**
 * overdue: today is past the due date.
 * due_soon: the first (largest) lead time has been reached.
 * upcoming: no lead time reached yet.
 */
export function renewalState(
  due: string,
  leadTimes: ReadonlyArray<number>,
  today: string,
  active = true,
): RenewalState {
  if (!active) return 'inactive';
  if (today > due) return 'overdue';
  return reachedTriggers(due, leadTimes, today).length > 0 ? 'due_soon' : 'upcoming';
}

/* -------------------------------------------------------------------------- */
/*  Records                                                                   */
/* -------------------------------------------------------------------------- */

export interface Renewal {
  id: string;
  client: string;
  item_type: RenewalItemType;
  /** What is being renewed, e.g. "NY medical license" or "Main site". */
  label: string;
  /** Current cycle's due date (YYYY-MM-DD). */
  due_date: string;
  /** Canonical recurrence string, see `parseRecurrence`. */
  recurrence: string;
  /** Days before due_date, largest first. */
  lead_times: number[];
  owner_type: DeliveryOwnerType;
  owner_name: string | null;
  venture: string | null;
  notes: string | null;
  /** Shown on the client portal when true. */
  client_visible: boolean;
  /** False once a one-time renewal is done or Jack turns it off. */
  active: boolean;
  last_renewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RenewalSchedule {
  state: RenewalState;
  /** Due date minus today. Negative when overdue. */
  days_until: number;
  next_reminder: LeadTrigger | null;
  /** Due date after this cycle, or null for one-time renewals. */
  next_due_date: string | null;
}

export type RenewalWithSchedule = Renewal & {
  schedule: RenewalSchedule;
  /** Delivery queue item created for the current cycle, if any. */
  current_item_id: string | null;
};

export function computeRenewalSchedule(
  r: Pick<Renewal, 'due_date' | 'lead_times' | 'recurrence' | 'active'>,
  now: number = Date.now(),
): RenewalSchedule {
  const today = renewalToday(now);
  return {
    state: renewalState(r.due_date, r.lead_times, today, r.active),
    days_until: daysBetween(today, r.due_date),
    next_reminder: r.active ? nextTrigger(r.due_date, r.lead_times, today) : null,
    next_due_date: nextDueDate(r.due_date, parseRecurrence(r.recurrence)),
  };
}

export const REMINDER_STATUSES = ['sent', 'skipped'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export interface RenewalReminder {
  id: string;
  renewal_id: string;
  cycle_due_date: string;
  lead_days: number;
  trigger_date: string;
  /**
   * sent: the reminder Jack sees. skipped: a lead time that had already
   * passed when the engine first saw this cycle; recorded so it never fires
   * late, but not surfaced.
   */
  status: ReminderStatus;
  delivery_item_id: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

export type RenewalReminderWithRenewal = RenewalReminder & {
  client: string;
  label: string;
  item_type: RenewalItemType;
};

/** Title of the Delivery queue item the engine creates for a renewal cycle. */
export function renewalTaskTitle(r: Pick<Renewal, 'item_type' | 'label'>): string {
  return `${RENEWAL_ITEM_TYPE_LABELS[r.item_type]} renewal: ${r.label}`;
}
