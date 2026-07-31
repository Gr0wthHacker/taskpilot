/**
 * Tests for snooze/defer helpers (`src/renderer/lib/snooze.ts`).
 *
 * Covers the future/past boundary of `isSnoozed`, list partitioning, and the
 * three built-in presets (computed against a fixed reference "now").
 */

import { describe, expect, it } from 'vitest';

import {
  SNOOZE_PRESETS,
  getSnoozedUntil,
  isSnoozed,
  partitionSnoozed,
} from '@/renderer/lib/snooze';
import type { Task } from '@/shared/types';

// Mon Nov 23 2026 14:30 local — same anchor style as parse-due tests.
const NOW = new Date(2026, 10, 23, 14, 30, 0, 0);

function makeTask(partial: Partial<Task>): Task {
  return {
    id: 't1',
    title: 'x',
    description: null,
    status: 'inbox',
    priority: 'p2',
    agent_method: 'human_only',
    parent_id: null,
    due: null,
    tags: [],
    context: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...partial,
  } as Task;
}

describe('getSnoozedUntil', () => {
  it('returns null when there is no context', () => {
    expect(getSnoozedUntil(makeTask({ context: null }))).toBeNull();
  });

  it('returns null for a non-string or invalid timestamp', () => {
    expect(
      getSnoozedUntil(makeTask({ context: { snoozed_until: 42 } })),
    ).toBeNull();
    expect(
      getSnoozedUntil(makeTask({ context: { snoozed_until: 'not-a-date' } })),
    ).toBeNull();
  });

  it('returns the raw ISO string when valid', () => {
    const iso = new Date(2026, 11, 1, 9, 0, 0).toISOString();
    expect(
      getSnoozedUntil(makeTask({ context: { snoozed_until: iso } })),
    ).toBe(iso);
  });
});

describe('isSnoozed', () => {
  it('is true while the timestamp is in the future', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      isSnoozed(makeTask({ context: { snoozed_until: future } }), NOW),
    ).toBe(true);
  });

  it('is false once the timestamp has passed', () => {
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    expect(
      isSnoozed(makeTask({ context: { snoozed_until: past } }), NOW),
    ).toBe(false);
  });

  it('is false when not snoozed at all', () => {
    expect(isSnoozed(makeTask({ context: null }), NOW)).toBe(false);
  });
});

describe('partitionSnoozed', () => {
  it('splits future-snoozed from everything else', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const past = new Date(NOW.getTime() - 60_000).toISOString();
    const a = makeTask({ id: 'a', context: { snoozed_until: future } });
    const b = makeTask({ id: 'b', context: { snoozed_until: past } });
    const c = makeTask({ id: 'c', context: null });
    const { active, snoozed } = partitionSnoozed([a, b, c], NOW);
    expect(snoozed.map((t) => t.id)).toEqual(['a']);
    expect(active.map((t) => t.id)).toEqual(['b', 'c']);
  });
});

describe('SNOOZE_PRESETS', () => {
  it('always resolve to a future time', () => {
    for (const preset of SNOOZE_PRESETS) {
      expect(preset.resolve(NOW).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('tomorrow lands at 9am the next day', () => {
    const d = SNOOZE_PRESETS.find((p) => p.key === 'tomorrow')!.resolve(NOW);
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(9);
  });

  it('next-week lands on the following Monday at 9am', () => {
    const d = SNOOZE_PRESETS.find((p) => p.key === 'next-week')!.resolve(NOW);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(9);
    // NOW is itself a Monday, so the next Monday is 7 days out (Nov 30).
    expect(d.getDate()).toBe(30);
  });
});
