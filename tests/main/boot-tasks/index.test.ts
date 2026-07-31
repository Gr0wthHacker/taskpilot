/**
 * Tests for the boot-tasks subsystem — seeding, due-detection, firing,
 * and idempotence on a same-day re-fire.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  fireBootTasksIfDue,
  isBootTasksDue,
  readBootTasks,
  seedDefaultBootTasksIfEmpty,
  SETTING_BOOT_TASKS_ENABLED,
  SETTING_BOOT_TASKS_LAST_RUN,
  writeBootTasks,
} from '@/main/boot-tasks';
import { listTasks } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';

describe('boot-tasks', () => {
  beforeEach(() => {
    // Each useMockedDb test gets a fresh in-memory DB, so settings are empty.
  });
  afterEach(() => {
    // No cleanup needed — DB is dropped between tests by useMockedDb().
  });

  it('seeds the default templates on empty DB', () => {
    const seeded = seedDefaultBootTasksIfEmpty();
    expect(seeded.length).toBeGreaterThanOrEqual(3);
    expect(seeded.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        'drain-updates-drafts',
        'refresh-business-snapshots',
        'sweep-stalled-tasks',
      ]),
    );
  });

  it('idempotent — second seed is a no-op when templates already exist', () => {
    seedDefaultBootTasksIfEmpty();
    const before = readBootTasks();
    writeBootTasks([{ id: 'custom', label: 'X', prompt: 'do X' }]);
    const seeded = seedDefaultBootTasksIfEmpty();
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.id).toBe('custom');
    expect(before).not.toEqual(seeded);
  });

  it('isBootTasksDue returns true on a fresh DB', () => {
    expect(isBootTasksDue()).toBe(true);
  });

  it('fireBootTasksIfDue creates one task per template and marks today done', () => {
    const result = fireBootTasksIfDue();
    expect(result.fired).toBeGreaterThanOrEqual(3);
    expect(result.skipped_reason).toBeNull();
    const tasks = listTasks({ tag: 'boot-task' });
    expect(tasks).toHaveLength(result.fired);
    for (const t of tasks) {
      expect(t.agent_executable).toBe(true);
      expect(t.agent_method).toBe('cli');
      expect(t.status).toBe('queued');
      const ctx = (t.context ?? {}) as Record<string, unknown>;
      expect(ctx.boot_task).toBe(true);
      expect(typeof ctx.confidence_threshold).toBe('number');
    }
  });

  it('idempotent on same-day re-fire — second call skips with "not_due"', () => {
    const first = fireBootTasksIfDue();
    expect(first.fired).toBeGreaterThanOrEqual(3);
    const initialCount = listTasks({ tag: 'boot-task' }).length;
    const second = fireBootTasksIfDue();
    expect(second.fired).toBe(0);
    expect(second.skipped_reason).toBe('not_due');
    expect(listTasks({ tag: 'boot-task' })).toHaveLength(initialCount);
  });

  it('skips when disabled via setting', () => {
    settingsRepository.set(SETTING_BOOT_TASKS_ENABLED, false);
    const result = fireBootTasksIfDue();
    expect(result.fired).toBe(0);
    expect(result.skipped_reason).toBe('disabled');
    expect(listTasks({ tag: 'boot-task' })).toHaveLength(0);
  });

  it('fires again when last_run is from yesterday', () => {
    fireBootTasksIfDue();
    const firstCount = listTasks({ tag: 'boot-task' }).length;
    settingsRepository.set(SETTING_BOOT_TASKS_LAST_RUN, '2020-01-01');
    expect(isBootTasksDue()).toBe(true);
    const second = fireBootTasksIfDue();
    expect(second.fired).toBeGreaterThanOrEqual(3);
    expect(listTasks({ tag: 'boot-task' })).toHaveLength(firstCount + second.fired);
  });

  it('honors a custom templates list with custom thresholds', () => {
    writeBootTasks([
      {
        id: 'custom-x',
        label: 'Do X',
        prompt: 'instructions',
        confidence_threshold: 0.95,
      },
    ]);
    const result = fireBootTasksIfDue();
    expect(result.fired).toBe(1);
    const tasks = listTasks({ tag: 'boot-task' });
    expect(tasks).toHaveLength(1);
    const ctx = (tasks[0]!.context ?? {}) as Record<string, unknown>;
    expect(ctx.confidence_threshold).toBe(0.95);
  });
});
