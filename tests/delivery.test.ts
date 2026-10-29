/**
 * Delivery queue (T693) + templates (T694).
 *
 * Covers the shared SLA math, the repository (CRUD, filters, ordering,
 * template seeding and instantiation) against an in-memory DB.
 */

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import {
  createDeliveryItem,
  ensureBuiltinTemplates,
  getDeliveryTemplate,
  instantiateDeliveryTemplate,
  listDeliveryFacets,
  listDeliveryItems,
  listDeliveryTemplates,
  updateDeliveryItem,
  updateDeliveryTemplate,
  updateDeliveryTemplateStep,
} from '@/main/delivery/repository';
import { BUILTIN_TEMPLATES } from '@/main/delivery/builtin-templates';
import { computeSla, formatSlaTimer } from '@/shared/delivery';

const H = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-02T14:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('computeSla', () => {
  const base = {
    status: 'queued' as const,
    deadline: null,
    sla_started_at: iso(T0),
    sla_due_at: iso(T0 + 100 * H),
    completed_at: null,
  };

  it('is on_track early in the window', () => {
    const sla = computeSla(base, T0 + 10 * H);
    expect(sla.state).toBe('on_track');
    expect(sla.remaining_ms).toBe(90 * H);
    expect(formatSlaTimer(sla)).toBe('3d 18h left');
  });

  it('turns at_risk in the last 25% of the window', () => {
    expect(computeSla(base, T0 + 76 * H).state).toBe('at_risk');
  });

  it('is breached once past due', () => {
    const sla = computeSla(base, T0 + 103 * H);
    expect(sla.state).toBe('breached');
    expect(formatSlaTimer(sla)).toBe('3h over');
  });

  it('uses the earlier of SLA due and deadline', () => {
    const sla = computeSla({ ...base, deadline: iso(T0 + 20 * H) }, T0 + 21 * H);
    expect(sla.state).toBe('breached');
    expect(sla.due_at).toBe(iso(T0 + 20 * H));
  });

  it('scores closed items as met or missed', () => {
    expect(computeSla({ ...base, status: 'done', completed_at: iso(T0 + 50 * H) }).state).toBe('met');
    expect(computeSla({ ...base, status: 'done', completed_at: iso(T0 + 150 * H) }).state).toBe('missed');
    expect(computeSla({ ...base, status: 'cancelled', completed_at: iso(T0) }).state).toBe('none');
  });

  it('is none with no SLA and no deadline', () => {
    expect(computeSla({ ...base, sla_due_at: null }).state).toBe('none');
  });
});

describe('delivery queue repository', () => {
  useMockedDb();

  it('creates items with an SLA due time and stamps completion on close', () => {
    const item = createDeliveryItem(
      { title: 'Draft application', owner_type: 'contractor', owner_name: 'Maria', client: 'Dr. A', sla_hours: 48 },
      T0,
    );
    expect(item.sla_started_at).toBe(iso(T0));
    expect(item.sla_due_at).toBe(iso(T0 + 48 * H));
    expect(item.status).toBe('queued');

    const done = updateDeliveryItem(item.id, { status: 'done' }, T0 + 10 * H)!;
    expect(done.completed_at).toBe(iso(T0 + 10 * H));
    const reopened = updateDeliveryItem(item.id, { status: 'in_progress' }, T0 + 11 * H)!;
    expect(reopened.completed_at).toBeNull();

    const resized = updateDeliveryItem(item.id, { sla_hours: 24 }, T0 + 12 * H)!;
    expect(resized.sla_due_at).toBe(iso(T0 + 24 * H));
  });

  it('rejects blank client and title', () => {
    expect(() => createDeliveryItem({ title: 'x', owner_type: 'jack', client: '  ' })).toThrow(/client/);
    expect(() => createDeliveryItem({ title: ' ', owner_type: 'jack', client: 'c' })).toThrow(/title/);
  });

  it('filters by owner and SLA state and sorts breached first', () => {
    const breached = createDeliveryItem(
      { title: 'late', owner_type: 'offshore', client: 'C1', sla_hours: 1, sla_started_at: iso(T0 - 10 * H) },
      T0,
    );
    const atRisk = createDeliveryItem(
      { title: 'close', owner_type: 'contractor', owner_name: 'Maria', client: 'C1', sla_hours: 10, sla_started_at: iso(T0 - 9 * H) },
      T0,
    );
    const fine = createDeliveryItem(
      { title: 'fine', owner_type: 'contractor', owner_name: 'Sam', client: 'C2', sla_hours: 100 },
      T0,
    );
    const closed = createDeliveryItem({ title: 'closed', owner_type: 'jack', client: 'C2', status: 'done' }, T0);

    const all = listDeliveryItems({}, T0);
    expect(all.items.map((i) => i.id)).toEqual([breached.id, atRisk.id, fine.id]);
    expect(all.summary.by_sla.breached).toBe(1);
    expect(all.summary.by_sla.at_risk).toBe(1);
    expect(all.summary.by_owner.contractor).toBe(2);

    expect(listDeliveryItems({ sla_state: ['breached', 'at_risk'] }, T0).items.map((i) => i.title)).toEqual([
      'late',
      'close',
    ]);
    expect(listDeliveryItems({ owner_type: 'contractor', owner_name: 'Sam' }, T0).items.map((i) => i.title)).toEqual([
      'fine',
    ]);
    expect(listDeliveryItems({ owner_name: '' }, T0).items.map((i) => i.title)).toEqual(['late']);
    expect(listDeliveryItems({ include_closed: true }, T0).items.map((i) => i.id)).toContain(closed.id);
    expect(listDeliveryItems({ client: 'C2' }, T0).items.map((i) => i.title)).toEqual(['fine']);

    const facets = listDeliveryFacets();
    expect(facets.owner_names).toEqual(['Maria', 'Sam']);
    expect(facets.clients).toEqual(['C1', 'C2']);
  });
});

describe('delivery templates', () => {
  useMockedDb();

  it('seeds the three built-in templates once, with unconfirmed SLAs and no SOP link', () => {
    expect(ensureBuiltinTemplates()).toHaveLength(3);
    expect(ensureBuiltinTemplates()).toHaveLength(0);
    const templates = listDeliveryTemplates();
    expect(templates.map((t) => t.slug).sort()).toEqual(
      ['clinician-standing-onboarding', 'multistate-licensing', 'stetwright-practice-programs'],
    );
    for (const t of templates) {
      expect(t.sop_url).toBeNull();
      expect(t.steps.length).toBeGreaterThan(0);
      expect(t.steps.every((s) => !s.sla_confirmed && s.sla_hours !== null)).toBe(true);
    }
    const stet = templates.find((t) => t.slug === 'stetwright-practice-programs')!;
    expect(stet.sections).toEqual(['hipaa', 'section-504', 'ai']);
  });

  it('keeps edits when built-ins are re-seeded', () => {
    const t = listDeliveryTemplates().find((x) => x.slug === 'multistate-licensing')!;
    updateDeliveryTemplate(t.id, { sop_url: 'https://example.com/sop' });
    const step = updateDeliveryTemplateStep(t.id, t.steps[0]!.id, { sla_hours: 12 })!;
    expect(step.sla_hours).toBe(12);
    expect(step.sla_confirmed).toBe(true);
    ensureBuiltinTemplates();
    const again = getDeliveryTemplate('multistate-licensing')!;
    expect(again.sop_url).toBe('https://example.com/sop');
    expect(again.steps[0]!.sla_hours).toBe(12);
  });

  it('instantiates a template into chained queue items', () => {
    const t = listDeliveryTemplates().find((x) => x.slug === 'multistate-licensing')!;
    const def = BUILTIN_TEMPLATES.find((x) => x.slug === 'multistate-licensing')!;
    const { instance_id, items } = instantiateDeliveryTemplate(
      t.id,
      { client: 'Dr. Example, TX', assignees: { contractor: 'Maria', offshore: 'Ops team' }, start_at: iso(T0) },
      T0,
    );
    expect(items).toHaveLength(def.steps.length);
    expect(items.every((i) => i.instance_id === instance_id && i.client === 'Dr. Example, TX')).toBe(true);
    expect(items[0]!.venture).toBe('MultiStateMD');
    expect(items[0]!.owner_name).toBe('Maria');
    expect(items[1]!.owner_name).toBe('Ops team');
    const review = items.find((i) => i.owner_type === 'jack')!;
    expect(review.owner_name).toBe('Jack');

    // Step 2's clock starts when step 1's window ends.
    expect(items[0]!.sla_due_at).toBe(iso(T0 + def.steps[0]!.sla_hours * H));
    expect(items[1]!.sla_started_at).toBe(items[0]!.sla_due_at);

    const queue = listDeliveryItems({ instance_id }, T0);
    expect(queue.items).toHaveLength(def.steps.length);
  });

  it('creates only the chosen sections', () => {
    const { items } = instantiateDeliveryTemplate('stetwright-practice-programs', {
      client: 'Practice B',
      sections: ['ai'],
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.title.startsWith('AI use:'))).toBe(true);
    expect(() =>
      instantiateDeliveryTemplate('stetwright-practice-programs', { client: 'x', sections: ['nope'] }),
    ).toThrow(/Unknown section/);
  });
});

describe('v11 migration', () => {
  it('adds the delivery tables to a DB stamped at v10', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { runInlineMigrations } = await import('@/main/db/migrations');
    const { getCurrentVersion, setVersion } = await import('@/main/db/schema-version');
    const db = new Database(':memory:');
    runInlineMigrations(db);
    db.exec('DROP TABLE delivery_items; DROP TABLE delivery_template_steps; DROP TABLE delivery_templates;');
    db.exec('DELETE FROM _schema_version');
    setVersion(db, 10, 'simulated v10');
    runInlineMigrations(db);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'delivery_%'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names.sort()).toEqual(['delivery_items', 'delivery_template_steps', 'delivery_templates']);
    expect(getCurrentVersion(db)).toBeGreaterThanOrEqual(11);
    db.close();
  });
});
