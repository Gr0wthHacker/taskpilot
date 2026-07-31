/**
 * Status-report scheduler (Wave 16E).
 *
 * A tiny cron-like scheduler built on `setInterval` — no new dependency. It
 * ticks once a minute, reads the persisted schedule from settings, and fires
 * the report generator + publisher when the current minute matches the cron
 * expression AND we haven't already fired for that minute.
 *
 * Cron support is the standard 5-field subset:
 *
 *     ┌── minute (0-59)
 *     │ ┌── hour (0-23)
 *     │ │ ┌── day of month (1-31)
 *     │ │ │ ┌── month (1-12)
 *     │ │ │ │ ┌── day of week (0-6, Sunday=0)
 *     * * * * *
 *
 * Each field accepts: `*`, a single number, a comma list (`1,15,30`), a step
 * (`*​/15` or `0-30/5`), and a range (`9-17`). That covers every realistic
 * schedule a single-user task manager needs ("Mondays 8am" = `0 8 * * 1`).
 *
 * The schedule lives in three settings keys:
 *   - `status_report_enabled` (boolean, default false)
 *   - `status_report_cron` (string, default `0 8 * * 1`)
 *   - `status_report_destinations` (JSON array of destinations)
 *
 * Tests / standalone callers can drive the tick manually via `tick(now)`.
 */

import { settingsRepository } from '@/main/db/repositories/settings';
import type { StatusReportDestination } from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Settings keys + defaults                                                   */
/* -------------------------------------------------------------------------- */

export const SETTING_ENABLED = 'status_report_enabled';
export const SETTING_CRON = 'status_report_cron';
export const SETTING_DESTINATIONS = 'status_report_destinations';
export const SETTING_LAST_RUN = 'status_report_last_run_at';

export const DEFAULT_CRON = '0 8 * * 1'; // Mondays 08:00 local time

const VALID_DESTINATIONS: readonly StatusReportDestination[] = [
  'slack',
  'notion',
  'gmail',
  'disk',
];

/* -------------------------------------------------------------------------- */
/*  Cron parsing + matching                                                    */
/* -------------------------------------------------------------------------- */

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/**
 * Parse a single cron field into the set of values it matches. Throws on a
 * malformed field so `parseCron` can reject the whole expression.
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const stepRaw = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? Number.parseInt(stepMatch[2]!, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`invalid step in cron field "${field}"`);
    }

    let lo: number;
    let hi: number;
    if (stepRaw === '*') {
      lo = min;
      hi = max;
    } else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(stepRaw);
      if (rangeMatch) {
        lo = Number.parseInt(rangeMatch[1]!, 10);
        hi = Number.parseInt(rangeMatch[2]!, 10);
      } else {
        const single = Number.parseInt(stepRaw, 10);
        if (!Number.isFinite(single)) {
          throw new Error(`invalid value "${stepRaw}" in cron field`);
        }
        lo = single;
        hi = single;
      }
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field out of range: "${part}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error('cron field matched nothing');
  return out;
}

/**
 * Parse a 5-field cron expression. Returns `null` for anything malformed —
 * callers treat a null parse as "never fires" rather than crashing the tick.
 */
export function parseCron(expr: string): ParsedCron | null {
  if (typeof expr !== 'string') return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  try {
    return {
      minute: parseField(fields[0]!, 0, 59),
      hour: parseField(fields[1]!, 0, 23),
      dayOfMonth: parseField(fields[2]!, 1, 31),
      month: parseField(fields[3]!, 1, 12),
      dayOfWeek: parseField(fields[4]!, 0, 6),
    };
  } catch {
    return null;
  }
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/**
 * Does the cron expression fire at the given local time? Day-of-month and
 * day-of-week use cron's traditional OR semantics: when BOTH are restricted
 * (neither is `*`-equivalent), the rule fires if EITHER matches. When one is
 * unrestricted, only the other gates the day.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay(); // 0=Sunday

  if (!parsed.minute.has(minute)) return false;
  if (!parsed.hour.has(hour)) return false;
  if (!parsed.month.has(month)) return false;

  const domRestricted = parsed.dayOfMonth.size < 31;
  const dowRestricted = parsed.dayOfWeek.size < 7;
  const domHit = parsed.dayOfMonth.has(dom);
  const dowHit = parsed.dayOfWeek.has(dow);

  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true; // both unrestricted
}

/** Minute bucket key `YYYY-MM-DDTHH:MM` (local) used for de-duping fires. */
function minuteKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/* -------------------------------------------------------------------------- */
/*  Schedule reading                                                           */
/* -------------------------------------------------------------------------- */

export interface ScheduleConfig {
  enabled: boolean;
  cron: string;
  destinations: StatusReportDestination[];
  last_run_at: string | null;
}

function sanitizeDestinations(raw: unknown): StatusReportDestination[] {
  if (!Array.isArray(raw)) return [];
  const out: StatusReportDestination[] = [];
  for (const v of raw) {
    if (
      typeof v === 'string' &&
      (VALID_DESTINATIONS as readonly string[]).includes(v) &&
      !out.includes(v as StatusReportDestination)
    ) {
      out.push(v as StatusReportDestination);
    }
  }
  return out;
}

/** Read the current schedule from settings, applying defaults. */
export function readSchedule(): ScheduleConfig {
  const enabled = settingsRepository.get<boolean>(SETTING_ENABLED) === true;
  const cronRaw = settingsRepository.get<string>(SETTING_CRON);
  const cron = typeof cronRaw === 'string' && cronRaw.trim().length > 0
    ? cronRaw
    : DEFAULT_CRON;
  const destinations = sanitizeDestinations(
    settingsRepository.get<unknown>(SETTING_DESTINATIONS),
  );
  const lastRunRaw = settingsRepository.get<string>(SETTING_LAST_RUN);
  return {
    enabled,
    cron,
    destinations,
    last_run_at: typeof lastRunRaw === 'string' ? lastRunRaw : null,
  };
}

/** Persist a partial schedule update. Validates the cron before writing. */
export function writeSchedule(patch: {
  enabled?: boolean;
  cron?: string;
  destinations?: StatusReportDestination[];
}): ScheduleConfig {
  if (patch.enabled !== undefined) {
    settingsRepository.set(SETTING_ENABLED, patch.enabled === true);
  }
  if (patch.cron !== undefined) {
    if (!isValidCron(patch.cron)) {
      throw new Error(`invalid cron expression: "${patch.cron}"`);
    }
    settingsRepository.set(SETTING_CRON, patch.cron);
  }
  if (patch.destinations !== undefined) {
    settingsRepository.set(
      SETTING_DESTINATIONS,
      sanitizeDestinations(patch.destinations),
    );
  }
  return readSchedule();
}

/* -------------------------------------------------------------------------- */
/*  Scheduler loop                                                             */
/* -------------------------------------------------------------------------- */

export interface SchedulerHandle {
  stop: () => void;
  /** Run a single evaluation against `now`. Returns true when it fired. */
  tick: (now?: Date) => Promise<boolean>;
  isRunning: () => boolean;
}

const TICK_INTERVAL_MS = 60 * 1000; // one minute

/**
 * The fire callback. Default wiring generates a report and publishes it to the
 * configured destinations; tests inject a stub so they don't write files or
 * hit integrations.
 */
export type FireFn = (config: ScheduleConfig) => Promise<void>;

async function defaultFire(config: ScheduleConfig): Promise<void> {
  const [{ generateStatusReport }, { publishReport }] = await Promise.all([
    import('./status-report'),
    import('./report-publish'),
  ]);
  const report = await generateStatusReport({ window: '7d' });
  await publishReport(report, config.destinations);
}

export interface StartSchedulerOptions {
  /** Override the fire behaviour (tests). */
  fire?: FireFn;
  /** Skip the immediate boot tick. Default true (don't fire on boot). */
  skipInitialTick?: boolean;
}

/**
 * Start the minute-tick scheduler. Booting is cheap and side-effect-free until
 * the minute matches an enabled schedule, so the server boots this
 * unconditionally (mirroring the Slack/Notion capture loops).
 */
export function startScheduler(
  options: StartSchedulerOptions = {},
): SchedulerHandle {
  const fire = options.fire ?? defaultFire;
  let lastFiredMinute: string | null = null;
  let running = true;

  const tick = async (now: Date = new Date()): Promise<boolean> => {
    if (!running) return false;
    let config: ScheduleConfig;
    try {
      config = readSchedule();
    } catch {
      return false;
    }
    if (!config.enabled) return false;
    const parsed = parseCron(config.cron);
    if (!parsed) return false;
    if (!cronMatches(parsed, now)) return false;

    const key = minuteKey(now);
    if (lastFiredMinute === key) return false; // already fired this minute
    lastFiredMinute = key;

    try {
      await fire(config);
      try {
        settingsRepository.set(SETTING_LAST_RUN, now.toISOString());
      } catch {
        /* non-fatal */
      }
      return true;
    } catch (err) {
      // A failed fire shouldn't wedge the loop — log and move on. The minute
      // key is already set, so we won't retry-storm within the same minute.
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:status-report] scheduled fire failed:',
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  // Don't keep the Node process alive solely for this timer.
  if (typeof interval.unref === 'function') interval.unref();

  if (options.skipInitialTick === false) {
    void tick();
  }

  return {
    stop: (): void => {
      running = false;
      clearInterval(interval);
    },
    tick,
    isRunning: (): boolean => running,
  };
}

/* -------------------------------------------------------------------------- */
/*  Internal exports (tests)                                                   */
/* -------------------------------------------------------------------------- */

export const __internals = {
  parseField,
  minuteKey,
  sanitizeDestinations,
  TICK_INTERVAL_MS,
};
