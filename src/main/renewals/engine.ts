/**
 * Renewal engine (T704).
 *
 * One pass over every active renewal:
 *
 *  1. If the current cycle's Delivery queue item is done, the renewal is
 *     renewed: roll the due date forward by its recurrence (or deactivate a
 *     one-time renewal) and continue with the new cycle.
 *  2. Work out which lead-time triggers have been reached for the cycle
 *     (shared `reachedTriggers`, the same math the renewals view shows).
 *  3. Record a reminder for each reached trigger not seen before. When the
 *     engine first sees a cycle late (several triggers already passed), only
 *     the most recent one is `sent`; older ones are stored as `skipped` so
 *     Jack gets one reminder, not a burst.
 *  4. On the first `sent` reminder of a cycle, create one Delivery queue item
 *     (deadline = due date) and link every reminder of the cycle to it. Later
 *     lead times remind again but never create a second item.
 *
 * The pass is idempotent: reminders are unique per (renewal, cycle due date,
 * lead days), so running it twice the same day writes nothing new.
 */

import { getSqlite } from '@/main/db';
import { createDeliveryItem, getDeliveryItem } from '@/main/delivery/repository';
import {
  RENEWAL_ITEM_TYPE_LABELS,
  dueDateToDeadlineIso,
  reachedTriggers,
  renewalTaskTitle,
  todayUtc,
  type Renewal,
  type RenewalReminder,
} from '@/shared/renewals';

import {
  currentCycleItemId,
  getRenewal,
  insertReminder,
  linkCycleReminders,
  listCycleReminders,
  listRenewals,
  rollRenewal,
} from './repository';

export interface EngineRunResult {
  ran_at: string;
  checked: number;
  rolled: Array<{ renewal_id: string; from: string; to: string | null }>;
  reminders: RenewalReminder[];
  created_items: Array<{ renewal_id: string; delivery_item_id: string }>;
}

/** Max cycles rolled per renewal per pass, so a bad recurrence cannot loop. */
const MAX_ROLLS_PER_PASS = 3;

function createCycleItem(r: Renewal, leadDays: number, now: number): string {
  const item = createDeliveryItem(
    {
      title: renewalTaskTitle(r),
      description: `${RENEWAL_ITEM_TYPE_LABELS[r.item_type]} due ${r.due_date}. Created by the renewal engine at the ${leadDays}-day mark.`,
      owner_type: r.owner_type,
      owner_name: r.owner_name ?? (r.owner_type === 'jack' ? 'Jack' : null),
      client: r.client,
      venture: r.venture,
      deadline: dueDateToDeadlineIso(r.due_date),
      sla_hours: null,
      client_visible: r.client_visible,
    },
    now,
  );
  return item.id;
}

/** Roll forward while the current cycle's queue item is done. Returns the up-to-date renewal. */
function rollIfRenewed(r: Renewal, now: number, result: EngineRunResult): Renewal | null {
  let current: Renewal | null = r;
  for (let i = 0; i < MAX_ROLLS_PER_PASS && current && current.active; i += 1) {
    const itemId = currentCycleItemId(current.id, current.due_date);
    const item = itemId ? getDeliveryItem(itemId) : null;
    if (!item || item.status !== 'done') break;
    const from = current.due_date;
    current = rollRenewal(current.id, item.completed_at ?? new Date(now).toISOString(), now);
    result.rolled.push({ renewal_id: r.id, from, to: current?.active ? current.due_date : null });
  }
  return current;
}

function processRenewal(r: Renewal, today: string, now: number, result: EngineRunResult): void {
  const current = rollIfRenewed(r, now, result);
  if (!current || !current.active) return;

  const reached = reachedTriggers(current.due_date, current.lead_times, today);
  if (reached.length === 0) return;

  const existing = new Set(listCycleReminders(current.id, current.due_date).map((x) => x.lead_days));
  const fresh = reached.filter((t) => !existing.has(t.lead_days));
  if (fresh.length === 0) return;

  // Most recent reached trigger = smallest lead time reached.
  const latestLead = Math.min(...reached.map((t) => t.lead_days));
  let itemId = currentCycleItemId(current.id, current.due_date);

  getSqlite().transaction(() => {
    for (const t of fresh) {
      const status = t.lead_days === latestLead ? 'sent' : 'skipped';
      if (status === 'sent' && !itemId) {
        itemId = createCycleItem(current, t.lead_days, now);
        result.created_items.push({ renewal_id: current.id, delivery_item_id: itemId });
      }
      const row = insertReminder(
        {
          renewal_id: current.id,
          cycle_due_date: current.due_date,
          lead_days: t.lead_days,
          trigger_date: t.trigger_date,
          status,
          delivery_item_id: itemId,
        },
        now,
      );
      if (row && row.status === 'sent') result.reminders.push(row);
    }
    if (itemId) linkCycleReminders(current.id, current.due_date, itemId);
  })();
}

export function runRenewalEngine(now: number = Date.now()): EngineRunResult {
  const result: EngineRunResult = {
    ran_at: new Date(now).toISOString(),
    checked: 0,
    rolled: [],
    reminders: [],
    created_items: [],
  };
  const today = todayUtc(now);
  for (const r of listRenewals({}, now)) {
    result.checked += 1;
    processRenewal(r, today, now, result);
  }
  return result;
}

/**
 * Jack marks a renewal as renewed: close the current cycle's queue item (if
 * one is open), then roll to the next cycle.
 */
export function markRenewed(id: string, now: number = Date.now()): Renewal | null {
  const r = getRenewal(id);
  if (!r) return null;
  const itemId = currentCycleItemId(r.id, r.due_date);
  const renewedAt = new Date(now).toISOString();
  if (itemId) {
    getSqlite()
      .prepare(
        `UPDATE delivery_items SET status = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE id = ? AND status NOT IN ('done','cancelled')`,
      )
      .run(renewedAt, renewedAt, itemId);
  }
  return rollRenewal(r.id, renewedAt, now);
}

/* -------------------------------------------------------------------------- */
/*  Scheduler                                                                 */
/* -------------------------------------------------------------------------- */

export const ENGINE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Run now and then hourly. `onRun` receives each result (the server uses it
 * to raise a desktop notification for new reminders). Returns a stop fn.
 */
export function startRenewalEngine(onRun?: (result: EngineRunResult) => void): () => void {
  const tick = (): void => {
    try {
      const result = runRenewalEngine();
      onRun?.(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[taskpilot:renewals] engine pass failed:', err instanceof Error ? err.message : String(err));
    }
  };
  tick();
  const timer = setInterval(tick, ENGINE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
