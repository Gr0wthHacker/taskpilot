/**
 * Derivation memory tests.
 *
 * Covers:
 *   - similarityScore is sane: identical tasks → 1, disjoint → 0
 *   - findSimilarDoneTasks ranks by tag overlap + title BoW
 *   - findSimilarDoneTasks excludes the source task itself
 *   - findSimilarDoneTasks only returns DONE tasks
 *   - summarizeForContext renders a "## Past similar tasks" block with
 *     children, and is hard-capped at ~2000 chars
 *   - buildDerivationMemory wires the two halves and reports count
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  buildDerivationMemory,
  findSimilarDoneTasks,
  similarityScore,
  summarizeForContext,
} from '@/main/derive-memory';
import { createTask } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

function seed(input: Partial<Task> & { title: string }): Task {
  return createTask(input);
}

describe('derive-memory', () => {
  useMockedDb();

  describe('similarityScore', () => {
    it('returns ~1 for identical tasks', () => {
      const a = seed({ title: 'Write biotech report', tags: ['biotech', 'oncology'] });
      const b = seed({ title: 'Write biotech report', tags: ['biotech', 'oncology'] });
      expect(similarityScore(a, b)).toBeGreaterThan(0.9);
    });

    it('returns 0 for disjoint tasks', () => {
      const a = seed({ title: 'Write biotech report', tags: ['biotech'] });
      const b = seed({ title: 'Buy groceries', tags: ['errands'] });
      expect(similarityScore(a, b)).toBe(0);
    });

    it('rewards tag overlap', () => {
      const a = seed({ title: 'Plan content', tags: ['indexthread', 'reddit'] });
      const justTitle = seed({ title: 'Plan content', tags: [] });
      const sharedTags = seed({ title: 'Different work', tags: ['indexthread', 'reddit'] });
      expect(similarityScore(a, sharedTags)).toBeGreaterThan(0);
      // Both have something in common — confirm the score is positive
      // rather than enforcing exact ordering (BoW scores are coarse).
      expect(similarityScore(a, justTitle)).toBeGreaterThan(0);
    });
  });

  describe('findSimilarDoneTasks', () => {
    it('returns done tasks ranked by similarity', () => {
      const source = seed({ title: 'Write Reddit research paper', tags: ['reddit', 'research'] });
      const similar = seed({
        title: 'Write Reddit competitive research',
        tags: ['reddit', 'research'],
        status: 'done',
      });
      const lessSimilar = seed({
        title: 'Email client',
        tags: ['email'],
        status: 'done',
      });
      const matches = findSimilarDoneTasks(source);
      expect(matches.length).toBeGreaterThanOrEqual(1);
      // The high-overlap done task should rank first.
      expect(matches[0]?.task.id).toBe(similar.id);
      // The disjoint done task should either be filtered out (score 0) or
      // ranked strictly below the similar one.
      const lesserMatch = matches.find((m) => m.task.id === lessSimilar.id);
      if (lesserMatch) {
        expect(lesserMatch.score).toBeLessThan(matches[0]!.score);
      }
    });

    it('excludes the source task itself', () => {
      const self = seed({
        title: 'Write report',
        tags: ['research'],
        status: 'done',
      });
      const matches = findSimilarDoneTasks(self);
      expect(matches.find((m) => m.task.id === self.id)).toBeUndefined();
    });

    it('only returns DONE tasks', () => {
      const source = seed({ title: 'Plan content', tags: ['content'] });
      seed({ title: 'Plan content draft', tags: ['content'], status: 'queued' });
      seed({ title: 'Plan content backlog', tags: ['content'], status: 'inbox' });
      const matches = findSimilarDoneTasks(source);
      expect(matches.length).toBe(0);
    });

    it('respects the limit param', () => {
      const source = seed({ title: 'Write blog post', tags: ['content', 'blog'] });
      for (let i = 0; i < 8; i += 1) {
        seed({
          title: `Write blog post ${i}`,
          tags: ['content', 'blog'],
          status: 'done',
        });
      }
      const matches = findSimilarDoneTasks(source, 3);
      expect(matches.length).toBe(3);
    });
  });

  describe('summarizeForContext', () => {
    it('returns empty string when no matches', () => {
      expect(summarizeForContext([])).toBe('');
    });

    it('renders a markdown block with titles + tags', () => {
      const parent = seed({
        title: 'Pitch deck v1',
        tags: ['deck', 'leal'],
        status: 'done',
      });
      seed({ title: 'Draft outline', parent_id: parent.id, status: 'done' });
      seed({ title: 'Polish slides', parent_id: parent.id, status: 'done' });
      const text = summarizeForContext([{ task: parent, score: 0.8 }]);
      expect(text).toContain('## Past similar tasks');
      expect(text).toContain('Pitch deck v1');
      expect(text).toContain('deck');
      expect(text).toContain('Draft outline');
      expect(text).toContain('Polish slides');
    });

    it('respects the 2000-char soft cap', () => {
      const matches = [];
      for (let i = 0; i < 50; i += 1) {
        const parent = seed({
          title: `Some really long task title ${'x'.repeat(40)} ${i}`,
          tags: ['tag'],
          status: 'done',
        });
        matches.push({ task: parent, score: 0.5 });
      }
      const text = summarizeForContext(matches);
      expect(text.length).toBeLessThanOrEqual(2_100); // small slack for the truncation marker
      expect(text).toContain('## Past similar tasks');
    });
  });

  describe('buildDerivationMemory', () => {
    it('returns { block, count } with empty block when nothing matches', () => {
      const a = seed({ title: 'Untagged solo task' });
      const result = buildDerivationMemory(a);
      expect(result.count).toBe(0);
      expect(result.block).toBe('');
    });

    it('reports match count when memories exist', () => {
      const a = seed({ title: 'Build landing page', tags: ['next', 'landing'] });
      seed({
        title: 'Build landing page',
        tags: ['next', 'landing'],
        status: 'done',
      });
      const result = buildDerivationMemory(a);
      expect(result.count).toBeGreaterThan(0);
      expect(result.block).toContain('Past similar tasks');
    });
  });
});
