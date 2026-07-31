/**
 * Confidence gating tests.
 *
 * Coverage:
 *   - getConfidenceThreshold reads/parses the setting, clamps out-of-range
 *   - isBelowThreshold honors the configured cutoff
 *   - ingestion routes to /review when confidence < threshold
 *   - ingestion records a low_confidence feedback row
 *   - ingestion stamps task.context.last_confidence
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';
import { mockTaskpilotPaths } from './helpers/mock-paths';

mockTaskpilotPaths();

import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  confidenceBand,
  confidenceLabel,
  getConfidenceThreshold,
  isBelowThreshold,
} from '@/main/confidence';
import { createTask, getTask } from '@/main/db/repositories/tasks';
import { feedbackRepository } from '@/main/db/repositories/feedback';
import { settingsRepository } from '@/main/db/repositories/settings';
import { ingestResult } from '@/main/io/ingestion';

describe('confidence', () => {
  useMockedDb();

  describe('getConfidenceThreshold', () => {
    it('defaults to 0.7 when unset', () => {
      expect(getConfidenceThreshold()).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    });

    it('reads numeric settings', () => {
      settingsRepository.set('confidence_threshold', 0.85);
      expect(getConfidenceThreshold()).toBe(0.85);
    });

    it('parses string settings', () => {
      settingsRepository.set('confidence_threshold', '0.55');
      expect(getConfidenceThreshold()).toBe(0.55);
    });

    it('clamps to [0, 1]', () => {
      settingsRepository.set('confidence_threshold', 2);
      expect(getConfidenceThreshold()).toBe(1);
      settingsRepository.set('confidence_threshold', -1);
      expect(getConfidenceThreshold()).toBe(0);
    });

    it('falls back to default on garbage', () => {
      settingsRepository.set('confidence_threshold', 'not-a-number');
      expect(getConfidenceThreshold()).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    });
  });

  describe('isBelowThreshold', () => {
    it('returns true when confidence is below the cutoff', () => {
      expect(isBelowThreshold(0.4, 0.7)).toBe(true);
    });

    it('returns false at exactly the threshold', () => {
      expect(isBelowThreshold(0.7, 0.7)).toBe(false);
    });

    it('returns false when confidence is undefined', () => {
      expect(isBelowThreshold(undefined, 0.7)).toBe(false);
    });

    it('uses the stored threshold when none is passed', () => {
      settingsRepository.set('confidence_threshold', 0.9);
      expect(isBelowThreshold(0.8)).toBe(true);
      settingsRepository.set('confidence_threshold', 0.5);
      expect(isBelowThreshold(0.8)).toBe(false);
    });
  });

  describe('confidenceBand', () => {
    it('classifies high', () => {
      expect(confidenceBand(0.9)).toBe('high');
      expect(confidenceBand(0.85)).toBe('high');
    });

    it('classifies medium', () => {
      expect(confidenceBand(0.6)).toBe('medium');
    });

    it('classifies low', () => {
      expect(confidenceBand(0.3)).toBe('low');
    });

    it('classifies unknown for missing values', () => {
      expect(confidenceBand(undefined)).toBe('unknown');
      expect(confidenceLabel(undefined)).toBe('No confidence reported');
    });
  });

  describe('ingestion routing', () => {
    it('routes low-confidence results to review even without review_required', async () => {
      const task = createTask({ title: 'Routine task', agent_method: 'cli' });
      // Ensure trust-by-default is on (default true) so the gate
      // would normally let this pass.
      settingsRepository.set('auto_approve_results', true);
      settingsRepository.set('confidence_threshold', 0.7);

      await ingestResult(
        task.id,
        {
          task_id: task.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          summary: 'finished',
          output_files: [],
          confidence: 0.4,
        },
        [],
      );

      const refreshed = getTask(task.id);
      // Confidence gate should have routed to /review by setting status=blocked.
      expect(refreshed?.status).toBe('blocked');
    });

    it('lets high-confidence results pass through to done', async () => {
      const task = createTask({ title: 'Confident task', agent_method: 'cli' });
      settingsRepository.set('auto_approve_results', true);
      settingsRepository.set('confidence_threshold', 0.7);

      await ingestResult(
        task.id,
        {
          task_id: task.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          summary: 'finished',
          output_files: [],
          confidence: 0.95,
        },
        [],
      );

      const refreshed = getTask(task.id);
      expect(refreshed?.status).toBe('done');
    });

    it('records a low_confidence feedback row when gate fires', async () => {
      const task = createTask({ title: 'Borderline', agent_method: 'cli' });
      settingsRepository.set('confidence_threshold', 0.7);

      await ingestResult(
        task.id,
        {
          task_id: task.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          summary: 'shaky',
          output_files: [],
          confidence: 0.4,
        },
        [],
      );

      const fb = feedbackRepository.list({
        task_id: task.id,
        kinds: ['low_confidence'],
      });
      expect(fb).toHaveLength(1);
      expect(fb[0]?.reason).toContain('0.40');
    });

    it('stamps last_confidence on task.context', async () => {
      const task = createTask({ title: 'Conf task', agent_method: 'cli' });
      await ingestResult(
        task.id,
        {
          task_id: task.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          summary: 'ok',
          output_files: [],
          confidence: 0.92,
        },
        [],
      );
      const refreshed = getTask(task.id);
      const ctx = refreshed?.context as Record<string, unknown> | null;
      expect(ctx?.['last_confidence']).toBeCloseTo(0.92, 4);
    });

    it('does NOT route to review when confidence is omitted', async () => {
      const task = createTask({ title: 'No conf', agent_method: 'cli' });
      settingsRepository.set('auto_approve_results', true);
      settingsRepository.set('confidence_threshold', 0.7);

      await ingestResult(
        task.id,
        {
          task_id: task.id,
          status: 'succeeded',
          completed_at: new Date().toISOString(),
          summary: 'ok',
          output_files: [],
        },
        [],
      );

      const refreshed = getTask(task.id);
      expect(refreshed?.status).toBe('done');
    });
  });
});
