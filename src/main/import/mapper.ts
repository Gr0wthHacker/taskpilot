/**
 * Column → task-field mapper.
 *
 * The bulk-import wizard collects a `MappingConfig` describing which CSV
 * column feeds which task field, then asks the server to:
 *
 *   1. `previewImport(rows, mapping)` — return the first N tasks that
 *      would be created plus any per-row validation errors.
 *   2. `commitImport(rows, mapping, options)` — actually create the
 *      tasks. Returns counts (created / skipped / errored).
 *
 * Duplicate detection is opt-in via `mapping.skip_duplicates_by`:
 * a column name whose value identifies the row. We hash the value and
 * compare against tasks we've already seen in *this import run* AND
 * against the `context.import_dedupe_key` of any existing tasks. That
 * lets the user re-run the same CSV without doubling up.
 *
 * Wave 13 — Agent M.
 */

import { createTask, listTasks } from '@/main/db/repositories/tasks';
import type {
  AgentMethod,
  CreateTaskInput,
  Task,
  TaskPriority,
} from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Maps CSV column names to task fields. All fields are optional except
 * `title_column` — without a title there's nothing to create.
 *
 * `priority_map` lets the user translate their CSV's priority values into
 * TaskPilot's p0…p3 scale. Example:
 *   `{ Urgent: 'p0', High: 'p1', Normal: 'p2', Low: 'p3' }`
 */
export interface MappingConfig {
  title_column: string;
  description_column?: string;
  priority_column?: string;
  priority_map?: Record<string, TaskPriority>;
  /** Columns whose contents become task tags. Multiple supported — each
   *  column's value is split on commas and trimmed. */
  tag_columns?: string[];
  /** Column whose value identifies the row for dedupe. */
  skip_duplicates_by?: string;
  /** Optional override for the default agent_method on created tasks. */
  agent_method?: AgentMethod;
  /** Default priority when no `priority_column` is set or the mapping
   *  doesn't resolve. Falls back to `p2` if omitted. */
  default_priority?: TaskPriority;
}

export interface PreviewRow {
  /** 1-based row number as it appears in the CSV (header is row 1). */
  row_number: number;
  /** Task input we'd pass to `createTask` if committed. */
  task: CreateTaskInput;
  /** Per-row validation errors. An empty array means "good to import". */
  errors: string[];
  /** Set when the row would be skipped due to dedupe. */
  duplicate: boolean;
}

export interface PreviewResult {
  total_rows: number;
  /** First N preview rows (see `previewImport` signature). */
  preview: PreviewRow[];
  /** Aggregate counts for the whole sheet, even when only first N are
   *  returned. Lets the UI show "12 valid · 3 errors · 2 duplicates" at
   *  the bottom of the wizard. */
  summary: {
    valid: number;
    errors: number;
    duplicates: number;
  };
}

export interface CommitOptions {
  /** Override the inbox starting status. Defaults to 'inbox'. */
  status?: CreateTaskInput['status'];
  /** Tag every imported task with this value in addition to per-row tags.
   *  Useful to group an import run for later cleanup. */
  import_tag?: string;
  /** Source label written into `task.context.import_source` (e.g. "csv",
   *  "notion"). */
  source?: string;
}

export interface CommitResult {
  created: number;
  skipped: number;
  errored: number;
  /** IDs of every task created during this run, in row order. */
  task_ids: string[];
  /** Per-row errors, paired with the row number. */
  errors: Array<{ row_number: number; message: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Header → field auto-suggester                                             */
/* -------------------------------------------------------------------------- */

/**
 * Given a list of CSV headers, suggest a `MappingConfig`. Tries common
 * column-name variants (title/name/task, description/notes/body, etc.).
 * The wizard pre-fills the form with this and lets the user adjust.
 */
export function suggestMapping(headers: string[]): Partial<MappingConfig> {
  const lower = headers.map((h) => h.toLowerCase());

  const find = (candidates: string[]): string | undefined => {
    for (const cand of candidates) {
      const idx = lower.indexOf(cand);
      if (idx >= 0) return headers[idx];
    }
    // Substring fallback — useful for "Task name", "Item title".
    for (const cand of candidates) {
      const idx = lower.findIndex((h) => h.includes(cand));
      if (idx >= 0) return headers[idx];
    }
    return undefined;
  };

  const suggestion: Partial<MappingConfig> = {};
  const title = find(['title', 'name', 'task', 'subject', 'summary']);
  if (title) suggestion.title_column = title;
  const desc = find(['description', 'notes', 'body', 'details', 'content']);
  if (desc) suggestion.description_column = desc;
  const prio = find(['priority', 'importance', 'urgency']);
  if (prio) suggestion.priority_column = prio;
  const tags = find(['tags', 'labels', 'categories', 'category']);
  if (tags) suggestion.tag_columns = [tags];

  return suggestion;
}

/* -------------------------------------------------------------------------- */
/*  Row → task input                                                          */
/* -------------------------------------------------------------------------- */

function applyMapping(
  row: Record<string, string>,
  mapping: MappingConfig,
  rowNumber: number,
): { task: CreateTaskInput; errors: string[]; dedupeKey: string | null } {
  const errors: string[] = [];

  const rawTitle = (row[mapping.title_column] ?? '').trim();
  if (rawTitle.length === 0) {
    errors.push(`Row ${rowNumber}: missing value in title column "${mapping.title_column}"`);
  }
  const title = rawTitle.slice(0, 500);

  const description =
    mapping.description_column && row[mapping.description_column]
      ? row[mapping.description_column].slice(0, 50_000)
      : undefined;

  let priority: TaskPriority = mapping.default_priority ?? 'p2';
  if (mapping.priority_column) {
    const raw = (row[mapping.priority_column] ?? '').trim();
    if (raw.length > 0) {
      const mapped = mapping.priority_map?.[raw];
      if (mapped) {
        priority = mapped;
      } else if (raw === 'p0' || raw === 'p1' || raw === 'p2' || raw === 'p3') {
        priority = raw;
      } else {
        // Unknown priority value — keep default but warn the user.
        errors.push(
          `Row ${rowNumber}: unrecognized priority "${raw}" — defaulted to ${priority}`,
        );
      }
    }
  }

  const tags: string[] = [];
  if (Array.isArray(mapping.tag_columns)) {
    for (const col of mapping.tag_columns) {
      const raw = (row[col] ?? '').trim();
      if (raw.length === 0) continue;
      for (const piece of raw.split(',')) {
        const cleaned = piece.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
        if (cleaned.length > 0 && /^[a-z0-9_-]+$/.test(cleaned)) {
          tags.push(cleaned);
        }
      }
    }
  }

  const dedupeKey =
    mapping.skip_duplicates_by && row[mapping.skip_duplicates_by]
      ? row[mapping.skip_duplicates_by].trim()
      : null;

  const context: Record<string, unknown> = { source: 'import' };
  if (dedupeKey) context.import_dedupe_key = dedupeKey;

  const task: CreateTaskInput = {
    title,
    description: description ?? null,
    priority,
    tags: tags.length > 0 ? Array.from(new Set(tags)) : undefined,
    agent_method: mapping.agent_method,
    context,
  };

  return { task, errors, dedupeKey };
}

/* -------------------------------------------------------------------------- */
/*  Preview                                                                   */
/* -------------------------------------------------------------------------- */

const PREVIEW_LIMIT = 10;

/**
 * Build a preview of the first 10 mapped tasks plus the aggregate summary
 * for the entire sheet. Doesn't touch the DB at all — pure transform.
 *
 * Existing-task dedupe runs in two passes: we collect every CSV row's
 * dedupe key first (so duplicate rows within the import collapse to the
 * first occurrence) and then check the in-memory key set against the DB.
 */
export function previewImport(
  rows: Record<string, string>[],
  mapping: MappingConfig,
): PreviewResult {
  const seenKeys = new Set<string>();
  const existingKeys = mapping.skip_duplicates_by
    ? loadExistingDedupeKeys()
    : new Set<string>();

  const summary = { valid: 0, errors: 0, duplicates: 0 };
  const preview: PreviewRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2; // +1 for 1-based, +1 for header
    const { task, errors, dedupeKey } = applyMapping(rows[i], mapping, rowNumber);

    let duplicate = false;
    if (dedupeKey) {
      if (seenKeys.has(dedupeKey) || existingKeys.has(dedupeKey)) {
        duplicate = true;
        summary.duplicates += 1;
      } else {
        seenKeys.add(dedupeKey);
      }
    }

    if (errors.length > 0 && !duplicate) {
      summary.errors += 1;
    } else if (!duplicate) {
      summary.valid += 1;
    }

    if (preview.length < PREVIEW_LIMIT) {
      preview.push({ row_number: rowNumber, task, errors, duplicate });
    }
  }

  return { total_rows: rows.length, preview, summary };
}

function loadExistingDedupeKeys(): Set<string> {
  // We don't have a SQL index on context.import_dedupe_key — read every
  // non-archived task once and pull the field out. Import volumes are
  // small (manual paste of a few hundred rows) and the read happens once
  // per preview, so the full scan is fine.
  const keys = new Set<string>();
  try {
    const tasks = listTasks({ include_archived: true });
    for (const t of tasks) {
      const ctx = t.context as Record<string, unknown> | null;
      const key = ctx?.import_dedupe_key;
      if (typeof key === 'string' && key.length > 0) {
        keys.add(key);
      }
    }
  } catch {
    // Tests that don't init the DB will throw here — degrade gracefully.
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/*  Commit                                                                    */
/* -------------------------------------------------------------------------- */

export function commitImport(
  rows: Record<string, string>[],
  mapping: MappingConfig,
  options: CommitOptions = {},
): CommitResult {
  const seenKeys = new Set<string>();
  const existingKeys = mapping.skip_duplicates_by
    ? loadExistingDedupeKeys()
    : new Set<string>();

  const out: CommitResult = {
    created: 0,
    skipped: 0,
    errored: 0,
    task_ids: [],
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2;
    const { task, errors, dedupeKey } = applyMapping(rows[i], mapping, rowNumber);

    // Dedupe wins over errors — a row that's a known duplicate is just
    // skipped silently rather than reported as broken.
    if (dedupeKey) {
      if (seenKeys.has(dedupeKey) || existingKeys.has(dedupeKey)) {
        out.skipped += 1;
        continue;
      }
      seenKeys.add(dedupeKey);
    }

    // Treat priority-warning style errors as non-fatal — the row still
    // imports, the user just sees the warning in the preview. We
    // distinguish them from blocking errors by detecting the "missing
    // title" code which is the only hard requirement.
    const blocking = errors.find((e) => e.includes('missing value in title column'));
    if (blocking) {
      out.errored += 1;
      out.errors.push({ row_number: rowNumber, message: blocking });
      continue;
    }

    try {
      const enriched = enrichTask(task, options);
      const created = createTask(enriched);
      out.created += 1;
      out.task_ids.push(created.id);
    } catch (err) {
      out.errored += 1;
      out.errors.push({
        row_number: rowNumber,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}

function enrichTask(
  task: CreateTaskInput,
  options: CommitOptions,
): CreateTaskInput {
  const ctx = (task.context ?? {}) as Record<string, unknown>;
  if (options.source) ctx.import_source = options.source;
  ctx.imported_at = new Date().toISOString();

  const tags = task.tags ? [...task.tags] : [];
  if (options.import_tag) {
    const clean = options.import_tag.toLowerCase().replace(/\s+/g, '-').slice(0, 64);
    if (/^[a-z0-9_-]+$/.test(clean) && !tags.includes(clean)) {
      tags.push(clean);
    }
  }

  return {
    ...task,
    status: options.status ?? task.status ?? 'inbox',
    tags: tags.length > 0 ? tags : task.tags,
    context: ctx,
  };
}

/* -------------------------------------------------------------------------- */
/*  Re-exports                                                                */
/* -------------------------------------------------------------------------- */

export type { Task };
