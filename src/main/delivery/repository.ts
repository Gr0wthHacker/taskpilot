/**
 * Delivery queue + templates repository (T693/T694).
 *
 * Raw SQL over `getSqlite()`, same as the memory subsystem. Tables are
 * created by the v11 inline migration (`src/main/db/migrations.ts`).
 *
 * SLA state is derived, never stored: `listDeliveryItems` computes it per row
 * with the shared `computeSla` so the API, the renderer and tests agree.
 */

import { nanoid } from 'nanoid';

import { getSqlite } from '@/main/db';
import {
  compareQueueItems,
  isClosedStatus,
  withSla,
  type DeliveryItem,
  type DeliveryItemWithSla,
  type DeliveryOwnerType,
  type DeliveryStatus,
  type DeliveryTemplate,
  type DeliveryTemplateStep,
  type DeliveryTemplateWithSteps,
  type InstantiateTemplateInput,
  type SlaState,
} from '@/shared/delivery';

import { BUILTIN_TEMPLATES, type BuiltinTemplate } from './builtin-templates';

const HOUR_MS = 60 * 60 * 1000;

export class DeliveryError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function newId(): string {
  return nanoid(12);
}

function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

function toIso(value: string, field: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new DeliveryError('invalid', `${field} is not a valid date: ${value}`);
  return new Date(ms).toISOString();
}

function dueFrom(startIso: string, slaHours: number | null): string | null {
  if (slaHours === null) return null;
  return new Date(Date.parse(startIso) + slaHours * HOUR_MS).toISOString();
}

/* -------------------------------------------------------------------------- */
/*  Row mapping                                                               */
/* -------------------------------------------------------------------------- */

interface ItemRow {
  id: string;
  title: string;
  description: string | null;
  owner_type: string;
  owner_name: string | null;
  client: string;
  venture: string | null;
  status: string;
  deadline: string | null;
  sla_hours: number | null;
  sla_started_at: string;
  sla_due_at: string | null;
  completed_at: string | null;
  template_id: string | null;
  template_step_id: string | null;
  instance_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

function rowToItem(r: ItemRow): DeliveryItem {
  return {
    ...r,
    owner_type: r.owner_type as DeliveryOwnerType,
    status: r.status as DeliveryStatus,
    sla_hours: r.sla_hours === null ? null : Number(r.sla_hours),
    position: Number(r.position),
  };
}

interface TemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  venture: string | null;
  sop_url: string | null;
  source_ref: string | null;
  builtin: number;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(r: TemplateRow): DeliveryTemplate {
  return { ...r, builtin: r.builtin === 1 };
}

interface StepRow {
  id: string;
  template_id: string;
  position: number;
  section: string | null;
  title: string;
  description: string | null;
  owner_role: string;
  sla_hours: number | null;
  sla_confirmed: number;
}

function rowToStep(r: StepRow): DeliveryTemplateStep {
  return {
    ...r,
    position: Number(r.position),
    owner_role: r.owner_role as DeliveryOwnerType,
    sla_hours: r.sla_hours === null ? null : Number(r.sla_hours),
    sla_confirmed: r.sla_confirmed === 1,
  };
}

/* -------------------------------------------------------------------------- */
/*  Items                                                                     */
/* -------------------------------------------------------------------------- */

export interface CreateDeliveryItemInput {
  title: string;
  description?: string | null;
  owner_type: DeliveryOwnerType;
  owner_name?: string | null;
  client: string;
  venture?: string | null;
  status?: DeliveryStatus;
  deadline?: string | null;
  sla_hours?: number | null;
  sla_started_at?: string;
  template_id?: string | null;
  template_step_id?: string | null;
  instance_id?: string | null;
  position?: number;
}

export function getDeliveryItem(id: string): DeliveryItem | null {
  const row = getSqlite().prepare('SELECT * FROM delivery_items WHERE id = ?').get(id) as
    | ItemRow
    | undefined;
  return row ? rowToItem(row) : null;
}

export function createDeliveryItem(input: CreateDeliveryItemInput, now: number = Date.now()): DeliveryItem {
  const title = input.title.trim();
  const client = input.client.trim();
  if (!title) throw new DeliveryError('invalid', 'title is required');
  if (!client) throw new DeliveryError('invalid', 'client is required');

  const id = newId();
  const ts = nowIso(now);
  const status = input.status ?? 'queued';
  const slaHours = input.sla_hours ?? null;
  const started = input.sla_started_at ? toIso(input.sla_started_at, 'sla_started_at') : ts;
  const deadline = input.deadline ? toIso(input.deadline, 'deadline') : null;

  getSqlite()
    .prepare(
      `INSERT INTO delivery_items (
        id, title, description, owner_type, owner_name, client, venture, status,
        deadline, sla_hours, sla_started_at, sla_due_at, completed_at,
        template_id, template_step_id, instance_id, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      title,
      input.description ?? null,
      input.owner_type,
      input.owner_name?.trim() || null,
      client,
      input.venture?.trim() || null,
      status,
      deadline,
      slaHours,
      started,
      dueFrom(started, slaHours),
      isClosedStatus(status) ? ts : null,
      input.template_id ?? null,
      input.template_step_id ?? null,
      input.instance_id ?? null,
      input.position ?? 0,
      ts,
      ts,
    );
  return getDeliveryItem(id)!;
}

export interface UpdateDeliveryItemInput {
  title?: string;
  description?: string | null;
  owner_type?: DeliveryOwnerType;
  owner_name?: string | null;
  client?: string;
  venture?: string | null;
  status?: DeliveryStatus;
  deadline?: string | null;
  sla_hours?: number | null;
  sla_started_at?: string;
}

export function updateDeliveryItem(
  id: string,
  patch: UpdateDeliveryItemInput,
  now: number = Date.now(),
): DeliveryItem | null {
  const current = getDeliveryItem(id);
  if (!current) return null;

  const next: DeliveryItem = { ...current };
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new DeliveryError('invalid', 'title is required');
    next.title = t;
  }
  if (patch.client !== undefined) {
    const c = patch.client.trim();
    if (!c) throw new DeliveryError('invalid', 'client is required');
    next.client = c;
  }
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.owner_type !== undefined) next.owner_type = patch.owner_type;
  if (patch.owner_name !== undefined) next.owner_name = patch.owner_name?.trim() || null;
  if (patch.venture !== undefined) next.venture = patch.venture?.trim() || null;
  if (patch.deadline !== undefined) {
    next.deadline = patch.deadline ? toIso(patch.deadline, 'deadline') : null;
  }
  if (patch.sla_started_at !== undefined) {
    next.sla_started_at = toIso(patch.sla_started_at, 'sla_started_at');
  }
  if (patch.sla_hours !== undefined) next.sla_hours = patch.sla_hours;
  next.sla_due_at = dueFrom(next.sla_started_at, next.sla_hours);

  if (patch.status !== undefined && patch.status !== current.status) {
    next.status = patch.status;
    const wasClosed = isClosedStatus(current.status);
    const nowClosed = isClosedStatus(patch.status);
    if (nowClosed && !wasClosed) next.completed_at = nowIso(now);
    if (!nowClosed) next.completed_at = null;
  }
  next.updated_at = nowIso(now);

  getSqlite()
    .prepare(
      `UPDATE delivery_items SET
        title = ?, description = ?, owner_type = ?, owner_name = ?, client = ?, venture = ?,
        status = ?, deadline = ?, sla_hours = ?, sla_started_at = ?, sla_due_at = ?,
        completed_at = ?, updated_at = ?
      WHERE id = ?`,
    )
    .run(
      next.title,
      next.description,
      next.owner_type,
      next.owner_name,
      next.client,
      next.venture,
      next.status,
      next.deadline,
      next.sla_hours,
      next.sla_started_at,
      next.sla_due_at,
      next.completed_at,
      next.updated_at,
      id,
    );
  return getDeliveryItem(id);
}

export function deleteDeliveryItem(id: string): boolean {
  const res = getSqlite().prepare('DELETE FROM delivery_items WHERE id = ?').run(id);
  return res.changes > 0;
}

export interface ListDeliveryItemsFilter {
  owner_type?: DeliveryOwnerType;
  /** Exact match. Pass the empty string to select unassigned items. */
  owner_name?: string;
  sla_state?: SlaState[];
  status?: DeliveryStatus[];
  client?: string;
  venture?: string;
  instance_id?: string;
  /** Include done/cancelled. Default false. */
  include_closed?: boolean;
}

export interface DeliveryQueueSummary {
  total: number;
  by_sla: Record<SlaState, number>;
  by_owner: Record<DeliveryOwnerType, number>;
}

function emptySummary(): DeliveryQueueSummary {
  return {
    total: 0,
    by_sla: { none: 0, on_track: 0, at_risk: 0, breached: 0, met: 0, missed: 0 },
    by_owner: { jack: 0, contractor: 0, offshore: 0 },
  };
}

/**
 * List queue items, sorted breached → at risk → on track → no SLA, then by
 * soonest due. The summary counts reflect every filter except `sla_state`,
 * so the SLA filter chips can show how many items each one would select.
 */
export function listDeliveryItems(
  filter: ListDeliveryItemsFilter = {},
  now: number = Date.now(),
): { items: DeliveryItemWithSla[]; summary: DeliveryQueueSummary } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.owner_type) {
    where.push('owner_type = ?');
    params.push(filter.owner_type);
  }
  if (filter.owner_name !== undefined) {
    if (filter.owner_name === '') {
      where.push('owner_name IS NULL');
    } else {
      where.push('owner_name = ?');
      params.push(filter.owner_name);
    }
  }
  if (filter.client) {
    where.push('client = ?');
    params.push(filter.client);
  }
  if (filter.venture) {
    where.push('venture = ?');
    params.push(filter.venture);
  }
  if (filter.instance_id) {
    where.push('instance_id = ?');
    params.push(filter.instance_id);
  }
  if (filter.status && filter.status.length > 0) {
    where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  } else if (!filter.include_closed) {
    where.push("status NOT IN ('done','cancelled')");
  }

  const sql = `SELECT * FROM delivery_items${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const rows = getSqlite().prepare(sql).all(...params) as ItemRow[];
  const all = rows.map((r) => withSla(rowToItem(r), now));

  const summary = emptySummary();
  for (const item of all) {
    summary.total += 1;
    summary.by_sla[item.sla.state] += 1;
    summary.by_owner[item.owner_type] += 1;
  }

  const slaFilter = filter.sla_state && filter.sla_state.length > 0 ? new Set(filter.sla_state) : null;
  const items = (slaFilter ? all.filter((i) => slaFilter.has(i.sla.state)) : all).sort(compareQueueItems);
  return { items, summary };
}

/** Distinct owner names, clients and ventures, for filter dropdowns. */
export function listDeliveryFacets(): {
  owner_names: string[];
  clients: string[];
  ventures: string[];
} {
  const db = getSqlite();
  const col = (c: string): string[] =>
    (
      db
        .prepare(`SELECT DISTINCT ${c} AS v FROM delivery_items WHERE ${c} IS NOT NULL ORDER BY ${c}`)
        .all() as Array<{ v: string }>
    ).map((r) => r.v);
  const ventures = new Set(col('venture'));
  for (const r of db
    .prepare('SELECT DISTINCT venture AS v FROM delivery_templates WHERE venture IS NOT NULL')
    .all() as Array<{ v: string }>) {
    ventures.add(r.v);
  }
  return {
    owner_names: col('owner_name'),
    clients: col('client'),
    ventures: [...ventures].sort(),
  };
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

function insertTemplate(def: BuiltinTemplate, now: number): void {
  const db = getSqlite();
  const ts = nowIso(now);
  const templateId = newId();
  db.prepare(
    `INSERT INTO delivery_templates
      (id, slug, name, description, venture, sop_url, source_ref, builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
  ).run(templateId, def.slug, def.name, def.description, def.venture, def.source_ref, ts, ts);
  const insertStep = db.prepare(
    `INSERT INTO delivery_template_steps
      (id, template_id, position, section, title, description, owner_role, sla_hours, sla_confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  def.steps.forEach((s, i) => {
    insertStep.run(newId(), templateId, i, s.section ?? null, s.title, s.description, s.owner_role, s.sla_hours);
  });
}

/**
 * Insert any built-in template whose slug is not in the table yet. Never
 * touches existing rows, so Jack's SLA and SOP edits survive. Returns the
 * slugs that were inserted.
 */
export function ensureBuiltinTemplates(now: number = Date.now()): string[] {
  const db = getSqlite();
  const existing = new Set(
    (db.prepare('SELECT slug FROM delivery_templates').all() as Array<{ slug: string }>).map((r) => r.slug),
  );
  const missing = BUILTIN_TEMPLATES.filter((t) => !existing.has(t.slug));
  if (missing.length === 0) return [];
  db.transaction(() => {
    for (const def of missing) insertTemplate(def, now);
  })();
  return missing.map((t) => t.slug);
}

function stepsFor(templateId: string): DeliveryTemplateStep[] {
  return (
    getSqlite()
      .prepare('SELECT * FROM delivery_template_steps WHERE template_id = ? ORDER BY position')
      .all(templateId) as StepRow[]
  ).map(rowToStep);
}

function withSteps(t: DeliveryTemplate): DeliveryTemplateWithSteps {
  const steps = stepsFor(t.id);
  const sections: string[] = [];
  for (const s of steps) if (s.section && !sections.includes(s.section)) sections.push(s.section);
  return { ...t, steps, sections };
}

export function listDeliveryTemplates(): DeliveryTemplateWithSteps[] {
  ensureBuiltinTemplates();
  return (getSqlite().prepare('SELECT * FROM delivery_templates ORDER BY name').all() as TemplateRow[])
    .map(rowToTemplate)
    .map(withSteps);
}

/** By id or slug. Seeds the built-ins first so a fresh DB can address them by slug. */
export function getDeliveryTemplate(id: string): DeliveryTemplateWithSteps | null {
  ensureBuiltinTemplates();
  const row = getSqlite()
    .prepare('SELECT * FROM delivery_templates WHERE id = ? OR slug = ?')
    .get(id, id) as TemplateRow | undefined;
  return row ? withSteps(rowToTemplate(row)) : null;
}

export interface UpdateDeliveryTemplateInput {
  name?: string;
  description?: string | null;
  venture?: string | null;
  sop_url?: string | null;
}

export function updateDeliveryTemplate(
  id: string,
  patch: UpdateDeliveryTemplateInput,
  now: number = Date.now(),
): DeliveryTemplateWithSteps | null {
  const current = getDeliveryTemplate(id);
  if (!current) return null;
  const name = patch.name !== undefined ? patch.name.trim() : current.name;
  if (!name) throw new DeliveryError('invalid', 'name is required');
  getSqlite()
    .prepare(
      'UPDATE delivery_templates SET name = ?, description = ?, venture = ?, sop_url = ?, updated_at = ? WHERE id = ?',
    )
    .run(
      name,
      patch.description !== undefined ? patch.description : current.description,
      patch.venture !== undefined ? patch.venture?.trim() || null : current.venture,
      patch.sop_url !== undefined ? patch.sop_url?.trim() || null : current.sop_url,
      nowIso(now),
      current.id,
    );
  return getDeliveryTemplate(current.id);
}

export interface UpdateDeliveryTemplateStepInput {
  title?: string;
  description?: string | null;
  owner_role?: DeliveryOwnerType;
  sla_hours?: number | null;
  sla_confirmed?: boolean;
}

export function updateDeliveryTemplateStep(
  templateId: string,
  stepId: string,
  patch: UpdateDeliveryTemplateStepInput,
  now: number = Date.now(),
): DeliveryTemplateStep | null {
  const template = getDeliveryTemplate(templateId);
  if (!template) return null;
  const step = template.steps.find((s) => s.id === stepId);
  if (!step) return null;
  const title = patch.title !== undefined ? patch.title.trim() : step.title;
  if (!title) throw new DeliveryError('invalid', 'title is required');
  // Editing the SLA value without saying otherwise counts as confirming it.
  const slaConfirmed =
    patch.sla_confirmed !== undefined
      ? patch.sla_confirmed
      : patch.sla_hours !== undefined
        ? true
        : step.sla_confirmed;
  const db = getSqlite();
  db.prepare(
    `UPDATE delivery_template_steps SET title = ?, description = ?, owner_role = ?, sla_hours = ?, sla_confirmed = ?
     WHERE id = ?`,
  ).run(
    title,
    patch.description !== undefined ? patch.description : step.description,
    patch.owner_role ?? step.owner_role,
    patch.sla_hours !== undefined ? patch.sla_hours : step.sla_hours,
    slaConfirmed ? 1 : 0,
    stepId,
  );
  db.prepare('UPDATE delivery_templates SET updated_at = ? WHERE id = ?').run(nowIso(now), template.id);
  return stepsFor(template.id).find((s) => s.id === stepId) ?? null;
}

/**
 * Create queue items for a client from a template.
 *
 * Steps run in order, so each step's SLA clock starts when the previous
 * step's SLA window ends (start_at + the sum of earlier SLA hours). A step
 * with no SLA does not move the clock. Owner names come from `assignees` by
 * role; Jack's steps default to "Jack".
 */
export function instantiateDeliveryTemplate(
  templateId: string,
  input: InstantiateTemplateInput,
  now: number = Date.now(),
): { instance_id: string; items: DeliveryItem[] } {
  const template = getDeliveryTemplate(templateId);
  if (!template) throw new DeliveryError('not_found', `Template ${templateId} not found`);
  const client = input.client.trim();
  if (!client) throw new DeliveryError('invalid', 'client is required');

  const sections = input.sections && input.sections.length > 0 ? new Set(input.sections) : null;
  if (sections) {
    const unknown = [...sections].filter((s) => !template.sections.includes(s));
    if (unknown.length > 0) {
      throw new DeliveryError('invalid', `Unknown section(s) for this template: ${unknown.join(', ')}`);
    }
  }
  const steps = template.steps.filter((s) => !sections || s.section === null || sections.has(s.section));
  if (steps.length === 0) throw new DeliveryError('invalid', 'Template has no steps to create');

  const instanceId = newId();
  const venture = input.venture !== undefined ? input.venture : template.venture;
  let clock = input.start_at ? Date.parse(toIso(input.start_at, 'start_at')) : now;
  const created: DeliveryItem[] = [];

  getSqlite().transaction(() => {
    steps.forEach((step, i) => {
      const startedIso = new Date(clock).toISOString();
      const assignee = input.assignees?.[step.owner_role]?.trim();
      created.push(
        createDeliveryItem(
          {
            title: step.title,
            description: step.description,
            owner_type: step.owner_role,
            owner_name: assignee || (step.owner_role === 'jack' ? 'Jack' : null),
            client,
            venture: venture ?? null,
            deadline: input.deadline ?? null,
            sla_hours: step.sla_hours,
            sla_started_at: startedIso,
            template_id: template.id,
            template_step_id: step.id,
            instance_id: instanceId,
            position: i,
          },
          now,
        ),
      );
      if (step.sla_hours !== null) clock += step.sla_hours * HOUR_MS;
    });
  })();

  return { instance_id: instanceId, items: created };
}
