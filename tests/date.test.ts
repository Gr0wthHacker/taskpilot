/**
 * Tests for the shared ISO date parser (`src/renderer/lib/date.ts`).
 */

import { describe, expect, it } from 'vitest';

import { safeParseISO } from '@/renderer/lib/date';

describe('safeParseISO', () => {
  it('parses a valid ISO string', () => {
    const d = safeParseISO('2026-05-29T14:30:00.000Z');
    expect(d).not.toBeNull();
    expect(d?.getTime()).toBe(Date.parse('2026-05-29T14:30:00.000Z'));
  });

  it('returns null for an empty string', () => {
    expect(safeParseISO('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(safeParseISO('not-a-date')).toBeNull();
  });
});
