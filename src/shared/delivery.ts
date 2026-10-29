/**
 * Delivery queue contract (T693/T694).
 *
 * Client delivery work for the ventures (MultiStateMD licensing, Clinician
 * Standing, Stetwright practice programs) lives in its own queue, separate
 * from Jack's personal `tasks`. Every item has an owner (Jack, a contractor
 * or an offshore team member), a client, a venture and an SLA clock.
 *
 * This module is shared by the main process (API + repository) and the
 * renderer, so the SLA math is identical on both sides. Keep it free of Node
 * and DOM imports.
 */

export const DELIVERY_OWNER_TYPES = ['jack', 'contractor', 'offshore'] as const;
export type DeliveryOwnerType = (typeof DELIVERY_OWNER_TYPES)[number];

export const DELIVERY_OWNER_LABELS: Record<DeliveryOwnerType, string> = {
  jack: 'Jack',
  contractor: 'Contractor',
  offshore: 'Offshore team',
};

/** `owner_name` query value that selects items with no named owner. */
export const UNASSIGNED_OWNER = '__unassigned';

export const DELIVERY_STATUSES = [
  'queued',
  'in_progress',
  'waiting_on_client',
  'blocked',
  'done',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  queued: 'Queued',
  in_progress: 'In progress',
  waiting_on_client: 'Waiting on client',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const CLOSED_DELIVERY_STATUSES: readonly DeliveryStatus[] = ['done', 'cancelled'];

export function isClosedStatus(status: DeliveryStatus): boolean {
  return CLOSED_DELIVERY_STATUSES.includes(status);
}

/**
 * SLA states.
 *  - none: no SLA hours and no deadline set.
 *  - on_track: open, more than the at-risk share of the window left.
 *  - at_risk: open, inside the last 25% of the window (or the last 24h when
 *    the window start is unknown).
 *  - breached: open and past due.
 *  - met: closed on or before the due time.
 *  - missed: closed after the due time.
 */
export const SLA_STATES = ['none', 'on_track', 'at_risk', 'breached', 'met', 'missed'] as const;
export type SlaState = (typeof SLA_STATES)[number];

export const SLA_STATE_LABELS: Record<SlaState, string> = {
  none: 'No SLA',
  on_track: 'On track',
  at_risk: 'At risk',
  breached: 'Breached',
  met: 'Met',
  missed: 'Missed',
};

/** Share of the SLA window left at which an open item turns at_risk. */
export const AT_RISK_FRACTION = 0.25;
/** Fallback at-risk window when the clock start is unknown. */
export const AT_RISK_FALLBACK_MS = 24 * 60 * 60 * 1000;

export interface DeliveryItem {
  id: string;
  title: string;
  description: string | null;
  owner_type: DeliveryOwnerType;
  /** Person holding the item, e.g. a contractor's name. Null = unassigned within the role. */
  owner_name: string | null;
  client: string;
  venture: string | null;
  status: DeliveryStatus;
  /** Hard client-facing deadline (ISO). Optional. */
  deadline: string | null;
  /** SLA length in hours. Null = no SLA clock (deadline only, or nothing). */
  sla_hours: number | null;
  /** When the SLA clock started (ISO). */
  sla_started_at: string;
  /** sla_started_at + sla_hours (ISO). Null when sla_hours is null. */
  sla_due_at: string | null;
  completed_at: string | null;
  template_id: string | null;
  template_step_id: string | null;
  /** Groups the items produced by one template instantiation. */
  instance_id: string | null;
  position: number;
  /** Shown on the client portal (T707) when true. Default false. */
  client_visible: boolean;
  /** Optional link to the finished deliverable, shown on the portal. */
  deliverable_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SlaInfo {
  state: SlaState;
  /** Effective due time: the earlier of sla_due_at and deadline. */
  due_at: string | null;
  /** due_at minus now (or minus completed_at for closed items). Negative = overdue. */
  remaining_ms: number | null;
}

export type DeliveryItemWithSla = DeliveryItem & { sla: SlaInfo };

type SlaInput = Pick<
  DeliveryItem,
  'status' | 'deadline' | 'sla_started_at' | 'sla_due_at' | 'completed_at'
>;

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Earlier of the SLA due time and the client deadline. */
export function effectiveDueMs(item: Pick<DeliveryItem, 'deadline' | 'sla_due_at'>): number | null {
  const sla = parseMs(item.sla_due_at);
  const deadline = parseMs(item.deadline);
  if (sla === null) return deadline;
  if (deadline === null) return sla;
  return Math.min(sla, deadline);
}

export function computeSla(item: SlaInput, now: number = Date.now()): SlaInfo {
  const due = effectiveDueMs(item);
  if (due === null) return { state: 'none', due_at: null, remaining_ms: null };
  const dueIso = new Date(due).toISOString();

  if (isClosedStatus(item.status)) {
    // Cancelled work has no SLA outcome worth scoring.
    if (item.status === 'cancelled') return { state: 'none', due_at: dueIso, remaining_ms: null };
    const finished = parseMs(item.completed_at) ?? now;
    const remaining = due - finished;
    return { state: remaining >= 0 ? 'met' : 'missed', due_at: dueIso, remaining_ms: remaining };
  }

  const remaining = due - now;
  if (remaining < 0) return { state: 'breached', due_at: dueIso, remaining_ms: remaining };

  const start = parseMs(item.sla_started_at);
  const window = start !== null && due > start ? due - start : null;
  const riskThreshold = window !== null ? window * AT_RISK_FRACTION : AT_RISK_FALLBACK_MS;
  return {
    state: remaining <= riskThreshold ? 'at_risk' : 'on_track',
    due_at: dueIso,
    remaining_ms: remaining,
  };
}

export function withSla(item: DeliveryItem, now: number = Date.now()): DeliveryItemWithSla {
  return { ...item, sla: computeSla(item, now) };
}

/** "2d 4h", "3h 10m", "12m". Sign is dropped; callers word overdue themselves. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return mins > 0 ? `${mins}m` : '<1m';
}

/** Human label for the SLA timer column. */
export function formatSlaTimer(sla: SlaInfo): string {
  if (sla.remaining_ms === null) return '';
  if (sla.state === 'met') return 'Met';
  if (sla.state === 'missed') return `Missed by ${formatDuration(sla.remaining_ms)}`;
  if (sla.remaining_ms < 0) return `${formatDuration(sla.remaining_ms)} over`;
  return `${formatDuration(sla.remaining_ms)} left`;
}

/** Queue ordering: breached first, then at risk, then by soonest due. */
export function compareQueueItems(a: DeliveryItemWithSla, b: DeliveryItemWithSla): number {
  const rank: Record<SlaState, number> = {
    breached: 0,
    at_risk: 1,
    on_track: 2,
    none: 3,
    missed: 4,
    met: 5,
  };
  const r = rank[a.sla.state] - rank[b.sla.state];
  if (r !== 0) return r;
  const ad = a.sla.due_at ? Date.parse(a.sla.due_at) : Number.POSITIVE_INFINITY;
  const bd = b.sla.due_at ? Date.parse(b.sla.due_at) : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.position - b.position;
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

export interface DeliveryTemplateStep {
  id: string;
  template_id: string;
  position: number;
  /** Optional grouping, e.g. "hipaa". Instantiation can pick a subset of sections. */
  section: string | null;
  title: string;
  description: string | null;
  owner_role: DeliveryOwnerType;
  sla_hours: number | null;
  /** False until Jack confirms the default SLA. */
  sla_confirmed: boolean;
}

export interface DeliveryTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venture: string | null;
  /** Link to the SOP behind this template (T695). Null until Jack adds it. */
  sop_url: string | null;
  /** Where the steps were derived from (repo + path). */
  source_ref: string | null;
  builtin: boolean;
  created_at: string;
  updated_at: string;
}

export type DeliveryTemplateWithSteps = DeliveryTemplate & {
  steps: DeliveryTemplateStep[];
  /** Distinct non-null sections in step order. */
  sections: string[];
};

export interface InstantiateTemplateInput {
  client: string;
  venture?: string | null;
  /** ISO start of the first step's SLA clock. Defaults to now. */
  start_at?: string;
  /** Person per role, e.g. { contractor: 'Maria', offshore: 'Ops team' }. */
  assignees?: Partial<Record<DeliveryOwnerType, string>>;
  /** Only create steps in these sections (steps with no section are always created). */
  sections?: string[];
  /** Optional hard deadline applied to every created item. */
  deadline?: string | null;
}
