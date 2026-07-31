/**
 * Smart scheduler: given a batch of agent-executable tasks, propose a calendar
 * slotting plan that fills the earliest available windows without conflicts.
 *
 * Strategy (v1, greedy):
 *   1. Sort tasks by (priority asc, due asc, created_at asc) — most urgent first.
 *   2. Pull availability for the next 14 days at 15-minute granularity.
 *   3. For each task, pick the earliest free slot >= its estimated duration.
 *   4. Mark that slot as consumed so subsequent tasks don't overlap it.
 *
 * Returns just the proposal — actual calendar event creation is left to the
 * caller (typically the Daily Plan view or `taskpilot cal free`).
 */

import type { Task, TaskPriority } from '@/shared/types';

import { getAvailability, type AvailabilitySlot } from './availability';

/* -------------------------------------------------------------------------- */
/*  Public shapes                                                             */
/* -------------------------------------------------------------------------- */

export interface ScheduleProposal {
  task_id: string;
  start: string; // ISO 8601
  end: string;   // ISO 8601
}

export interface ProposeScheduleOptions {
  /** Lookahead window in days. Default 14. */
  horizonDays?: number;
  /** Starting point for the search. Default `new Date()`. */
  from?: Date;
  /** Per-task fallback duration if no estimate is available. Default 30. */
  defaultMinutes?: number;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

const ABSOLUTE_MAX_HORIZON_DAYS = 60;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Extract estimated_minutes from a task's context blob if present. The
 * derivation step stores this under `context.estimated_minutes`.
 */
function estimatedMinutes(task: Task, fallback: number): number {
  const ctx = task.context;
  if (ctx && typeof ctx === 'object') {
    const raw = (ctx as Record<string, unknown>)['estimated_minutes'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.ceil(raw);
    }
  }
  return fallback;
}

function compareTasks(a: Task, b: Task): number {
  const pa = PRIORITY_ORDER[a.priority] ?? 9;
  const pb = PRIORITY_ORDER[b.priority] ?? 9;
  if (pa !== pb) return pa - pb;

  const da = a.due ?? '￿'; // tasks without due dates sort last
  const db = b.due ?? '￿';
  if (da !== db) return da < db ? -1 : 1;

  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * Carve a `minutes`-long block off the front of a slot. Returns the remainder
 * if any (or null if the slot is exhausted) plus the assigned range.
 */
function consume(
  slot: AvailabilitySlot,
  minutes: number,
): { assigned: { start: string; end: string }; remainder: AvailabilitySlot | null } {
  const startMs = new Date(slot.start).getTime();
  const endMs = new Date(slot.end).getTime();
  const blockMs = minutes * 60 * 1_000;
  const blockEnd = startMs + blockMs;

  const assigned = {
    start: new Date(startMs).toISOString(),
    end: new Date(blockEnd).toISOString(),
  };

  if (blockEnd >= endMs) {
    return { assigned, remainder: null };
  }

  return {
    assigned,
    remainder: { start: new Date(blockEnd).toISOString(), end: slot.end },
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Propose calendar slots for a batch of tasks. Slots are returned in the same
 * order as the input array (NOT in scheduled order) so the caller can map back
 * easily. Tasks that could not be scheduled within the horizon are omitted.
 */
export async function proposeSchedule(
  tasks: Task[],
  options: ProposeScheduleOptions = {},
): Promise<ScheduleProposal[]> {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  const defaultMinutes = options.defaultMinutes ?? 30;
  const horizonDays = Math.min(
    options.horizonDays ?? 14,
    ABSOLUTE_MAX_HORIZON_DAYS,
  );
  const from = options.from ?? new Date();
  const to = new Date(from);
  to.setDate(to.getDate() + horizonDays);

  // Determine the longest task so we know the minimum slot we need to query.
  let minSlotMinutes = defaultMinutes;
  for (const task of tasks) {
    const m = estimatedMinutes(task, defaultMinutes);
    if (m < minSlotMinutes) minSlotMinutes = m;
  }
  // Ask for slots at least as long as the smallest task; we'll re-check per task.
  const slots = await getAvailability(from, to, Math.max(1, minSlotMinutes));

  // Sort tasks by urgency. Schedule into slots in time order.
  const queue = tasks.slice().sort(compareTasks);
  const pool: AvailabilitySlot[] = slots.slice();

  // Index proposals by task id for stable lookup.
  const assignments = new Map<string, ScheduleProposal>();

  for (const task of queue) {
    const minutes = estimatedMinutes(task, defaultMinutes);
    const blockMs = minutes * 60 * 1_000;

    let pickedIndex = -1;
    for (let i = 0; i < pool.length; i += 1) {
      const slot = pool[i];
      if (!slot) continue;
      const span = new Date(slot.end).getTime() - new Date(slot.start).getTime();
      if (span >= blockMs) {
        pickedIndex = i;
        break;
      }
    }

    if (pickedIndex === -1) continue; // no fit within horizon

    const slot = pool[pickedIndex];
    if (!slot) continue;
    const { assigned, remainder } = consume(slot, minutes);
    if (remainder) {
      pool[pickedIndex] = remainder;
    } else {
      pool.splice(pickedIndex, 1);
    }

    assignments.set(task.id, {
      task_id: task.id,
      start: assigned.start,
      end: assigned.end,
    });
  }

  // Return in input order.
  const out: ScheduleProposal[] = [];
  for (const task of tasks) {
    const proposal = assignments.get(task.id);
    if (proposal) out.push(proposal);
  }
  return out;
}
