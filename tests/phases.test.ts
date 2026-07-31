/**
 * Phase / pipeline module tests (Wave 15).
 *
 * Coverage:
 *   - Default pipelines seeded on first read
 *   - Custom pipeline CRUD round-trip
 *   - resolvePipelineForTask: explicit override, tag match, default fallback
 *   - resolveNextPhase / resolvePreviousPhase boundary cases
 *   - setTaskPhase persists onto task.context.phase
 *   - advancePhase / regressPhase walk the pipeline correctly
 *   - Tasks without a pipeline get null assignment cleanly
 */

import { describe, expect, it } from 'vitest';

import { useMockedDb } from './helpers/mock-db';

import {
  advancePhase,
  DEFAULT_PIPELINES,
  deletePipeline,
  getPhaseAssignment,
  listPipelines,
  PIPELINE_CONTEXT_KEY,
  readTaskPhase,
  regressPhase,
  resetPipelines,
  resolveNextPhase,
  resolvePhaseDefinition,
  resolvePipelineForTask,
  resolvePreviousPhase,
  setTaskPhase,
  upsertPipeline,
} from '@/main/phases';
import {
  createTask,
  getTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import type { Pipeline } from '@/shared/types';

function seed(title: string, tags: string[] = []): string {
  return createTask({ title, tags }).id;
}

describe('phases', () => {
  useMockedDb();

  describe('listPipelines', () => {
    it('seeds the default catalog on first read', () => {
      const pipelines = listPipelines();
      const ids = pipelines.map((p) => p.id);
      expect(ids).toContain('code');
      expect(ids).toContain('content');
      expect(ids).toContain('meeting');
      expect(ids).toContain('deal');
      expect(ids).toContain('personal');
    });

    it('persists the seeded list so subsequent reads are stable', () => {
      const first = listPipelines();
      const second = listPipelines();
      expect(second.length).toBe(first.length);
      expect(second[0]?.id).toBe(first[0]?.id);
    });

    it('default pipelines have a default fallback', () => {
      const pipelines = listPipelines();
      const hasDefault = pipelines.some((p) => p.default);
      expect(hasDefault).toBe(true);
    });
  });

  describe('CRUD', () => {
    it('upsertPipeline inserts a new pipeline', () => {
      const fresh: Pipeline = {
        id: 'test',
        name: 'Test pipeline',
        phases: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      };
      const persisted = upsertPipeline(fresh);
      expect(persisted.id).toBe('test');
      const all = listPipelines();
      expect(all.find((p) => p.id === 'test')).toBeTruthy();
    });

    it('upsertPipeline updates an existing pipeline', () => {
      // Seed first.
      listPipelines();
      // Mutate the code pipeline.
      const code = listPipelines().find((p) => p.id === 'code');
      expect(code).toBeTruthy();
      const mutated: Pipeline = {
        ...(code as Pipeline),
        name: 'Engineering pipeline',
      };
      upsertPipeline(mutated);
      const reloaded = listPipelines().find((p) => p.id === 'code');
      expect(reloaded?.name).toBe('Engineering pipeline');
    });

    it('upsertPipeline rejects duplicate phase ids', () => {
      expect(() =>
        upsertPipeline({
          id: 'dup',
          name: 'Dup',
          phases: [
            { id: 'x', name: 'X1' },
            { id: 'x', name: 'X2' },
          ],
        }),
      ).toThrow(/duplicate phase id/);
    });

    it('deletePipeline removes the entry', () => {
      // Seed.
      listPipelines();
      expect(deletePipeline('content')).toBe(true);
      const all = listPipelines();
      expect(all.find((p) => p.id === 'content')).toBeUndefined();
    });

    it('deletePipeline returns false for unknown id', () => {
      expect(deletePipeline('nope')).toBe(false);
    });

    it('resetPipelines reseeds the defaults', () => {
      // Mutate first.
      listPipelines();
      deletePipeline('content');
      expect(listPipelines().find((p) => p.id === 'content')).toBeUndefined();
      resetPipelines();
      expect(listPipelines().find((p) => p.id === 'content')).toBeTruthy();
    });
  });

  describe('resolvePipelineForTask', () => {
    it('returns null for a null task', () => {
      expect(resolvePipelineForTask(null)).toBeNull();
    });

    it('picks the code pipeline for a task tagged "code"', () => {
      const id = seed('Build the feature', ['code']);
      const task = getTask(id);
      const pipeline = resolvePipelineForTask(task);
      expect(pipeline?.id).toBe('code');
    });

    it('picks the content pipeline for a task tagged "content"', () => {
      const id = seed('Write the post', ['content']);
      const task = getTask(id);
      const pipeline = resolvePipelineForTask(task);
      expect(pipeline?.id).toBe('content');
    });

    it('honors the explicit context.pipeline_id override', () => {
      const id = seed('Mystery task', ['code']);
      // Explicit override wins over the tag match.
      const task = getTask(id);
      updateTask(id, {
        context: {
          ...(task?.context ?? {}),
          [PIPELINE_CONTEXT_KEY]: 'meeting',
        },
      });
      const refreshed = getTask(id);
      const pipeline = resolvePipelineForTask(refreshed);
      expect(pipeline?.id).toBe('meeting');
    });

    it('falls back to the default pipeline when no tag matches', () => {
      const id = seed('Random task', ['totally-unmapped-tag']);
      const task = getTask(id);
      const pipeline = resolvePipelineForTask(task);
      expect(pipeline?.id).toBe('personal');
      expect(pipeline?.default).toBe(true);
    });
  });

  describe('resolveNextPhase / resolvePreviousPhase', () => {
    it('returns the first phase for an unphased task', () => {
      const id = seed('Code task', ['code']);
      const task = getTask(id);
      const next = resolveNextPhase(task);
      expect(next?.id).toBe('research');
    });

    it('walks forward through the pipeline', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'spec');
      const task = getTask(id);
      const next = resolveNextPhase(task);
      expect(next?.id).toBe('implement');
    });

    it('returns null at the terminal phase', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'verify');
      const task = getTask(id);
      const next = resolveNextPhase(task);
      expect(next).toBeNull();
    });

    it('walks backward through the pipeline', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'implement');
      const task = getTask(id);
      const prev = resolvePreviousPhase(task);
      expect(prev?.id).toBe('spec');
    });

    it('returns null when already at the first phase', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'research');
      const task = getTask(id);
      const prev = resolvePreviousPhase(task);
      expect(prev).toBeNull();
    });

    it('returns null for tasks with a stale phase id', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'nonexistent');
      const task = getTask(id);
      // Stale assigned phase — resolver bails cleanly.
      const next = resolveNextPhase(task);
      expect(next).toBeNull();
    });
  });

  describe('setTaskPhase', () => {
    it('writes the phase id onto task.context.phase', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'implement');
      const task = getTask(id);
      expect(readTaskPhase(task)).toBe('implement');
    });

    it('clears the phase when given null', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'implement');
      setTaskPhase(id, null);
      const task = getTask(id);
      expect(readTaskPhase(task)).toBeNull();
    });

    it('writes the pipeline_id override when supplied', () => {
      const id = seed('Mystery', ['code']);
      setTaskPhase(id, 'a', 'custom-pipeline');
      const task = getTask(id);
      const ctx = task?.context as Record<string, unknown> | null;
      expect(ctx?.[PIPELINE_CONTEXT_KEY]).toBe('custom-pipeline');
    });

    it('clears the pipeline_id override when passed null', () => {
      const id = seed('Mystery', ['code']);
      setTaskPhase(id, 'a', 'custom-pipeline');
      setTaskPhase(id, 'a', null);
      const task = getTask(id);
      const ctx = task?.context as Record<string, unknown> | null;
      expect(ctx?.[PIPELINE_CONTEXT_KEY]).toBeUndefined();
    });

    it('returns null for a missing task', () => {
      expect(setTaskPhase('nope1234', 'a')).toBeNull();
    });

    it('returned assignment includes resolved phase_definition', () => {
      const id = seed('Code task', ['code']);
      const assignment = setTaskPhase(id, 'spec');
      expect(assignment?.pipeline?.id).toBe('code');
      expect(assignment?.phase).toBe('spec');
      expect(assignment?.phase_definition?.id).toBe('spec');
      expect(assignment?.phase_definition?.name).toBe('Spec');
    });
  });

  describe('advancePhase / regressPhase', () => {
    it('advancePhase walks from research → spec → implement', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'research');
      const after = advancePhase(id);
      expect(after?.phase).toBe('spec');
      const after2 = advancePhase(id);
      expect(after2?.phase).toBe('implement');
    });

    it('advancePhase starts from the first phase when unphased', () => {
      const id = seed('Code task', ['code']);
      const after = advancePhase(id);
      expect(after?.phase).toBe('research');
    });

    it('advancePhase returns null at the terminal phase', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'verify');
      expect(advancePhase(id)).toBeNull();
    });

    it('regressPhase walks backward through the pipeline', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'implement');
      const after = regressPhase(id);
      expect(after?.phase).toBe('spec');
    });

    it('regressPhase returns null at the first phase', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'research');
      expect(regressPhase(id)).toBeNull();
    });

    it('returns null for a task with no pipeline', () => {
      // Make sure no `default: true` pipeline can serve as a fallback so the
      // resolver actually returns null. Strip the default flag from every
      // seeded pipeline (rather than deleting the row, which the editor may
      // refill on next read).
      for (const p of listPipelines()) {
        if (p.default) upsertPipeline({ ...p, default: false });
      }
      const id = seed('Untagged');
      expect(advancePhase(id)).toBeNull();
      expect(regressPhase(id)).toBeNull();
    });
  });

  describe('getPhaseAssignment', () => {
    it('returns null for unknown task ids', () => {
      expect(getPhaseAssignment('nope1234')).toBeNull();
    });

    it('returns full resolved view for a phased task', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'review');
      const view = getPhaseAssignment(id);
      expect(view?.task_id).toBe(id);
      expect(view?.pipeline?.id).toBe('code');
      expect(view?.phase).toBe('review');
      expect(view?.phase_definition?.name).toBe('Review');
    });

    it('returns null phase definition when phase id is stale', () => {
      const id = seed('Code task', ['code']);
      setTaskPhase(id, 'ghost-phase');
      const view = getPhaseAssignment(id);
      expect(view?.phase).toBe('ghost-phase');
      expect(view?.phase_definition).toBeNull();
    });

    it('returns null pipeline when nothing matches and no default exists', () => {
      // Remove the default fallback.
      const all = listPipelines();
      for (const p of all) {
        upsertPipeline({ ...p, default: false });
      }
      const id = seed('Untagged');
      const view = getPhaseAssignment(id);
      expect(view?.pipeline).toBeNull();
      expect(view?.phase).toBeNull();
      expect(view?.phase_definition).toBeNull();
    });
  });

  describe('resolvePhaseDefinition', () => {
    it('looks up the definition by id', () => {
      const id = seed('Content task', ['content']);
      setTaskPhase(id, 'draft');
      const task = getTask(id);
      const pipeline = resolvePipelineForTask(task);
      const def = resolvePhaseDefinition(task, pipeline);
      expect(def?.id).toBe('draft');
      expect(def?.name).toBe('Draft');
    });

    it('returns null when the phase id is not in the pipeline', () => {
      const id = seed('Content task', ['content']);
      setTaskPhase(id, 'spec');
      // 'spec' belongs to the code pipeline, but the task is content-tagged.
      const task = getTask(id);
      const pipeline = resolvePipelineForTask(task);
      const def = resolvePhaseDefinition(task, pipeline);
      expect(def).toBeNull();
    });
  });

  describe('default pipelines metadata', () => {
    it('all default pipelines have at least one phase', () => {
      for (const pipeline of DEFAULT_PIPELINES) {
        expect(pipeline.phases.length).toBeGreaterThan(0);
      }
    });

    it('all default pipelines have a terminal phase', () => {
      for (const pipeline of DEFAULT_PIPELINES) {
        const hasTerminal = pipeline.phases.some((p) => p.is_terminal);
        expect(hasTerminal).toBe(true);
      }
    });

    it('code pipeline matches the documented order', () => {
      const code = DEFAULT_PIPELINES.find((p) => p.id === 'code');
      expect(code?.phases.map((p) => p.id)).toEqual([
        'research',
        'spec',
        'implement',
        'review',
        'deploy',
        'verify',
      ]);
    });

    it('content pipeline matches the documented order', () => {
      const content = DEFAULT_PIPELINES.find((p) => p.id === 'content');
      expect(content?.phases.map((p) => p.id)).toEqual([
        'outline',
        'draft',
        'revise',
        'publish',
        'distribute',
      ]);
    });
  });
});
