/**
 * Recurring-schedules tick loop.
 *
 * Mirrors `@/main/reports/report-scheduler` shape: minute-tick interval, can
 * be driven manually by tests via `handle.tick(now)`, unconditionally booted
 * (cheap until a schedule is enabled + due). Tests opt out via
 * `TASKPILOT_DISABLE_SCHEDULES=1`.
 *
 * Each tick:
 *   1. Reads every enabled schedule whose `next_fire_at <= now`.
 *   2. Fires each one (creates fan-out children + advances `next_fire_at`).
 *   3. Logs successes / failures via electron-log (best-effort; never throws).
 *
 * The fire happens synchronously within the tick — the create-task work is
 * fast (single sqlite insert per child, no network), and a per-tick fire
 * batch of even a few hundred tasks completes in well under a second.
 */

import { fireSchedule, listDueSchedules, type FireResult } from './index';

const TICK_INTERVAL_MS = 60 * 1000;

export interface SchedulesSchedulerHandle {
  stop: () => void;
  /** Run a single evaluation against `now`. Returns the fires it performed. */
  tick: (now?: Date) => Promise<FireResult[]>;
  isRunning: () => boolean;
}

export interface StartSchedulesSchedulerOptions {
  /** Override the per-fire callback (tests). Default: `fireSchedule`. */
  fire?: (scheduleId: string, now: Date) => Promise<FireResult> | FireResult;
  /** Skip the immediate boot tick. Default true. */
  skipInitialTick?: boolean;
}

export function startSchedulesScheduler(
  options: StartSchedulesSchedulerOptions = {},
): SchedulesSchedulerHandle {
  const fire =
    options.fire ?? ((id: string, now: Date) => fireSchedule(id, now));
  let running = true;

  const tick = async (now: Date = new Date()): Promise<FireResult[]> => {
    if (!running) return [];
    let due;
    try {
      due = listDueSchedules(now);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:schedules] listDueSchedules failed:',
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
    if (due.length === 0) return [];

    const fired: FireResult[] = [];
    for (const schedule of due) {
      try {
        const result = await fire(schedule.id, now);
        fired.push(result);
        // eslint-disable-next-line no-console
        console.log(
          `[taskpilot:schedules] fired ${schedule.name} (${schedule.id}): ` +
            `${result.created_task_ids.length}/${result.expected_count} tasks, ` +
            `next at ${result.next_fire_at}`,
        );
      } catch (err) {
        // A single schedule's failure shouldn't wedge the loop or block the
        // other due schedules from firing this tick.
        // eslint-disable-next-line no-console
        console.log(
          `[taskpilot:schedules] fire failed for ${schedule.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return fired;
  };

  const interval = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
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
/*  Test exports                                                              */
/* -------------------------------------------------------------------------- */

export const __internals = {
  TICK_INTERVAL_MS,
};
