/**
 * Skill binding + registry tests.
 *
 * Coverage:
 *   - listKnownSkills includes the built-ins
 *   - suggestSkillsForTask ranks correctly for common cases
 *   - registerCustomSkill persists + appears in listings
 *   - readTaskSkills / setTaskSkills round-trip
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  buildSkillsInstructionsBlock,
  listKnownSkills,
  readTaskSkills,
  registerCustomSkill,
  setTaskSkills,
  suggestSkillsForTask,
  unregisterCustomSkill,
} from '@/main/skill-binding';
import { createTask, getTask } from '@/main/db/repositories/tasks';

describe('skill-binding', () => {
  useMockedDb();

  describe('listKnownSkills', () => {
    it('includes built-ins out of the box', () => {
      const skills = listKnownSkills();
      const names = skills.map((s) => s.name);
      expect(names).toContain('anthropic-skills:pptx');
      expect(names).toContain('anthropic-skills:lovable-builder');
      expect(names).toContain('content-writing');
    });
  });

  describe('suggestSkillsForTask', () => {
    it('routes "build a deck" → pptx', () => {
      const task = createTask({ title: 'Build the pitch deck for Tuesday' });
      const suggestions = suggestSkillsForTask(task, 3);
      expect(suggestions.length).toBeGreaterThan(0);
      const top = suggestions.map((s) => s.name);
      expect(top).toContain('anthropic-skills:pptx');
    });

    it('routes "iterate on a Lovable app" → lovable-builder', () => {
      const task = createTask({
        title: 'Iterate on the Lovable app for HABA',
      });
      const suggestions = suggestSkillsForTask(task, 3);
      const names = suggestions.map((s) => s.name);
      expect(names).toContain('anthropic-skills:lovable-builder');
    });

    it('routes Reddit-flavored tasks to a Reddit skill', () => {
      const task = createTask({
        title: 'Write a Reddit post for r/marketing',
        tags: ['reddit'],
      });
      const suggestions = suggestSkillsForTask(task, 3);
      const names = suggestions.map((s) => s.name);
      // At least one of the Reddit-family skills should rank in the top 3.
      const reddit = names.find((n) =>
        ['reddit-content-crafter', 'subreddit-analyzing', 'thread-necromancer'].includes(n),
      );
      expect(reddit).toBeTruthy();
    });

    it('returns empty list when nothing meaningful matches', () => {
      const task = createTask({ title: 'qqqq zzzz' });
      const suggestions = suggestSkillsForTask(task, 3);
      // The catalog has no keyword overlap with this garbage — score should
      // be zero and we should bail out cleanly.
      expect(suggestions.length).toBe(0);
    });

    it('respects the limit param', () => {
      const task = createTask({
        title: 'Write a blog post about Reddit, Facebook ads, landing pages, and email sequences',
      });
      const top1 = suggestSkillsForTask(task, 1);
      expect(top1.length).toBeLessThanOrEqual(1);
      const top5 = suggestSkillsForTask(task, 5);
      expect(top5.length).toBeLessThanOrEqual(5);
      expect(top5.length).toBeGreaterThanOrEqual(top1.length);
    });
  });

  describe('registerCustomSkill', () => {
    it('persists a custom skill and lists it', () => {
      const desc = registerCustomSkill({
        name: 'my-custom-skill',
        label: 'My custom skill',
        description: 'Does a thing.',
        keywords: ['custom', 'thing'],
      });
      expect(desc.custom).toBe(true);
      const all = listKnownSkills();
      expect(all.find((s) => s.name === 'my-custom-skill')).toBeTruthy();
    });

    it('can be unregistered', () => {
      registerCustomSkill({
        name: 'temp-skill',
        label: 'Temp',
        description: 'Temp skill for test',
      });
      expect(unregisterCustomSkill('temp-skill')).toBe(true);
      const all = listKnownSkills();
      expect(all.find((s) => s.name === 'temp-skill')).toBeFalsy();
    });

    it('rejects malformed names via the schema', () => {
      expect(() =>
        registerCustomSkill({
          name: 'BadCase Name',
          label: 'no',
          description: 'no',
        }),
      ).toThrow();
    });
  });

  describe('readTaskSkills / setTaskSkills', () => {
    it('round-trips bound skills through context', () => {
      const task = createTask({ title: 'A task' });
      const stored = setTaskSkills(task.id, [
        'anthropic-skills:pptx',
        'content-writing',
      ]);
      expect(stored).toEqual(['anthropic-skills:pptx', 'content-writing']);
      const fresh = getTask(task.id);
      expect(readTaskSkills(fresh)).toEqual([
        'anthropic-skills:pptx',
        'content-writing',
      ]);
    });

    it('clearing via empty array strips the key', () => {
      const task = createTask({ title: 'A task' });
      setTaskSkills(task.id, ['anthropic-skills:pptx']);
      setTaskSkills(task.id, []);
      const fresh = getTask(task.id);
      expect(readTaskSkills(fresh)).toEqual([]);
    });
  });

  describe('buildSkillsInstructionsBlock', () => {
    it('returns empty string when no bindings and no suggestions', () => {
      const task = createTask({ title: 'qqqq zzzz' });
      expect(buildSkillsInstructionsBlock(task)).toBe('');
    });

    it('renders bound + suggested when bindings exist', () => {
      const task = createTask({ title: 'Build the pitch deck' });
      setTaskSkills(task.id, ['anthropic-skills:pptx']);
      const fresh = getTask(task.id);
      expect(fresh).not.toBeNull();
      const block = buildSkillsInstructionsBlock(
        fresh as NonNullable<typeof fresh>,
      );
      expect(block).toContain('---SKILLS---');
      expect(block).toContain('anthropic-skills:pptx');
      expect(block).toContain('Bound skills');
    });
  });
});
