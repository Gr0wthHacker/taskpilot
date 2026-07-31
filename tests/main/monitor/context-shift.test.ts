/**
 * Tests for the context-shift detector.
 *
 * Pure function — no DB, no I/O, no timers. Asserts the Jaccard-based shift
 * score over hand-rolled observations.
 */

import { describe, expect, it } from 'vitest';

import {
  contextShiftScore,
  isContextShift,
  type ContextShiftObservation,
} from '@/main/monitor/context-shift';

function o(fields: Partial<ContextShiftObservation>): ContextShiftObservation {
  return {
    app_name: fields.app_name ?? null,
    window_title: fields.window_title ?? null,
    url: fields.url ?? null,
    page_title: fields.page_title ?? null,
  };
}

describe('contextShiftScore', () => {
  it('returns 1 when there is no previous observation', () => {
    const score = contextShiftScore(null, o({ app_name: 'chrome' }));
    expect(score).toBe(1);
  });

  it('returns 0 when comparing an observation to itself', () => {
    const obs = o({
      app_name: 'chrome',
      window_title: 'Inbox - Gmail',
      url: 'https://mail.google.com/mail/u/0/#inbox',
    });
    expect(contextShiftScore(obs, obs)).toBe(0);
  });

  it('scores a full app+title swap close to 1', () => {
    const before = o({ app_name: 'chrome', window_title: 'Inbox Gmail' });
    const after = o({ app_name: 'vscode', window_title: 'main.rs taskpilot' });
    const score = contextShiftScore(before, after);
    expect(score).toBeGreaterThan(0.9);
  });

  it('scores a small change (one new token) below the default threshold', () => {
    const before = o({
      app_name: 'chrome',
      window_title: 'Inbox Gmail Personal Jack Mailbox',
    });
    const after = o({
      app_name: 'chrome',
      window_title: 'Drafts Gmail Personal Jack Mailbox',
    });
    const score = contextShiftScore(before, after);
    // Replacing one token of five tokens (plus shared "chrome" app) → modest shift.
    expect(score).toBeLessThan(0.4);
    expect(score).toBeGreaterThan(0);
  });

  it('ignores casing and punctuation differences', () => {
    const before = o({ window_title: 'Inbox - Gmail' });
    const after = o({ window_title: 'inbox: gmail!' });
    expect(contextShiftScore(before, after)).toBe(0);
  });

  it('skips stopwords so common glue (a/the/of) does not move the score', () => {
    const before = o({ window_title: 'jack the developer' });
    const after = o({ window_title: 'jack developer' });
    expect(contextShiftScore(before, after)).toBe(0);
  });

  it('skips http/https/www so URL chrome does not move the score', () => {
    const before = o({ url: 'https://github.com/jack/taskpilot' });
    const after = o({ url: 'http://www.github.com/jack/taskpilot/' });
    expect(contextShiftScore(before, after)).toBe(0);
  });

  it('returns 0 when both observations have no tokens', () => {
    const score = contextShiftScore(o({}), o({}));
    expect(score).toBe(0);
  });

  it('handles null + missing fields without throwing', () => {
    const before = o({ app_name: null, window_title: null });
    const after = o({ app_name: 'chrome', window_title: 'Gmail' });
    expect(contextShiftScore(before, after)).toBe(1);
  });

  it('clamps results into [0, 1]', () => {
    const before = o({ window_title: 'a b c' });
    const after = o({ window_title: 'x y z' });
    const score = contextShiftScore(before, after);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('isContextShift', () => {
  it('returns true when shift exceeds the threshold', () => {
    const before = o({ window_title: 'Inbox Gmail' });
    const after = o({ window_title: 'main rs taskpilot' });
    expect(isContextShift(before, after, 0.3)).toBe(true);
  });

  it('returns false when shift is at or below the threshold', () => {
    const same = o({ window_title: 'Inbox Gmail' });
    expect(isContextShift(same, same, 0)).toBe(false);
  });

  it('clamps a negative threshold to 0', () => {
    const same = o({ window_title: 'Inbox Gmail' });
    // shift is 0; threshold clamped to 0; 0 > 0 is false.
    expect(isContextShift(same, same, -1)).toBe(false);
  });

  it('clamps a >1 threshold to 1', () => {
    const before = o({ window_title: 'a' });
    const after = o({ window_title: 'b' });
    // Even max shift (1) is not > 1.
    expect(isContextShift(before, after, 999)).toBe(false);
  });
});
