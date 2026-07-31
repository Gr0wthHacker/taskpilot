/**
 * Boot-task subsystem — fire user-defined Claude prompts once per day at
 * first launch, then route results back through the existing review queue
 * + trust threshold.
 *
 * A "boot task" is just a TaskPilot task seeded as `status='queued'` with
 * `agent_method='cli'` and the boot-task prompt as `agent_instructions`. The
 * existing auto-execute loop writes the io request, the claude-runner picks
 * it up, the result comes back through the standard ingestion path. High-
 * confidence results land `done`; lower-confidence ones land in `/review`.
 *
 * Templates are stored as a single JSON-encoded settings value
 * (`boot_tasks`). A successful firing updates `boot_tasks_last_run` to
 * today's local date so we don't re-fire on a same-day restart.
 *
 * Seeded with 3 safe defaults on first run (drain updates drafts, sweep
 * stalled tasks, refresh business snapshots). The user can edit, remove, or
 * extend via Settings.
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import { createTask } from '@/main/db/repositories/tasks';

export const SETTING_BOOT_TASKS = 'boot_tasks';
export const SETTING_BOOT_TASKS_LAST_RUN = 'boot_tasks_last_run';
export const SETTING_BOOT_TASKS_ENABLED = 'boot_tasks_enabled';

export interface BootTaskTemplate {
  /** Stable id for the template — used so the user can edit by reference. */
  id: string;
  /** Short human label, surfaced in Settings + reports. */
  label: string;
  /** The prompt Claude runs. Treated as `agent_instructions`. */
  prompt: string;
  /**
   * Confidence threshold ([0,1]). Results at or above this float skip the
   * review queue and land `done` directly. Results below land in `/review`
   * for human sign-off. Defaults to 0.8 when omitted.
   */
  confidence_threshold?: number;
  /**
   * Free-form tag added to the spawned task. Defaults to `boot-task`. The
   * runner uses this when scoping queries — e.g. "give me every boot-task
   * result from this morning."
   */
  tag?: string;
}

const DEFAULT_TEMPLATES: BootTaskTemplate[] = [
  {
    id: 'drain-updates-drafts',
    label: 'Drain pending update drafts',
    prompt:
      "Read every queue file in ~/.taskpilot/io/updates_drafts/ via taskpilot_list_update_drafts. " +
      "For each one, draft a finished entry in Jack's voice per the voice guide in the draft, " +
      "and publish via taskpilot_publish_update. Pick a slug from the draft headline (lowercase, hyphens). " +
      "After publishing, call taskpilot_resolve_update_draft to clear the queue file. " +
      "Set confidence high (>= 0.85) only when the prose hits the voice cleanly; otherwise leave below 0.75 so Jack reviews.",
    confidence_threshold: 0.85,
  },
  {
    id: 'sweep-stalled-tasks',
    label: 'Sweep stalled tasks',
    prompt:
      "List every open task (status: inbox/queued/blocked) whose updated_at is older than 14 days. " +
      "For each, recommend exactly one: kill, snooze-7d, or escalate. Apply via taskpilot_update_task. " +
      "Default to setting confidence ~0.6 — this is a judgment call and Jack should see most of them.",
    confidence_threshold: 0.7,
  },
  {
    id: 'refresh-business-snapshots',
    label: 'Refresh business snapshots',
    prompt:
      "For each business in projects.json, call taskpilot_business_status with format=json to refresh STATUS.md. " +
      "Then list any business whose last_touched_at is older than 7 days. " +
      "This is purely read-side bookkeeping — set confidence high (>= 0.9).",
    confidence_threshold: 0.9,
  },
  {
    id: 'postmortem-yesterday',
    label: 'Post-mortem on yesterday',
    prompt:
      "Read yesterday's conversations rollup via taskpilot_conversations_rollup days=1. " +
      "For each task that landed `done` yesterday, summarize in one line: what shipped, what was hard, what to do differently. " +
      "For tasks that landed `failed` or moved to `needs_review`, name the root cause. " +
      "Roll up into a journal entry on the post-mortem template: 3 bullets — 'what worked', 'what stalled', 'one thing to change today'. " +
      "Confidence ~0.7 — most of these should land in review so Jack can react.",
    confidence_threshold: 0.7,
  },
];

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = settingsRepository.get(key);
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'string') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
    }
    if (typeof raw === 'number') return raw !== 0;
    return fallback;
  } catch {
    return fallback;
  }
}

function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Read the templates stored in settings. Returns [] when none configured. */
export function readBootTasks(): BootTaskTemplate[] {
  try {
    const raw = settingsRepository.get(SETTING_BOOT_TASKS);
    if (typeof raw === 'string' && raw.length > 0) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isValidTemplate);
    }
    if (Array.isArray(raw)) return (raw as unknown[]).filter(isValidTemplate);
    return [];
  } catch {
    return [];
  }
}

function isValidTemplate(v: unknown): v is BootTaskTemplate {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.label === 'string' &&
    typeof o.prompt === 'string'
  );
}

/** Persist a new templates list. */
export function writeBootTasks(templates: BootTaskTemplate[]): void {
  settingsRepository.set(SETTING_BOOT_TASKS, JSON.stringify(templates));
}

/**
 * Seed the default templates if no boot tasks are configured. Idempotent —
 * a second call with templates already present is a no-op.
 */
export function seedDefaultBootTasksIfEmpty(): BootTaskTemplate[] {
  const current = readBootTasks();
  if (current.length > 0) return current;
  writeBootTasks(DEFAULT_TEMPLATES);
  return DEFAULT_TEMPLATES;
}

/** True when today's boot tasks haven't been fired yet. */
export function isBootTasksDue(): boolean {
  try {
    const raw = settingsRepository.get(SETTING_BOOT_TASKS_LAST_RUN);
    if (typeof raw !== 'string') return true;
    return raw !== todayLocalDate();
  } catch {
    return true;
  }
}

export interface FireBootTasksResult {
  fired: number;
  skipped_reason: 'disabled' | 'not_due' | null;
  task_ids: string[];
}

/**
 * Fire boot tasks if due AND enabled (default ON). Returns a summary so
 * callers can log/display what happened. Errors creating individual tasks
 * are swallowed; we still mark "today" as done so a broken template doesn't
 * cause infinite reruns on restart.
 */
export function fireBootTasksIfDue(): FireBootTasksResult {
  if (!readBool(SETTING_BOOT_TASKS_ENABLED, true)) {
    return { fired: 0, skipped_reason: 'disabled', task_ids: [] };
  }
  if (!isBootTasksDue()) {
    return { fired: 0, skipped_reason: 'not_due', task_ids: [] };
  }
  const templates = seedDefaultBootTasksIfEmpty();
  const taskIds: string[] = [];
  for (const t of templates) {
    try {
      const task = createTask({
        title: t.label,
        description: `Auto-fired boot task (template id: \`${t.id}\`).`,
        status: 'queued',
        priority: 'p2',
        agent_executable: true,
        agent_method: 'cli',
        agent_instructions: t.prompt,
        tags: [t.tag ?? 'boot-task'],
        context: {
          boot_task: true,
          boot_task_template_id: t.id,
          confidence_threshold: t.confidence_threshold ?? 0.8,
        },
      });
      taskIds.push(task.id);
    } catch {
      /* skip — template error shouldn't block the rest */
    }
  }
  settingsRepository.set(SETTING_BOOT_TASKS_LAST_RUN, todayLocalDate());
  return { fired: taskIds.length, skipped_reason: null, task_ids: taskIds };
}
