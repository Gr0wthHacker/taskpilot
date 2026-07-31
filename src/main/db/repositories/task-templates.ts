/**
 * Task templates repository.
 *
 * Templates are reusable task blueprints. Materializing a template inserts a
 * fresh row into `tasks` — the template itself remains untouched and the new
 * task is fully independent (deleting a template does NOT cascade to tasks
 * that were spawned from it).
 *
 * Like the tasks repo, this module owns the (de)serialization boundary for
 * the JSON-encoded `tags` and `context` columns.
 */

import { asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { taskTemplates, type TaskTemplateRow } from '../../../shared/schema.js';
import type {
  CreateTaskTemplateInput,
  MaterializeTemplateOverrides,
  Task,
  TaskTemplate,
  UpdateTaskTemplateInput,
} from '../../../shared/types.js';

import { getDb } from '../index.js';
import { createTask } from './tasks.js';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return nanoid(12);
}

function serializeTags(tags: string[] | null | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return JSON.stringify(tags);
}

function parseTags(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function serializeContext(
  context: Record<string, unknown> | null | undefined,
): string | null {
  if (context === null || context === undefined) return null;
  return JSON.stringify(context);
}

function parseContext(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function rowToTemplate(row: TaskTemplateRow): TaskTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    task_title: row.task_title,
    task_description: row.task_description,
    priority: row.priority ?? null,
    agent_method: row.agent_method ?? null,
    agent_instructions: row.agent_instructions,
    tags: parseTags(row.tags),
    context: parseContext(row.context),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Replace every `{{key}}` token in `source` with `variables[key]` (or leave
 * it alone if no replacement exists). Whitespace around the key is
 * tolerated: `{{ key }}` and `{{key}}` both substitute.
 */
function substitute(
  source: string | null,
  variables: Record<string, string> | undefined,
): string | null {
  if (source === null) return null;
  if (!variables || Object.keys(variables).length === 0) return source;
  return source.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (match, key) => {
    const value = variables[key as string];
    return typeof value === 'string' ? value : match;
  });
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export function listTemplates(): TaskTemplate[] {
  const db = getDb();
  const rows = db
    .select()
    .from(taskTemplates)
    .orderBy(asc(taskTemplates.name))
    .all();
  return rows.map(rowToTemplate);
}

export function getTemplate(id: string): TaskTemplate | null {
  const db = getDb();
  const row = db
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.id, id))
    .get();
  return row ? rowToTemplate(row) : null;
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export function createTemplate(input: CreateTaskTemplateInput): TaskTemplate {
  const db = getDb();
  const now = nowIso();
  const id = input.id ?? newId();

  db.insert(taskTemplates)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      task_title: input.task_title,
      task_description: input.task_description ?? null,
      priority: input.priority ?? null,
      agent_method: input.agent_method ?? null,
      agent_instructions: input.agent_instructions ?? null,
      tags: serializeTags(input.tags),
      context: serializeContext(input.context),
      created_at: input.created_at ?? now,
      updated_at: input.updated_at ?? now,
    })
    .run();

  const created = getTemplate(id);
  if (!created) throw new Error(`Failed to create template ${id}`);
  return created;
}

export function updateTemplate(
  id: string,
  patch: UpdateTaskTemplateInput,
): TaskTemplate | null {
  const existing = getTemplate(id);
  if (!existing) return null;

  const db = getDb();
  const updates: Record<string, unknown> = { updated_at: nowIso() };

  if ('name' in patch && patch.name !== undefined) updates.name = patch.name;
  if ('description' in patch) updates.description = patch.description ?? null;
  if ('task_title' in patch && patch.task_title !== undefined) {
    updates.task_title = patch.task_title;
  }
  if ('task_description' in patch) {
    updates.task_description = patch.task_description ?? null;
  }
  if ('priority' in patch) updates.priority = patch.priority ?? null;
  if ('agent_method' in patch) updates.agent_method = patch.agent_method ?? null;
  if ('agent_instructions' in patch) {
    updates.agent_instructions = patch.agent_instructions ?? null;
  }
  if ('tags' in patch) updates.tags = serializeTags(patch.tags);
  if ('context' in patch) updates.context = serializeContext(patch.context);

  db.update(taskTemplates).set(updates).where(eq(taskTemplates.id, id)).run();
  return getTemplate(id);
}

export function deleteTemplate(id: string): boolean {
  const db = getDb();
  const result = db
    .delete(taskTemplates)
    .where(eq(taskTemplates.id, id))
    .run();
  return result.changes > 0;
}

/* -------------------------------------------------------------------------- */
/*  Materialize                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply the template's blueprint to a new task. Returns null if no template
 * exists with `templateId`. Overrides win over template fields; variables run
 * against the final (override-or-template) title/description.
 */
export function materializeTemplate(
  templateId: string,
  overrides: MaterializeTemplateOverrides = {},
): Task | null {
  const template = getTemplate(templateId);
  if (!template) return null;

  const variables = overrides.variables;
  const titleSource = overrides.title ?? template.task_title;
  const descSource =
    overrides.description !== undefined
      ? overrides.description
      : template.task_description;

  const title = substitute(titleSource, variables) ?? titleSource;
  const description = substitute(descSource, variables);

  const priority = overrides.priority ?? template.priority ?? 'p2';
  const agent_method = overrides.agent_method ?? template.agent_method ?? 'human_only';
  const agent_executable = agent_method !== 'human_only';
  const tags = overrides.tags ?? template.tags;
  const context =
    overrides.context !== undefined ? overrides.context : template.context;

  return createTask({
    title,
    description: description ?? null,
    priority,
    due: overrides.due ?? null,
    tags,
    agent_method,
    agent_executable,
    agent_instructions:
      overrides.agent_instructions !== undefined
        ? overrides.agent_instructions
        : template.agent_instructions,
    context,
  });
}

/* -------------------------------------------------------------------------- */
/*  Namespace export                                                          */
/* -------------------------------------------------------------------------- */

export const taskTemplatesRepository = {
  list: listTemplates,
  get: getTemplate,
  findById: getTemplate,
  create: createTemplate,
  update: updateTemplate,
  delete: deleteTemplate,
  materialize: materializeTemplate,
};

export const __testing = { substitute };
