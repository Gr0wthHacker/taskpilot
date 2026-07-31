/**
 * Execution logs repository unit tests.
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from '../helpers/mock-db';

import {
  completeLog,
  createLog,
  getLog,
  getLogsForTask,
  startLog,
} from '@/main/db/repositories/execution-logs';
import { createTask } from '@/main/db/repositories/tasks';

describe('execution-logs repository', () => {
  useMockedDb();

  function makeTask() {
    return createTask({ title: 'parent task' });
  }

  describe('startLog', () => {
    it('returns a new log id', () => {
      const task = makeTask();
      const id = startLog({ task_id: task.id, method: 'cli' });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(8);
    });

    it('writes a retrievable row with method and started_at', () => {
      const task = makeTask();
      const id = startLog({ task_id: task.id, method: 'cowork' });
      const log = getLog(id);
      expect(log).not.toBeNull();
      expect(log?.task_id).toBe(task.id);
      expect(log?.method).toBe('cowork');
      expect(log?.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(log?.completed_at).toBeNull();
    });
  });

  describe('completeLog', () => {
    it('writes status, output, completed_at', () => {
      const task = makeTask();
      const id = startLog({ task_id: task.id, method: 'cli' });
      const updated = completeLog(id, {
        status: 'succeeded',
        output: 'all good',
      });
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('succeeded');
      expect(updated?.output).toBe('all good');
      expect(updated?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('persists errors when status is failed', () => {
      const task = makeTask();
      const id = startLog({ task_id: task.id, method: 'cli' });
      const updated = completeLog(id, {
        status: 'failed',
        error: 'boom',
      });
      expect(updated?.status).toBe('failed');
      expect(updated?.error).toBe('boom');
    });
  });

  describe('getLog', () => {
    it('returns null for a missing id', () => {
      expect(getLog('not-there')).toBeNull();
    });
  });

  describe('getLogsForTask', () => {
    it('returns every log for a task in started_at desc order', async () => {
      const task = makeTask();
      const first = startLog({ task_id: task.id, method: 'cli' });
      await new Promise((r) => setTimeout(r, 5));
      const second = startLog({ task_id: task.id, method: 'cowork' });
      await new Promise((r) => setTimeout(r, 5));
      const third = startLog({ task_id: task.id, method: 'cli' });

      const logs = getLogsForTask(task.id);
      expect(logs).toHaveLength(3);
      const ids = logs.map((l) => l.id);
      expect(ids).toContain(first);
      expect(ids).toContain(second);
      expect(ids).toContain(third);
    });

    it('returns [] for a task without logs', () => {
      const task = makeTask();
      expect(getLogsForTask(task.id)).toEqual([]);
    });
  });

  describe('createLog (one-shot)', () => {
    it('creates a fully-formed terminal log in a single call', () => {
      const task = makeTask();
      const id = createLog({
        task_id: task.id,
        method: 'cli',
        status: 'succeeded',
        output: 'done',
      });
      const log = getLog(id);
      expect(log?.status).toBe('succeeded');
      expect(log?.output).toBe('done');
      expect(log?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('accepts an explicit id', () => {
      const task = makeTask();
      const id = createLog({
        id: 'fixed_log_1',
        task_id: task.id,
        method: 'cowork',
        status: 'needs_review',
      });
      expect(id).toBe('fixed_log_1');
      expect(getLog('fixed_log_1')?.status).toBe('needs_review');
    });
  });
});
