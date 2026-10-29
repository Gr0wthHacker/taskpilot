/**
 * Renewal engine (T704): shared date/recurrence math, repository, engine
 * pass (reminders + Delivery queue items, rolling cycles) and CSV import.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { getDeliveryItem, listDeliveryItems, updateDeliveryItem } from '@/main/delivery/repository';
import { importRenewalsCsv, parseCsv } from '@/main/renewals/csv';
import { markRenewed, runRenewalEngine } from '@/main/renewals/engine';
import {
  createRenewal,
  getRenewal,
  listReminders,
  listRenewals,
  updateRenewal,
} from '@/main/renewals/repository';
import {
  addMonths,
  computeRenewalSchedule,
  dueDateToDeadlineIso,
  leadTimeTriggers,
  nextDueDate,
  nextTrigger,
  normalizeLeadTimes,
  parseDateOnly,
  parseRecurrence,
  reachedTriggers,
  renewalState,
} from '@/shared/renewals';

const at = (date: string, time = '12:00:00'): number => Date.parse(`${date}T${time}.000Z`);

describe('shared renewal math', () => {
  it('parses recurrences in canonical and loose forms', () => {
    expect(parseRecurrence('none')).toBeNull();
    expect(parseRecurrence('')).toBeNull();
    expect(parseRecurrence('120d')).toEqual({ unit: 'd', interval: 120 });
    expect(parseRecurrence('yearly')).toEqual({ unit: 'y', interval: 1 });
    expect(parseRecurrence('every 2 years')).toEqual({ unit: 'y', interval: 2 });
    expect(parseRecurrence('2w')).toEqual({ unit: 'd', interval: 14 });
    expect(parseRecurrence('Quarterly')).toEqual({ unit: 'm', interval: 3 });
    expect(() => parseRecurrence('sometimes')).toThrow(/Unrecognized/);
    expect(() => parseRecurrence('0m')).toThrow(/range/);
    expect(() => parseRecurrence('constructor')).toThrow();
  });

  it('rolls due dates by recurrence with month-end clamping', () => {
    expect(nextDueDate('2027-01-31', parseRecurrence('1m'))).toBe('2027-02-28');
    expect(nextDueDate('2028-02-29', parseRecurrence('1y'))).toBe('2029-02-28');
    expect(nextDueDate('2026-11-01', parseRecurrence('120d'))).toBe('2027-03-01');
    expect(nextDueDate('2026-11-01', null)).toBeNull();
    expect(addMonths('2026-12-15', 3)).toBe('2027-03-15');
  });

  it('parses ISO and US dates and rejects impossible ones', () => {
    expect(parseDateOnly('2027-03-01')).toBe('2027-03-01');
    expect(parseDateOnly('3/1/2027')).toBe('2027-03-01');
    expect(parseDateOnly('2027-02-30')).toBeNull();
    expect(parseDateOnly('next week')).toBeNull();
  });

  it('normalizes lead times and computes triggers', () => {
    expect(normalizeLeadTimes('30/90;60 60')).toEqual([90, 60, 30]);
    expect(() => normalizeLeadTimes([])).toThrow();
    expect(() => normalizeLeadTimes([1000])).toThrow();
    expect(leadTimeTriggers('2027-03-01', [30, 90, 60])).toEqual([
      { lead_days: 90, trigger_date: '2026-12-01' },
      { lead_days: 60, trigger_date: '2026-12-31' },
      { lead_days: 30, trigger_date: '2027-01-30' },
    ]);
    expect(reachedTriggers('2027-03-01', [90, 60, 30], '2026-12-31').map((t) => t.lead_days)).toEqual([90, 60]);
    expect(nextTrigger('2027-03-01', [90, 60, 30], '2026-12-31')?.lead_days).toBe(30);
  });

  it('derives the renewal state from the same triggers', () => {
    expect(renewalState('2027-03-01', [90], '2026-11-30')).toBe('upcoming');
    expect(renewalState('2027-03-01', [90], '2026-12-01')).toBe('due_soon');
    expect(renewalState('2027-03-01', [90], '2027-03-01')).toBe('due_soon');
    expect(renewalState('2027-03-01', [90], '2027-03-02')).toBe('overdue');
    expect(renewalState('2027-03-01', [90], '2027-03-02', false)).toBe('inactive');
    expect(dueDateToDeadlineIso('2027-03-01')).toBe('2027-03-01T23:59:59.000Z');
  });
});

describe('renewal engine', () => {
  useMockedDb();

  const base = {
    client: 'Practice A',
    item_type: 'dea',
    label: 'Dr. Lee DEA',
    due_date: '2027-03-01',
    recurrence: '3y',
    lead_times: [90, 60, 30],
  } as const;

  it('applies per-type defaults and validates input', () => {
    const r = createRenewal({ client: 'P', item_type: 'caqh_attestation', label: 'Dr. Lee', due_date: '2027-01-15' });
    expect(r.recurrence).toBe('120d');
    expect(r.lead_times).toEqual([30, 14, 7]);
    expect(r.client_visible).toBe(false);
    expect(() => createRenewal({ ...base, due_date: 'soon' })).toThrow(/due_date/);
    expect(() => createRenewal({ ...base, item_type: 'passport' })).toThrow(/item type/);
    expect(() => createRenewal({ ...base, recurrence: 'often' })).toThrow(/recurrence/i);
  });

  it('does nothing before the first lead time', () => {
    createRenewal(base);
    const res = runRenewalEngine(at('2026-11-30'));
    expect(res.reminders).toHaveLength(0);
    expect(res.created_items).toHaveLength(0);
    expect(listDeliveryItems().items).toHaveLength(0);
  });

  it('creates one queue item at the first lead time and reminds at each later one', () => {
    const r = createRenewal({ ...base, owner_type: 'contractor', owner_name: 'Maria', client_visible: true });

    const first = runRenewalEngine(at('2026-12-01'));
    expect(first.reminders.map((x) => x.lead_days)).toEqual([90]);
    expect(first.created_items).toHaveLength(1);
    const item = getDeliveryItem(first.created_items[0]!.delivery_item_id)!;
    expect(item.title).toBe('DEA registration renewal: Dr. Lee DEA');
    expect(item.client).toBe('Practice A');
    expect(item.owner_type).toBe('contractor');
    expect(item.owner_name).toBe('Maria');
    expect(item.deadline).toBe('2027-03-01T23:59:59.000Z');
    expect(item.client_visible).toBe(true);

    // Same day again: idempotent.
    const again = runRenewalEngine(at('2026-12-01', '18:00:00'));
    expect(again.reminders).toHaveLength(0);
    expect(again.created_items).toHaveLength(0);

    const second = runRenewalEngine(at('2026-12-31'));
    expect(second.reminders.map((x) => x.lead_days)).toEqual([60]);
    expect(second.reminders[0]!.delivery_item_id).toBe(item.id);
    expect(second.created_items).toHaveLength(0);
    expect(listDeliveryItems().items).toHaveLength(1);

    const listed = listRenewals({}, at('2026-12-31'));
    expect(listed[0]!.current_item_id).toBe(item.id);
    expect(listed[0]!.schedule.state).toBe('due_soon');
    expect(listed[0]!.schedule.next_reminder).toEqual({ lead_days: 30, trigger_date: '2027-01-30' });
    expect(listReminders().map((x) => x.renewal_id)).toEqual([r.id, r.id]);
  });

  it('sends only the latest reminder when a cycle is first seen late', () => {
    createRenewal(base);
    const res = runRenewalEngine(at('2027-02-10'));
    expect(res.reminders.map((x) => x.lead_days)).toEqual([30]);
    expect(res.created_items).toHaveLength(1);
    // The skipped 90/60 rows exist but are not surfaced.
    expect(listReminders()).toHaveLength(1);
    expect(runRenewalEngine(at('2027-02-11')).reminders).toHaveLength(0);
  });

  it('rolls to the next cycle when the queue item is done', () => {
    const r = createRenewal({ ...base, recurrence: '1y', lead_times: [30] });
    const first = runRenewalEngine(at('2027-01-30'));
    const itemId = first.created_items[0]!.delivery_item_id;
    updateDeliveryItem(itemId, { status: 'done' }, at('2027-02-05'));

    const next = runRenewalEngine(at('2027-02-06'));
    expect(next.rolled).toEqual([{ renewal_id: r.id, from: '2027-03-01', to: '2028-03-01' }]);
    const rolled = getRenewal(r.id)!;
    expect(rolled.due_date).toBe('2028-03-01');
    expect(rolled.last_renewed_at).toBe(new Date(at('2027-02-05')).toISOString());
    expect(next.created_items).toHaveLength(0);

    // Next cycle's lead time creates a fresh item.
    const later = runRenewalEngine(at('2028-01-31'));
    expect(later.created_items).toHaveLength(1);
    expect(later.created_items[0]!.delivery_item_id).not.toBe(itemId);
  });

  it('deactivates a one-time renewal once renewed', () => {
    const r = createRenewal({ ...base, item_type: 'custom', recurrence: 'none', lead_times: [10] });
    runRenewalEngine(at('2027-02-20'));
    const done = markRenewed(r.id, at('2027-02-25'))!;
    expect(done.active).toBe(false);
    expect(computeRenewalSchedule(done, at('2027-02-25')).state).toBe('inactive');
    const item = getDeliveryItem(listDeliveryItems({ include_closed: true }).items[0]!.id)!;
    expect(item.status).toBe('done');
    expect(runRenewalEngine(at('2027-02-26')).checked).toBe(0);
  });

  it('mark renewed without a queue item just advances the due date', () => {
    const r = createRenewal({ ...base, recurrence: '2y' });
    expect(markRenewed(r.id, at('2026-10-01'))!.due_date).toBe('2029-03-01');
  });

  it('starts a new cycle when the due date is edited', () => {
    const r = createRenewal({ ...base, lead_times: [30] });
    runRenewalEngine(at('2027-01-30'));
    updateRenewal(r.id, { due_date: '2027-06-01' });
    expect(runRenewalEngine(at('2027-02-01')).reminders).toHaveLength(0);
    const res = runRenewalEngine(at('2027-05-02'));
    expect(res.reminders).toHaveLength(1);
    expect(res.created_items).toHaveLength(1);
  });
});

describe('renewals CSV import', () => {
  useMockedDb();

  it('parses quoted fields and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  const csv = [
    'Client,Type,Label,Due Date,Recurrence,Lead Times,Owner,Visible',
    'Practice A,DEA,Dr. Lee DEA,2027-03-01,3y,90/60/30,Maria,yes',
    'Practice A,CAQH,Dr. Lee CAQH,1/15/2027,,,,',
    'Practice B,state_license,"NY license, Dr. Kim",2027-08-31,every 2 years,"90,60",,no',
  ].join('\n');

  it('dry-runs, imports, and skips duplicates', () => {
    const dry = importRenewalsCsv(csv, { dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, imported: 0, errors: 0, duplicates: 0 });
    expect(listRenewals()).toHaveLength(0);

    const res = importRenewalsCsv(csv);
    expect(res).toMatchObject({ dry_run: false, imported: 3, errors: 0 });
    const all = listRenewals();
    const caqh = all.find((r) => r.item_type === 'caqh_attestation')!;
    expect(caqh.due_date).toBe('2027-01-15');
    expect(caqh.recurrence).toBe('120d');
    const dea = all.find((r) => r.item_type === 'dea')!;
    expect(dea.owner_name).toBe('Maria');
    expect(dea.client_visible).toBe(true);
    const lic = all.find((r) => r.item_type === 'state_license')!;
    expect(lic.label).toBe('NY license, Dr. Kim');
    expect(lic.lead_times).toEqual([90, 60]);

    const again = importRenewalsCsv(csv);
    expect(again).toMatchObject({ imported: 0, duplicates: 3 });
  });

  it('imports nothing when any row is invalid unless skip_invalid is set', () => {
    const bad = `${csv}\nPractice C,passport,X,2027-01-01,,,,\nPractice C,dea,Y,2027-13-01,,,,`;
    const res = importRenewalsCsv(bad);
    expect(res.dry_run).toBe(true);
    expect(res.errors).toBe(2);
    expect(res.rows.filter((r) => r.status === 'error').map((r) => r.line)).toEqual([5, 6]);
    expect(listRenewals()).toHaveLength(0);

    const partial = importRenewalsCsv(bad, { skip_invalid: true });
    expect(partial.imported).toBe(3);
  });

  it('rejects a file without the required columns', () => {
    expect(() => importRenewalsCsv('client,label\nA,B')).toThrow(/item_type, due_date/);
  });
});
