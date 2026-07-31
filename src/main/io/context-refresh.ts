import fs from 'node:fs/promises';
import path from 'node:path';

import { addDays, formatISO } from 'date-fns';

import { settingsRepository } from '@/main/db/repositories/settings';
import { tasksRepository } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

import { ioEvents } from './events';
import { contextPath, ensureIoDirs } from './paths';

/**
 * Interval (ms) between background context refreshes. The PRD spec calls for
 * a snapshot at boot and every 5 minutes thereafter.
 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Default values applied when no settings row exists yet. Mirrors what the
 * Settings view will surface to humans.
 */
// NOTE: these keys are surfaced to Claude in `preferences.json`. They MUST
// match the real setting names the server reads, with the real defaults —
// otherwise the snapshot lies to the agent. The trust-by-default flags below
// (`auto_derive_enabled`, `auto_approve_derivations`, `auto_approve_results`,
// `auto_execute_approved`) all default TRUE; the server checks these exact
// keys in routes/tasks.ts + io/ingestion.ts + auto-execute.ts.
const DEFAULT_PREFERENCES = {
  agent_hours: { start: '09:00', end: '18:00' },
  default_priority: 'p2',
  timezone: 'America/New_York',
  daily_plan_at: '08:30',
  auto_derive_enabled: true,
  auto_approve_derivations: true,
  auto_approve_results: true,
  auto_execute_approved: true,
  agent_paused: false,
  review_required_default: false,
  confidence_threshold: 0.7,
  // Ambient monitor (v6). All default OFF for privacy — the user has to opt in
  // explicitly in Settings. Mirrored everywhere these keys are read; bump in
  // lockstep with the settings module if defaults ever shift.
  ambient_monitor_enabled: false,
  ambient_screenshot_enabled: false,
  ambient_window_poll_interval_ms: 30_000,
  ambient_screenshot_interval_ms: 180_000,
  ambient_batch_size: 8,
  ambient_context_shift_threshold: 0.4,
  ambient_observation_retention_days: 14,
  ambient_extension_enabled: false,
  ambient_deliberation_quiet_hours: '',
  // Panic mode — when true, the monitor's window + screenshot ticks
  // short-circuit and the Watch view renders censored. Toggled via the
  // global hotkey (Ctrl+Shift+\), the tray menu, or POST /api/settings.
  // Default OFF; flipping it on is non-destructive (data is hidden, not
  // deleted — the dedicated wipe endpoint handles destruction).
  ambient_panic_mode: false,
} as const;

interface CalendarEventSnapshot {
  id: string;
  summary: string;
  start: string;
  end: string;
  calendar_id?: string;
  description?: string;
  attendees?: string[];
}

interface ProjectSummary {
  tag: string;
  in_progress: number;
  queued: number;
  done_last_7d: number;
  last_activity: string | null;
}

/**
 * Refresh every snapshot in `IO_CONTEXT/`. Safe to call concurrently — each
 * file is written atomically through a `.tmp` sibling.
 *
 * Failures in any individual snapshot are logged via {@link ioEvents} but
 * do not abort the rest of the refresh.
 */
export async function refreshContext(): Promise<void> {
  await ensureIoDirs();
  await Promise.all([
    safeWrite('calendar', writeCalendarSnapshot),
    safeWrite('projects', writeProjectsSnapshot),
    safeWrite('preferences', writePreferencesSnapshot),
  ]);
}

async function safeWrite(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err: unknown) {
    ioEvents.emit('io_error', {
      scope: 'watcher',
      message: `context-refresh: ${name} snapshot failed`,
      path: contextPath(name),
      error: err,
    });
  }
}

async function writeCalendarSnapshot(): Promise<void> {
  // Lazy import so the I/O layer doesn't pull in googleapis at boot time
  // and so the calendar module can be initialised after the I/O layer.
  let events: CalendarEventSnapshot[] = [];
  let note: string | undefined;

  try {
    const mod: unknown = await import('@/main/calendar/index');
    const fn = extractListEvents(mod);
    if (!fn) {
      note = 'calendar module loaded but does not export listEvents()';
    } else {
      const from = new Date();
      const to = addDays(from, 7);
      events = await fn(from, to);
    }
  } catch {
    note = 'calendar module not initialized';
  }

  const payload: { events: CalendarEventSnapshot[]; generated_at: string; note?: string } = {
    events,
    generated_at: new Date().toISOString(),
  };
  if (note !== undefined) payload.note = note;
  await writeJsonAtomic(contextPath('calendar'), payload);
}

function extractListEvents(
  mod: unknown,
): ((from: Date, to: Date) => Promise<CalendarEventSnapshot[]>) | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const record = mod as Record<string, unknown>;
  const candidate = record['listEvents'];
  if (typeof candidate === 'function') {
    return candidate as (from: Date, to: Date) => Promise<CalendarEventSnapshot[]>;
  }
  return null;
}

async function writeProjectsSnapshot(): Promise<void> {
  const all = await tasksRepository.list({});
  const sevenDaysAgo = addDays(new Date(), -7);

  const byTag = new Map<string, ProjectSummary>();
  for (const task of all) {
    for (const tag of task.tags) {
      const summary = byTag.get(tag) ?? {
        tag,
        in_progress: 0,
        queued: 0,
        done_last_7d: 0,
        last_activity: null,
      };
      if (task.status === 'in_progress') summary.in_progress += 1;
      if (task.status === 'queued') summary.queued += 1;
      if (task.status === 'done' && new Date(task.updated_at) >= sevenDaysAgo) {
        summary.done_last_7d += 1;
      }
      if (
        summary.last_activity === null ||
        task.updated_at > summary.last_activity
      ) {
        summary.last_activity = task.updated_at;
      }
      byTag.set(tag, summary);
    }
  }

  const projects = Array.from(byTag.values()).sort((a, b) => {
    if (a.last_activity === b.last_activity) return a.tag.localeCompare(b.tag);
    if (a.last_activity === null) return 1;
    if (b.last_activity === null) return -1;
    return a.last_activity < b.last_activity ? 1 : -1;
  });

  const recentTasks = all
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 25)
    .map((t: Task) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      tags: t.tags,
      updated_at: t.updated_at,
    }));

  await writeJsonAtomic(contextPath('projects'), {
    generated_at: formatISO(new Date()),
    projects,
    recent_tasks: recentTasks,
  });
}

async function writePreferencesSnapshot(): Promise<void> {
  let stored: Record<string, unknown> = {};
  try {
    stored = settingsRepository.getAll() as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const merged = { ...DEFAULT_PREFERENCES, ...stored };
  await writeJsonAtomic(contextPath('preferences'), {
    generated_at: new Date().toISOString(),
    ...merged,
  });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Kick off background refreshes. Returns a stop function that clears the
 * interval. Safe to call from `main.ts` startup.
 */
export function startContextRefresh(): () => void {
  // Fire once immediately, then on an interval. Don't block startup on the
  // first refresh.
  void refreshContext();

  const handle = setInterval(() => {
    void refreshContext();
  }, REFRESH_INTERVAL_MS);

  // Refresh whenever the pipeline changes so projects.json stays fresh as
  // tasks move between statuses.
  const onChange = (): void => {
    void refreshContext();
  };
  ioEvents.on('pipeline_changed', onChange);

  return () => {
    clearInterval(handle);
    ioEvents.off('pipeline_changed', onChange);
  };
}
