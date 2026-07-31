/**
 * Zod schema validation tests for `src/shared/io-schemas.ts`.
 *
 * Covers happy-path validation and a representative rejection case for each
 * exported schema. Schemas are what the I/O watcher uses to gate ingestion,
 * so any drift here would let malformed JSON into the DB.
 */

import { describe, expect, it } from 'vitest';

import {
  agentMethodSchema,
  agentStatusSchema,
  derivationRequestSchema,
  derivationResponseSchema,
  derivativeProposalSchema,
  executionMethodSchema,
  executionRequestSchema,
  executionResultSchema,
  executionStatusSchema,
  taskPrioritySchema,
  taskSchema,
  taskStatusSchema,
} from '@/shared/io-schemas';

describe('io-schemas', () => {
  describe('enum schemas', () => {
    it('accepts valid task status values', () => {
      for (const v of ['inbox', 'queued', 'in_progress', 'blocked', 'done', 'failed']) {
        expect(taskStatusSchema.parse(v)).toBe(v);
      }
    });

    it('rejects invalid task status', () => {
      expect(taskStatusSchema.safeParse('bogus').success).toBe(false);
    });

    it('accepts valid priorities', () => {
      for (const v of ['p0', 'p1', 'p2', 'p3']) {
        expect(taskPrioritySchema.parse(v)).toBe(v);
      }
    });

    it('rejects p4', () => {
      expect(taskPrioritySchema.safeParse('p4').success).toBe(false);
    });

    it('accepts valid agent methods and rejects unknown', () => {
      expect(agentMethodSchema.parse('cli')).toBe('cli');
      expect(agentMethodSchema.parse('cowork')).toBe('cowork');
      expect(agentMethodSchema.safeParse('something').success).toBe(false);
    });

    it('accepts valid agent statuses and rejects unknown', () => {
      expect(agentStatusSchema.parse('running')).toBe('running');
      expect(agentStatusSchema.safeParse('pending_review').success).toBe(false);
    });

    it('accepts valid execution methods and rejects unknown', () => {
      expect(executionMethodSchema.parse('cli')).toBe('cli');
      expect(executionMethodSchema.safeParse('either').success).toBe(false);
    });

    it('accepts valid execution statuses and rejects unknown', () => {
      expect(executionStatusSchema.parse('succeeded')).toBe('succeeded');
      expect(executionStatusSchema.safeParse('done').success).toBe(false);
    });
  });

  describe('taskSchema', () => {
    const validTask = {
      id: 'abc',
      title: 'Do thing',
      description: null,
      status: 'inbox',
      priority: 'p2',
      due: null,
      calendar_event_id: null,
      parent_id: null,
      agent_executable: false,
      agent_method: 'human_only',
      agent_instructions: null,
      agent_status: 'pending',
      context: null,
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    it('accepts a minimal valid task', () => {
      const parsed = taskSchema.parse(validTask);
      expect(parsed.id).toBe('abc');
    });

    it('accepts complex context and tags', () => {
      const t = {
        ...validTask,
        context: { foo: 'bar', count: 1 },
        tags: ['x', 'y'],
      };
      expect(taskSchema.parse(t).context).toEqual({ foo: 'bar', count: 1 });
    });

    it('rejects empty id', () => {
      expect(taskSchema.safeParse({ ...validTask, id: '' }).success).toBe(false);
    });

    it('rejects empty title', () => {
      expect(taskSchema.safeParse({ ...validTask, title: '' }).success).toBe(false);
    });

    it('rejects missing required field', () => {
      const { status, ...rest } = validTask;
      void status;
      expect(taskSchema.safeParse(rest).success).toBe(false);
    });

    it('rejects wrong type for tags', () => {
      expect(
        taskSchema.safeParse({ ...validTask, tags: 'not-an-array' }).success,
      ).toBe(false);
    });
  });

  describe('derivationRequestSchema', () => {
    const validRequest = {
      request_type: 'derive',
      task: {
        id: 't1',
        title: 'Plan launch',
        description: null,
        priority: 'p1',
        due: null,
        tags: [],
      },
      context: {
        calendar_snapshot: '{}',
        related_tasks: [],
        available_tools: ['cowork'],
        execution_modes: ['cowork', 'cli'],
      },
      instructions: 'Do the thing',
    };

    it('accepts a well-formed derivation request', () => {
      expect(derivationRequestSchema.parse(validRequest)).toMatchObject({
        request_type: 'derive',
      });
    });

    it('rejects wrong request_type literal', () => {
      expect(
        derivationRequestSchema.safeParse({
          ...validRequest,
          request_type: 'execute',
        }).success,
      ).toBe(false);
    });

    it('rejects invalid execution_modes', () => {
      expect(
        derivationRequestSchema.safeParse({
          ...validRequest,
          context: { ...validRequest.context, execution_modes: ['human_only'] },
        }).success,
      ).toBe(false);
    });
  });

  describe('derivativeProposalSchema', () => {
    const valid = {
      title: 'Subtask',
      agent_executable: true,
      agent_method: 'cli' as const,
      agent_instructions: 'run X',
      estimated_minutes: 30,
      depends_on: [],
      review_required: false,
    };

    it('accepts a valid proposal', () => {
      expect(derivativeProposalSchema.parse(valid)).toMatchObject({
        title: 'Subtask',
      });
    });

    it('rejects negative estimated_minutes', () => {
      expect(
        derivativeProposalSchema.safeParse({ ...valid, estimated_minutes: -5 })
          .success,
      ).toBe(false);
    });

    it('rejects non-integer estimated_minutes', () => {
      expect(
        derivativeProposalSchema.safeParse({ ...valid, estimated_minutes: 1.5 })
          .success,
      ).toBe(false);
    });

    it('accepts zero minutes', () => {
      expect(
        derivativeProposalSchema.parse({ ...valid, estimated_minutes: 0 })
          .estimated_minutes,
      ).toBe(0);
    });
  });

  describe('derivationResponseSchema', () => {
    it('accepts a response with multiple derivatives', () => {
      const resp = {
        task_id: 't1',
        derived_at: '2026-05-26T12:00:00Z',
        derivatives: [
          {
            title: 'A',
            agent_executable: false,
            agent_method: 'human_only' as const,
            agent_instructions: null,
            estimated_minutes: 10,
            depends_on: [],
            review_required: true,
          },
          {
            title: 'B',
            agent_executable: true,
            agent_method: 'cli' as const,
            agent_instructions: 'do',
            estimated_minutes: 20,
            depends_on: ['A'],
            review_required: false,
          },
        ],
      };
      expect(derivationResponseSchema.parse(resp).derivatives).toHaveLength(2);
    });

    it('accepts empty derivatives array', () => {
      expect(
        derivationResponseSchema.parse({
          task_id: 't1',
          derived_at: '2026-05-26T12:00:00Z',
          derivatives: [],
        }).derivatives,
      ).toEqual([]);
    });

    it('rejects empty task_id', () => {
      expect(
        derivationResponseSchema.safeParse({
          task_id: '',
          derived_at: '2026-05-26T12:00:00Z',
          derivatives: [],
        }).success,
      ).toBe(false);
    });
  });

  describe('executionRequestSchema', () => {
    const validTask = {
      id: 'abc',
      title: 'Do thing',
      description: null,
      status: 'inbox' as const,
      priority: 'p2' as const,
      due: null,
      calendar_event_id: null,
      parent_id: null,
      agent_executable: false,
      agent_method: 'human_only' as const,
      agent_instructions: null,
      agent_status: 'pending' as const,
      context: null,
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    it('accepts a valid execution request', () => {
      const req = {
        request_type: 'execute',
        task: validTask,
        parent_outputs: { p1: ['/path/file.txt'] },
        context: { foo: 'bar' },
        instructions: 'Execute',
      };
      expect(executionRequestSchema.parse(req).request_type).toBe('execute');
    });

    it('rejects request_type=derive', () => {
      expect(
        executionRequestSchema.safeParse({
          request_type: 'derive',
          task: validTask,
          parent_outputs: {},
          context: {},
          instructions: '',
        }).success,
      ).toBe(false);
    });
  });

  describe('executionResultSchema', () => {
    it('accepts a minimal succeeded result', () => {
      const r = {
        task_id: 'x',
        status: 'succeeded',
        completed_at: '2026-05-26T12:00:00Z',
        summary: 'all good',
        output_files: [],
      };
      expect(executionResultSchema.parse(r).status).toBe('succeeded');
    });

    it('accepts notes and error optional fields', () => {
      const r = {
        task_id: 'x',
        status: 'failed',
        completed_at: '2026-05-26T12:00:00Z',
        summary: 'oops',
        output_files: [],
        error: 'boom',
        notes: 'context',
      };
      expect(executionResultSchema.parse(r).error).toBe('boom');
    });

    it('rejects unknown status', () => {
      expect(
        executionResultSchema.safeParse({
          task_id: 'x',
          status: 'maybe',
          completed_at: '2026-05-26T12:00:00Z',
          summary: '',
          output_files: [],
        }).success,
      ).toBe(false);
    });

    it('rejects non-array output_files', () => {
      expect(
        executionResultSchema.safeParse({
          task_id: 'x',
          status: 'succeeded',
          completed_at: '2026-05-26T12:00:00Z',
          summary: '',
          output_files: 'not-an-array',
        }).success,
      ).toBe(false);
    });
  });
});
