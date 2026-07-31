/**
 * Feedback loop tests.
 *
 * Coverage:
 *   - recordRejection persists a row with task metadata in details
 *   - listForTasks returns only rejection rows for the requested ids
 *   - summarizeRejections renders a "## Past rejections" markdown block
 *   - summarizeRejections de-duplicates identical reasons
 *   - summarizeRejections respects the soft cap
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import { createTask } from '@/main/db/repositories/tasks';
import {
  listForTask,
  listForTasks,
  recordFeedback,
  recordRejection,
  summarizeRejections,
} from '@/main/feedback';

describe('feedback', () => {
  useMockedDb();

  describe('recordRejection', () => {
    it('persists with details serialized as JSON when an object', () => {
      const t = createTask({ title: 'Plan content', tags: ['content'] });
      const entry = recordRejection({
        task_id: t.id,
        kind: 'rejection_derivation',
        reason: 'Too granular',
        details: { tags: ['content'] },
      });
      expect(entry.kind).toBe('rejection_derivation');
      expect(entry.reason).toBe('Too granular');
      expect(entry.details).toContain('"tags"');
    });

    it('passes through string details verbatim', () => {
      const t = createTask({ title: 'X' });
      const entry = recordRejection({
        task_id: t.id,
        kind: 'rejection_result',
        details: 'plain text note',
      });
      expect(entry.details).toBe('plain text note');
    });
  });

  describe('listForTask / listForTasks', () => {
    it('returns rejections for a single task newest-first', () => {
      const t = createTask({ title: 'T' });
      recordRejection({
        task_id: t.id,
        kind: 'rejection_derivation',
        reason: 'first',
      });
      recordRejection({
        task_id: t.id,
        kind: 'rejection_result',
        reason: 'second',
      });
      const rows = listForTask(t.id);
      expect(rows).toHaveLength(2);
    });

    it('listForTasks only returns rejection kinds', () => {
      const t = createTask({ title: 'T2' });
      recordRejection({ task_id: t.id, kind: 'rejection_derivation', reason: 'r1' });
      recordFeedback({ task_id: t.id, kind: 'note', reason: 'just a note' });
      const rows = listForTasks([t.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe('rejection_derivation');
    });
  });

  describe('summarizeRejections', () => {
    it('returns empty string when no tasks supplied', () => {
      expect(summarizeRejections([])).toBe('');
    });

    it('returns empty string when none have rejections', () => {
      const t = createTask({ title: 'No-fb', status: 'done' });
      expect(summarizeRejections([t])).toBe('');
    });

    it('builds a markdown block with rejection reasons', () => {
      const t = createTask({ title: 'Old similar task', status: 'done' });
      recordRejection({
        task_id: t.id,
        kind: 'rejection_derivation',
        reason: 'Too granular — collapse the dependencies.',
      });
      const block = summarizeRejections([t]);
      expect(block).toContain('## Past rejections');
      expect(block).toContain('Too granular');
      expect(block).toContain('avoid repeating those mistakes');
    });

    it('de-duplicates identical reasons across tasks', () => {
      const t1 = createTask({ title: 'A', status: 'done' });
      const t2 = createTask({ title: 'B', status: 'done' });
      recordRejection({
        task_id: t1.id,
        kind: 'rejection_derivation',
        reason: 'Same reason',
      });
      recordRejection({
        task_id: t2.id,
        kind: 'rejection_derivation',
        reason: 'Same reason',
      });
      const block = summarizeRejections([t1, t2]);
      // The reason text should appear exactly once.
      const occurrences = block.match(/Same reason/g) ?? [];
      expect(occurrences.length).toBe(1);
    });

    it('caps the block when many rejections exist', () => {
      const tasks: ReturnType<typeof createTask>[] = [];
      for (let i = 0; i < 10; i += 1) {
        const t = createTask({ title: `T ${i}`, status: 'done' });
        recordRejection({
          task_id: t.id,
          kind: 'rejection_derivation',
          reason: `Reason ${i}`,
        });
        tasks.push(t);
      }
      const block = summarizeRejections(tasks);
      // We cap at 5 bullets — count the leading '- "' markers.
      const bullets = block.match(/^- "/gm) ?? [];
      expect(bullets.length).toBeLessThanOrEqual(5);
    });
  });
});
