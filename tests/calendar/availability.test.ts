/**
 * Calendar availability tests.
 *
 * `availability.ts` calls `freeBusy()` from `./google` and reads two settings
 * via the settings repo. We mock both so the test runs against a deterministic
 * "busy" list, without needing OAuth or a Google API client.
 */

import { describe, expect, it, vi } from 'vitest';

// Mocks must be declared before importing anything that pulls in availability.
vi.mock('@/main/calendar/google', () => ({
  freeBusy: vi.fn(),
}));

const settingsStore = new Map<string, unknown>();

vi.mock('@/main/db/repositories/settings', () => ({
  get: <T = unknown>(key: string): T | null =>
    (settingsStore.get(key) as T | undefined) ?? null,
  set: (key: string, value: unknown) => settingsStore.set(key, value),
  del: (key: string) => settingsStore.delete(key),
  getAll: () => Object.fromEntries(settingsStore.entries()),
}));

import { freeBusy } from '@/main/calendar/google';
import { getAvailability } from '@/main/calendar/availability';

// helper: pick a known weekday so weekend filtering doesn't bite us.
function nextMonday(): Date {
  // Tue 2026-05-26 is the cwd's "today"; pick Mon 2026-06-01 to be safe.
  return new Date(2026, 5, 1, 0, 0, 0, 0); // months are 0-indexed
}

function setBusy(ranges: Array<{ start: string; end: string }>) {
  vi.mocked(freeBusy).mockResolvedValue(ranges);
}

describe('getAvailability', () => {
  it('returns empty for a non-positive duration', async () => {
    setBusy([]);
    expect(await getAvailability(nextMonday(), new Date(2026, 5, 2), 0)).toEqual([]);
    expect(await getAvailability(nextMonday(), new Date(2026, 5, 2), -10)).toEqual([]);
  });

  it('returns empty when to <= from', async () => {
    setBusy([]);
    const t = nextMonday();
    expect(await getAvailability(t, t, 30)).toEqual([]);
    expect(await getAvailability(new Date(t.getTime() + 1000), t, 30)).toEqual([]);
  });

  it('returns the full 9-18 window for an empty calendar (60-min request)', async () => {
    settingsStore.clear();
    setBusy([]);
    const mon = nextMonday();
    const end = new Date(mon);
    end.setHours(23, 59, 59);

    const slots = await getAvailability(mon, end, 60);
    expect(slots).toHaveLength(1);
    // 9 AM to 6 PM local = 9 hours = comfortably >= 60 min.
    const slot = slots[0];
    expect(slot).toBeDefined();
    if (!slot) return;
    expect(new Date(slot.start).getHours()).toBe(9);
    expect(new Date(slot.end).getHours()).toBe(18);
  });

  it('splits the window around a midday busy block', async () => {
    settingsStore.clear();
    const mon = nextMonday();
    const busyStart = new Date(mon);
    busyStart.setHours(12, 0, 0, 0);
    const busyEnd = new Date(mon);
    busyEnd.setHours(13, 0, 0, 0);
    setBusy([{ start: busyStart.toISOString(), end: busyEnd.toISOString() }]);

    const end = new Date(mon);
    end.setHours(23, 59, 59);
    const slots = await getAvailability(mon, end, 30);
    expect(slots.length).toBe(2);
    // First slot: 9 - 12
    expect(new Date(slots[0]!.start).getHours()).toBe(9);
    expect(new Date(slots[0]!.end).getHours()).toBe(12);
    // Second slot: 13 - 18
    expect(new Date(slots[1]!.start).getHours()).toBe(13);
    expect(new Date(slots[1]!.end).getHours()).toBe(18);
  });

  it('drops slots that are shorter than the requested duration', async () => {
    settingsStore.clear();
    const mon = nextMonday();
    // Busy: 9:30 to 17:30 — leaves a 30-min window on each side.
    const busyStart = new Date(mon);
    busyStart.setHours(9, 30, 0, 0);
    const busyEnd = new Date(mon);
    busyEnd.setHours(17, 30, 0, 0);
    setBusy([{ start: busyStart.toISOString(), end: busyEnd.toISOString() }]);

    const end = new Date(mon);
    end.setHours(23, 59, 59);
    // 60-minute request — nothing fits the 30-min gaps.
    const slots60 = await getAvailability(mon, end, 60);
    expect(slots60).toEqual([]);
    // 30-minute request — both 30-min gaps fit.
    const slots30 = await getAvailability(mon, end, 30);
    expect(slots30).toHaveLength(2);
  });

  it('skips weekend days when agent_weekends=false (default)', async () => {
    settingsStore.clear();
    setBusy([]);
    // Sat 2026-05-30 → Sun 2026-05-31.
    const sat = new Date(2026, 4, 30, 0, 0, 0, 0);
    const sunEnd = new Date(2026, 4, 31, 23, 59, 59);
    const slots = await getAvailability(sat, sunEnd, 30);
    expect(slots).toEqual([]);
  });

  it('includes weekend days when agent_weekends=true', async () => {
    settingsStore.clear();
    settingsStore.set('agent_weekends', true);
    setBusy([]);
    const sat = new Date(2026, 4, 30, 0, 0, 0, 0);
    const sunEnd = new Date(2026, 4, 31, 23, 59, 59);
    const slots = await getAvailability(sat, sunEnd, 30);
    expect(slots).toHaveLength(2); // one slot per day
    settingsStore.delete('agent_weekends');
  });

  it('respects custom agent_hours setting', async () => {
    settingsStore.clear();
    settingsStore.set('agent_hours', { start: '10:00', end: '14:00' });
    setBusy([]);
    const mon = nextMonday();
    const end = new Date(mon);
    end.setHours(23, 59, 59);
    const slots = await getAvailability(mon, end, 30);
    expect(slots).toHaveLength(1);
    const slot = slots[0]!;
    expect(new Date(slot.start).getHours()).toBe(10);
    expect(new Date(slot.end).getHours()).toBe(14);
    settingsStore.delete('agent_hours');
  });

  it('counts roughly the right number of slots for a 30-min request across a full day', async () => {
    settingsStore.clear();
    setBusy([]);
    const mon = nextMonday();
    const end = new Date(mon);
    end.setHours(23, 59, 59);
    // One contiguous 9h window of free time → exactly 1 slot returned by this
    // implementation (it returns gap ranges, not 30-min buckets).
    const slots = await getAvailability(mon, end, 30);
    expect(slots).toHaveLength(1);
    // The single slot spans 9h, which is >= 30 minutes by a wide margin.
    const slot = slots[0]!;
    const span = new Date(slot.end).getTime() - new Date(slot.start).getTime();
    expect(span).toBe(9 * 60 * 60 * 1_000);
  });
});
