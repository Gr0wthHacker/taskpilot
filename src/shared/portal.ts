/**
 * Client portal contract (T707, monthly notes for T703).
 *
 * A portal is a read-only page per client, opened through a signed share link
 * that expires and can be revoked. It shows only what Jack published: queue
 * items and renewals with `client_visible`, and portal entries (findings,
 * deliverable links, next steps, monthly notes) marked visible.
 *
 * The view model below is an allowlist. It carries no free-text descriptions
 * from the Delivery queue, no owner names and no notes fields, so nothing
 * Jack wrote for internal use reaches a client by accident, and it has no
 * patient fields at all. Keep it that way: add fields here deliberately.
 */

import type { RenewalItemType, RenewalState } from './renewals';

export const PORTAL_ENTRY_KINDS = ['finding', 'deliverable', 'next_step', 'monthly_note'] as const;
export type PortalEntryKind = (typeof PORTAL_ENTRY_KINDS)[number];

export const PORTAL_ENTRY_KIND_LABELS: Record<PortalEntryKind, string> = {
  finding: 'Finding',
  deliverable: 'Deliverable',
  next_step: 'Next step',
  monthly_note: 'Monthly note',
};

/** Kinds scoped to a month. Next steps stay on the page until marked done. */
export const MONTHLY_ENTRY_KINDS: readonly PortalEntryKind[] = ['finding', 'deliverable', 'monthly_note'];

export interface PortalEntry {
  id: string;
  client: string;
  kind: PortalEntryKind;
  title: string;
  body: string | null;
  url: string | null;
  /** `YYYY-MM` for monthly kinds. Null for next steps. */
  month: string | null;
  client_visible: boolean;
  /** Next steps only: hidden from the portal once done. */
  done: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface PortalLink {
  id: string;
  client: string;
  label: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  created_at: string;
}

export type PortalLinkStatus = 'active' | 'expired' | 'revoked';

export function portalLinkStatus(link: Pick<PortalLink, 'expires_at' | 'revoked_at'>, now: number = Date.now()): PortalLinkStatus {
  if (link.revoked_at) return 'revoked';
  return Date.parse(link.expires_at) <= now ? 'expired' : 'active';
}

export type PortalLinkWithUrl = PortalLink & { status: PortalLinkStatus; url: string };

/** Client-facing work status. Internal statuses collapse to these. */
export type PortalWorkStatus = 'completed' | 'in_progress' | 'waiting_on_you' | 'scheduled';

export const PORTAL_WORK_STATUS_LABELS: Record<PortalWorkStatus, string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  waiting_on_you: 'Waiting on you',
  scheduled: 'Scheduled',
};

export interface PortalWorkItem {
  title: string;
  status: PortalWorkStatus;
  /** YYYY-MM-DD, completed items only. */
  completed_on: string | null;
  /** YYYY-MM-DD of the client deadline, if any. */
  due_on: string | null;
  url: string | null;
}

export interface PortalLinkItem {
  kind: PortalEntryKind;
  title: string;
  body: string | null;
  url: string | null;
}

export interface PortalRenewalItem {
  label: string;
  item_type: RenewalItemType;
  item_type_label: string;
  due_on: string;
  days_until: number;
  state: RenewalState;
}

export interface PortalView {
  client: string;
  /** `YYYY-MM` the page covers. */
  month: string;
  /** e.g. "October 2026". */
  month_label: string;
  generated_at: string;
  work: {
    completed: PortalWorkItem[];
    in_progress: PortalWorkItem[];
  };
  /** Findings and deliverable links published for the month. */
  deliverables: PortalLinkItem[];
  renewals: PortalRenewalItem[];
  next_steps: PortalLinkItem[];
  monthly_notes: PortalLinkItem[];
}

/** Only http(s) URLs may be published; blocks `javascript:` and friends. */
export function isSafeHttpUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1] ?? ''} ${y}`;
}

export function isMonth(raw: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw);
}
