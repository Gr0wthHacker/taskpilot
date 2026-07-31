/**
 * I/O protocol unit tests — atomic JSON read/write to the IO_* directories.
 *
 * `src/shared/constants.ts` reads `os.homedir()` at module load time, so we
 * mock the entire constants module to redirect paths into a per-test tmpdir
 * before importing anything from `@/main/io/*`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';

mockTaskpilotPaths();

// Imports must come *after* the vi.mock above.
import {
  cleanup,
  ensureResultsDir,
  readDerivedResponse,
  readExecutionResult,
  writeDeriveRequest,
  writeExecuteRequest,
  writeInbox,
  moveToReview,
} from '@/main/io/protocol';
import { derivedPath, resultPath, outputDir } from '@/main/io/paths';
import type {
  DerivationResponse,
  ExecutionResult,
  Task,
} from '@/shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = '2026-05-26T10:00:00Z';
  return {
    id: 'task_proto1',
    title: 'Protocol test task',
    description: null,
    status: 'queued',
    priority: 'p2',
    due: null,
    calendar_event_id: null,
    parent_id: null,
    agent_executable: false,
    agent_method: 'cli',
    agent_instructions: null,
    agent_status: 'pending',
    context: null,
    tags: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('protocol — writeDeriveRequest', () => {
  it('writes a valid JSON file matching the DerivationRequest schema', async () => {
    const task = makeTask({ id: 'task_derive_a' });
    const dest = await writeDeriveRequest(task, {
      calendar_snapshot: '{"events":[]}',
      related_tasks: ['other-task'],
      available_tools: ['cowork', 'cli'],
      execution_modes: ['cowork', 'cli'],
    });

    expect(fs.existsSync(dest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(parsed.request_type).toBe('derive');
    expect(parsed.task).toMatchObject({ id: 'task_derive_a' });
    expect(parsed.context).toMatchObject({
      calendar_snapshot: '{"events":[]}',
      related_tasks: ['other-task'],
      execution_modes: ['cowork', 'cli'],
    });
    expect(typeof parsed.instructions).toBe('string');
  });

  it('uses provided instructions when supplied', async () => {
    const task = makeTask({ id: 'task_derive_b' });
    const dest = await writeDeriveRequest(task, {
      calendar_snapshot: '{}',
      related_tasks: [],
      available_tools: [],
      execution_modes: ['cli'],
      instructions: 'CUSTOM',
    });
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(parsed.instructions).toBe('CUSTOM');
  });

  it('does not leave a .tmp file behind on success', async () => {
    const task = makeTask({ id: 'task_derive_c' });
    const dest = await writeDeriveRequest(task, {
      calendar_snapshot: '{}',
      related_tasks: [],
      available_tools: [],
      execution_modes: ['cli'],
    });
    expect(fs.existsSync(`${dest}.tmp`)).toBe(false);
  });
});

describe('protocol — readDerivedResponse', () => {
  it('returns null when the file does not exist', async () => {
    expect(await readDerivedResponse('nonexistent')).toBeNull();
  });

  it('round-trips a derived response written manually', async () => {
    const taskId = 'task_derived_a';
    const payload: DerivationResponse = {
      task_id: taskId,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'Step 1',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: 'run x',
          estimated_minutes: 15,
          depends_on: [],
          review_required: false,
        },
      ],
    };
    await fsp.writeFile(derivedPath(taskId), JSON.stringify(payload), 'utf8');
    const read = await readDerivedResponse(taskId);
    expect(read).toEqual(payload);
  });

  it('throws when the file fails schema validation', async () => {
    const taskId = 'task_derived_bad';
    await fsp.writeFile(
      derivedPath(taskId),
      JSON.stringify({ not: 'valid' }),
      'utf8',
    );
    await expect(readDerivedResponse(taskId)).rejects.toBeDefined();
  });
});

describe('protocol — writeExecuteRequest', () => {
  it('writes a valid execution request file', async () => {
    const task = makeTask({ id: 'task_exec_a' });
    const dest = await writeExecuteRequest(
      task,
      { parent1: ['/abs/path/file.txt'] },
      { foo: 'bar' },
      'EXEC INSTRUCTIONS',
    );
    expect(fs.existsSync(dest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(parsed.request_type).toBe('execute');
    expect(parsed.parent_outputs).toEqual({ parent1: ['/abs/path/file.txt'] });
    expect(parsed.context).toEqual({ foo: 'bar' });
    expect(parsed.instructions).toBe('EXEC INSTRUCTIONS');
  });

  it('uses default instructions when none provided', async () => {
    const task = makeTask({ id: 'task_exec_b' });
    const dest = await writeExecuteRequest(task, {}, {});
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(typeof parsed.instructions).toBe('string');
    expect((parsed.instructions as string).length).toBeGreaterThan(0);
  });
});

describe('protocol — readExecutionResult', () => {
  it('returns null when no result file exists', async () => {
    expect(await readExecutionResult('not-here')).toBeNull();
  });

  it('returns result + outputFiles for a written result', async () => {
    const taskId = 'task_result_a';
    await ensureResultsDir(taskId);
    const result: ExecutionResult = {
      task_id: taskId,
      status: 'succeeded',
      completed_at: '2026-05-26T13:00:00Z',
      summary: 'done',
      output_files: ['hello.txt'],
    };
    await fsp.writeFile(resultPath(taskId), JSON.stringify(result), 'utf8');
    await fsp.writeFile(path.join(outputDir(taskId), 'hello.txt'), 'world', 'utf8');

    const bundle = await readExecutionResult(taskId);
    expect(bundle).not.toBeNull();
    expect(bundle?.result.status).toBe('succeeded');
    expect(bundle?.outputFiles).toHaveLength(1);
    expect(bundle?.outputFiles[0]).toMatch(/hello\.txt$/);
  });
});

describe('protocol — writeInbox', () => {
  it('writes a serialized task to IO_INBOX', async () => {
    const task = makeTask({ id: 'task_inbox_a' });
    const dest = await writeInbox(task);
    expect(fs.existsSync(dest)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as Record<string, unknown>;
    expect(parsed.id).toBe('task_inbox_a');
  });
});

describe('protocol — cleanup', () => {
  it('removes derive and execute request files for a task', async () => {
    const task = makeTask({ id: 'task_cleanup_a' });
    const deriveDest = await writeDeriveRequest(task, {
      calendar_snapshot: '{}',
      related_tasks: [],
      available_tools: [],
      execution_modes: ['cli'],
    });
    const execDest = await writeExecuteRequest(task, {}, {});
    expect(fs.existsSync(deriveDest)).toBe(true);
    expect(fs.existsSync(execDest)).toBe(true);

    await cleanup(task.id);
    expect(fs.existsSync(deriveDest)).toBe(false);
    expect(fs.existsSync(execDest)).toBe(false);
  });

  it('does not throw when files are already gone', async () => {
    await expect(cleanup('nonexistent_task')).resolves.toBeUndefined();
  });
});

describe('protocol — moveToReview', () => {
  it('copies result.json to IO_REVIEW when it exists', async () => {
    const taskId = 'task_review_a';
    await ensureResultsDir(taskId);
    await fsp.writeFile(
      resultPath(taskId),
      JSON.stringify({
        task_id: taskId,
        status: 'needs_review',
        completed_at: '2026-05-26T14:00:00Z',
        summary: 'check me',
        output_files: [],
      }),
      'utf8',
    );

    const dest = await moveToReview(taskId);
    expect(dest).not.toBeNull();
    if (dest) expect(fs.existsSync(dest)).toBe(true);
  });

  it('returns null when there is no result file', async () => {
    expect(await moveToReview('no_result_here')).toBeNull();
  });
});
