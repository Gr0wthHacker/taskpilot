/**
 * Cost tracking tests.
 *
 * Coverage:
 *   - pricing.computeCost is correct for known models, 0 for unknown
 *   - normalizeModel strips bracketed suffixes and date stamps
 *   - lookupPricing finds exact, normalized, and progressive-prefix matches
 *   - recordCost persists rows with computed USD
 *   - aggregateCost sums by tag, workspace, and model
 *   - third-party charges fold into cost_usd
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  aggregateCost,
  recordCost,
} from '@/main/cost-tracking';
import {
  computeCost,
  lookupPricing,
  normalizeModel,
} from '@/main/cost-tracking/pricing';
import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { createTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';

describe('cost-tracking', () => {
  useMockedDb();

  describe('normalizeModel', () => {
    it('strips bracketed suffixes', () => {
      expect(normalizeModel('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
    });

    it('strips date suffixes', () => {
      expect(normalizeModel('claude-opus-4-7-20251010')).toBe('claude-opus-4-7');
    });

    it('drops vendor prefixes', () => {
      expect(normalizeModel('anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
    });
  });

  describe('lookupPricing', () => {
    it('finds opus 4.7 rates', () => {
      const p = lookupPricing('claude-opus-4-7');
      expect(p).not.toBeNull();
      expect(p?.input).toBe(15);
      expect(p?.output).toBe(75);
    });

    it('finds sonnet 4.6 rates', () => {
      const p = lookupPricing('claude-sonnet-4-6');
      expect(p?.input).toBe(3);
      expect(p?.output).toBe(15);
    });

    it('finds haiku rates', () => {
      const p = lookupPricing('claude-haiku-4');
      expect(p?.input).toBe(0.8);
      expect(p?.output).toBe(4);
    });

    it('finds via progressive prefix shortening', () => {
      // No exact match but claude-opus-4 is in the table.
      const p = lookupPricing('claude-opus-4-9-20260101');
      expect(p?.input).toBe(15);
    });

    it('respects user override', () => {
      settingsRepository.set('model_pricing_override', {
        'custom-model': { input: 1, output: 2 },
      });
      const p = lookupPricing('custom-model');
      expect(p?.input).toBe(1);
      expect(p?.output).toBe(2);
    });

    it('returns null for unknown models', () => {
      expect(lookupPricing('nonexistent-model')).toBeNull();
    });
  });

  describe('computeCost', () => {
    it('computes opus 4.7 cost from input + output tokens', () => {
      // 1M input @ $15, 1M output @ $75 → $90 total.
      expect(
        computeCost({
          model: 'claude-opus-4-7',
          input: 1_000_000,
          output: 1_000_000,
        }),
      ).toBe(90);
    });

    it('handles partial token counts', () => {
      // 1k output tokens at $75/M = $0.075.
      const usd = computeCost({
        model: 'claude-opus-4-7',
        output: 1_000,
      });
      expect(usd).toBeCloseTo(0.075, 6);
    });

    it('returns 0 for unknown model', () => {
      expect(
        computeCost({
          model: 'unknown-model',
          input: 1_000_000,
          output: 1_000_000,
        }),
      ).toBe(0);
    });

    it('returns 0 when tokens are missing', () => {
      expect(computeCost(undefined)).toBe(0);
      expect(computeCost({ model: 'claude-opus-4-7' })).toBe(0);
    });

    it('applies cache-read discount', () => {
      // Cache-read defaults to 10% of input → 1M cache_read @ opus is $1.50.
      const usd = computeCost({
        model: 'claude-opus-4-7',
        cache_read: 1_000_000,
      });
      expect(usd).toBeCloseTo(1.5, 6);
    });

    it('applies cache-creation premium', () => {
      // Cache-creation defaults to 125% of input → 1M creation @ opus is $18.75.
      const usd = computeCost({
        model: 'claude-opus-4-7',
        cache_creation: 1_000_000,
      });
      expect(usd).toBeCloseTo(18.75, 6);
    });
  });

  describe('recordCost', () => {
    it('persists a row with computed USD', () => {
      const task = createTask({ title: 'Test task', tags: ['biotech'] });
      const event = recordCost({
        task_id: task.id,
        tokens: {
          model: 'claude-sonnet-4-6',
          input: 100_000,
          output: 50_000,
        },
        source: 'execution',
      });
      expect(event).not.toBeNull();
      expect(event?.task_id).toBe(task.id);
      expect(event?.cost_usd).toBeGreaterThan(0);
      // 100k input @ $3/M = $0.30, 50k output @ $15/M = $0.75 → $1.05.
      expect(event?.cost_usd).toBeCloseTo(1.05, 4);
    });

    it('returns null when there are no tokens and no third-party charge', () => {
      const task = createTask({ title: 'Empty' });
      expect(recordCost({ task_id: task.id })).toBeNull();
    });

    it('folds third-party charges into cost_usd', () => {
      const task = createTask({ title: 'API call' });
      const event = recordCost({
        task_id: task.id,
        third_party_label: 'reddit_api',
        third_party_cost_usd: 0.5,
      });
      expect(event?.cost_usd).toBeCloseTo(0.5, 6);
      expect(event?.third_party_label).toBe('reddit_api');
    });
  });

  describe('aggregateCost', () => {
    it('sums by tag', () => {
      const a = createTask({ title: 'A', tags: ['biotech', 'research'] });
      const b = createTask({ title: 'B', tags: ['biotech'] });
      recordCost({
        task_id: a.id,
        tokens: { model: 'claude-opus-4-7', input: 1_000_000 },
      });
      recordCost({
        task_id: b.id,
        tokens: { model: 'claude-opus-4-7', input: 2_000_000 },
      });

      const summary = aggregateCost('30d');
      expect(summary.events).toBe(2);
      // 3M input @ $15/M = $45.
      expect(summary.total_usd).toBeCloseTo(45, 4);

      const biotech = summary.by_tag.find((e) => e.key === 'biotech');
      expect(biotech).toBeDefined();
      expect(biotech?.total_usd).toBeCloseTo(45, 4);

      const research = summary.by_tag.find((e) => e.key === 'research');
      expect(research?.total_usd).toBeCloseTo(15, 4);
    });

    it('sums by model', () => {
      const t = createTask({ title: 'Mixed' });
      recordCost({
        task_id: t.id,
        tokens: { model: 'claude-opus-4-7', input: 1_000_000 },
      });
      recordCost({
        task_id: t.id,
        tokens: { model: 'claude-sonnet-4-6', input: 1_000_000 },
      });

      const summary = aggregateCost();
      expect(summary.by_model.length).toBeGreaterThanOrEqual(2);
      const opus = summary.by_model.find((e) => e.key === 'claude-opus-4-7');
      const sonnet = summary.by_model.find((e) => e.key === 'claude-sonnet-4-6');
      expect(opus?.total_usd).toBeCloseTo(15, 4);
      expect(sonnet?.total_usd).toBeCloseTo(3, 4);
    });

    it('sums by workspace', () => {
      settingsRepository.set('workspaces', [
        { id: 'leal', name: 'Leal', tags: ['biotech'] },
        { id: 'reddit', name: 'Reddit', tags: ['reddit'] },
      ]);
      const a = createTask({ title: 'A', tags: ['biotech'] });
      const b = createTask({ title: 'B', tags: ['reddit'] });
      recordCost({
        task_id: a.id,
        tokens: { model: 'claude-opus-4-7', input: 1_000_000 },
      });
      recordCost({
        task_id: b.id,
        tokens: { model: 'claude-opus-4-7', input: 2_000_000 },
      });

      const summary = aggregateCost();
      const leal = summary.by_workspace.find((e) => e.key === 'leal');
      const reddit = summary.by_workspace.find((e) => e.key === 'reddit');
      expect(leal?.total_usd).toBeCloseTo(15, 4);
      expect(reddit?.total_usd).toBeCloseTo(30, 4);
    });

    it('returns empty summary when no events', () => {
      const summary = aggregateCost('7d');
      expect(summary.events).toBe(0);
      expect(summary.total_usd).toBe(0);
      expect(summary.by_tag).toEqual([]);
    });
  });

  describe('listCostEvents', () => {
    it('filters by task_id', () => {
      const a = createTask({ title: 'A' });
      const b = createTask({ title: 'B' });
      recordCost({
        task_id: a.id,
        tokens: { model: 'claude-opus-4-7', input: 100 },
      });
      recordCost({
        task_id: b.id,
        tokens: { model: 'claude-opus-4-7', input: 100 },
      });
      const onlyA = costEventsRepository.list({ task_id: a.id });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]?.task_id).toBe(a.id);
    });
  });
});
