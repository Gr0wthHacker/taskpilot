/**
 * Build the client portal view (T707).
 *
 * Visibility rules, all enforced here in one place:
 *  - Queue items: `client_visible = 1` and not cancelled. Done items count
 *    only when completed inside the month; open items always show.
 *  - Renewals: `client_visible = 1`, active, due within RENEWAL_HORIZON_DAYS
 *    (overdue ones included).
 *  - Entries: `client_visible = 1`. Findings, deliverables and monthly notes
 *    must belong to the month; next steps show until marked done.
 *
 * Output is the allowlisted `PortalView` from `@/shared/portal`. Internal
 * descriptions, owner names and notes never leave this function.
 */

import { getSqlite } from '@/main/db';
import { rowToItem, type DeliveryItemRow } from '@/main/delivery/repository';
import { listRenewals } from '@/main/renewals/repository';
import type { DeliveryItem } from '@/shared/delivery';
import {
  MONTHLY_ENTRY_KINDS,
  isSafeHttpUrl,
  monthLabel,
  type PortalLinkItem,
  type PortalView,
  type PortalWorkItem,
  type PortalWorkStatus,
} from '@/shared/portal';
import { RENEWAL_ITEM_TYPE_LABELS, monthOf } from '@/shared/renewals';

import { listPortalEntries } from './entries';

export const RENEWAL_HORIZON_DAYS = 180;

function workStatus(item: DeliveryItem): PortalWorkStatus {
  switch (item.status) {
    case 'done':
      return 'completed';
    case 'waiting_on_client':
      return 'waiting_on_you';
    case 'queued':
      return 'scheduled';
    default:
      return 'in_progress';
  }
}

function toWorkItem(item: DeliveryItem): PortalWorkItem {
  return {
    title: item.title,
    status: workStatus(item),
    completed_on: item.status === 'done' && item.completed_at ? item.completed_at.slice(0, 10) : null,
    due_on: item.deadline ? item.deadline.slice(0, 10) : null,
    url: isSafeHttpUrl(item.deliverable_url) ? item.deliverable_url : null,
  };
}

export function buildPortalView(client: string, opts: { month?: string } = {}, now: number = Date.now()): PortalView {
  const month = opts.month ?? monthOf(now);

  const rows = getSqlite()
    .prepare(
      `SELECT * FROM delivery_items
       WHERE client = ? AND client_visible = 1 AND status != 'cancelled'
       ORDER BY COALESCE(completed_at, deadline, created_at)`,
    )
    .all(client) as DeliveryItemRow[];
  const items = rows.map(rowToItem);
  const completed = items
    .filter((i) => i.status === 'done' && i.completed_at && i.completed_at.slice(0, 7) === month)
    .map(toWorkItem);
  const inProgress = items.filter((i) => i.status !== 'done').map(toWorkItem);

  const entries = listPortalEntries({ client }).filter((e) => {
    if (!e.client_visible) return false;
    if (MONTHLY_ENTRY_KINDS.includes(e.kind)) return e.month === month;
    return !e.done;
  });
  const asLink = (e: (typeof entries)[number]): PortalLinkItem => ({
    kind: e.kind,
    title: e.title,
    body: e.body,
    url: isSafeHttpUrl(e.url) ? e.url : null,
  });

  const renewals = listRenewals({ client, client_visible: true }, now)
    .filter((r) => r.schedule.days_until <= RENEWAL_HORIZON_DAYS)
    .map((r) => ({
      label: r.label,
      item_type: r.item_type,
      item_type_label: RENEWAL_ITEM_TYPE_LABELS[r.item_type],
      due_on: r.due_date,
      days_until: r.schedule.days_until,
      state: r.schedule.state,
    }));

  return {
    client,
    month,
    month_label: monthLabel(month),
    generated_at: new Date(now).toISOString(),
    work: { completed, in_progress: inProgress },
    deliverables: entries.filter((e) => e.kind === 'finding' || e.kind === 'deliverable').map(asLink),
    renewals,
    next_steps: entries.filter((e) => e.kind === 'next_step').map(asLink),
    monthly_notes: entries.filter((e) => e.kind === 'monthly_note').map(asLink),
  };
}
