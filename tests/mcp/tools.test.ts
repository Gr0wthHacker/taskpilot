/**
 * MCP tool handler tests.
 *
 * Each tool wraps a slice of repos / I/O / calendar. We mock the underlying
 * modules so we can verify the tool's input schema parses correctly and the
 * handler produces the right shape.
 *
 * Tools touched:
 *   - taskpilot_list_tasks, _get_task, _create_task, _update_task,
 *     _derive_task, _execute_task, _agent_status
 *   - taskpilot_calendar_events, _calendar_availability, _calendar_create_event
 *   - taskpilot_io_pending, _io_read, _io_write_result
 */

import { describe, expect, it, vi } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';

const PATHS = mockTaskpilotPaths();

// Repository mocks. Each tool calls these directly, so we stub out the modules
// rather than relying on a real DB.
vi.mock('@/main/db/repositories/tasks', () => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  getChildren: vi.fn(),
  // Hooks consumed by side-effect imports (`@/main/attachments`,
  // `@/main/links`, `@/main/recurrence`, etc.) pulled in transitively when
  // the tool registry is loaded.
  registerOnTaskPreDelete: vi.fn(),
  addOnTaskWritten: vi.fn(),
  addOnTaskDeleted: vi.fn(),
}));
vi.mock('@/main/db/repositories/execution-logs', () => ({
  getLogsForTask: vi.fn(),
}));

// Calendar mocks — full surface for the calendar tools.
vi.mock('@/main/calendar', () => ({
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  getAvailability: vi.fn(),
  isAuthenticated: vi.fn(),
  CalendarNotConfiguredError: class extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CalendarNotConfiguredError';
    }
  },
}));

// Protocol mocks — derive/execute tools write files via these.
vi.mock('@/main/io/protocol', () => ({
  writeDeriveRequest: vi.fn(),
  writeExecuteRequest: vi.fn(),
}));

import {
  createTask,
  getChildren,
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';
import { getLogsForTask } from '@/main/db/repositories/execution-logs';
import {
  createEvent,
  getAvailability,
  isAuthenticated,
  listEvents,
} from '@/main/calendar';
import {
  writeDeriveRequest,
  writeExecuteRequest,
} from '@/main/io/protocol';
import { tools } from '@/main/mcp/tool-registry';
import type { Task } from '@/shared/types';

function findTool(name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool ${name} not registered`);
  return t;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const base: Task = {
    id: 'mcp_t1',
    title: 'mcp task',
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
    created_at: '2026-05-26T08:00:00Z',
    updated_at: '2026-05-26T08:00:00Z',
  };
  return { ...base, ...overrides };
}

describe('mcp tools — registry', () => {
  it('includes the expected tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('taskpilot_list_tasks');
    expect(names).toContain('taskpilot_get_task');
    expect(names).toContain('taskpilot_create_task');
    expect(names).toContain('taskpilot_update_task');
    expect(names).toContain('taskpilot_derive_task');
    expect(names).toContain('taskpilot_execute_task');
    expect(names).toContain('taskpilot_agent_status');
    expect(names).toContain('taskpilot_calendar_events');
    expect(names).toContain('taskpilot_calendar_availability');
    expect(names).toContain('taskpilot_calendar_create_event');
    expect(names).toContain('taskpilot_io_pending');
    expect(names).toContain('taskpilot_io_read');
    expect(names).toContain('taskpilot_io_write_result');
  });

  it('every tool has a Zod input schema', () => {
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      // Smoke: every schema can be safeParsed (it's a Zod object).
      expect(typeof t.inputSchema.safeParse).toBe('function');
    }
  });

  it('every tool has a non-empty description', () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });
});

describe('mcp tools — task tools', () => {
  it('list_tasks: parses input and returns { tasks, count }', async () => {
    vi.mocked(listTasks).mockReturnValue([makeTask()]);
    const tool = findTool('taskpilot_list_tasks');
    const parsed = tool.inputSchema.parse({ status: 'inbox' });
    const result = (await tool.handler(parsed)) as { tasks: Task[]; count: number };
    expect(result.tasks).toHaveLength(1);
    expect(result.count).toBe(1);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'inbox' }),
    );
  });

  it('list_tasks: agent_executable maps to filter.agent_only', async () => {
    vi.mocked(listTasks).mockReturnValue([]);
    const tool = findTool('taskpilot_list_tasks');
    await tool.handler({ agent_executable: true });
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_only: true }),
    );
  });

  it('get_task: returns the task by id', async () => {
    const t = makeTask({ id: 'get_xyz' });
    vi.mocked(getTask).mockReturnValue(t);
    const tool = findTool('taskpilot_get_task');
    const result = (await tool.handler({ id: 'get_xyz' })) as { task: Task };
    expect(result.task.id).toBe('get_xyz');
  });

  it('get_task: throws when task is missing', async () => {
    vi.mocked(getTask).mockReturnValue(null);
    const tool = findTool('taskpilot_get_task');
    await expect(tool.handler({ id: 'missing' })).rejects.toThrow(/not found/);
  });

  it('create_task: calls repo with defaulted values', async () => {
    const t = makeTask({ id: 'new_id', title: 'new task' });
    vi.mocked(createTask).mockReturnValue(t);
    const tool = findTool('taskpilot_create_task');
    const result = (await tool.handler({ title: 'new task' })) as { task: Task };
    expect(result.task.title).toBe('new task');
    expect(vi.mocked(createTask)).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'new task',
        priority: 'p2',
        agent_method: 'human_only',
      }),
    );
  });

  it('update_task: strips undefineds and calls repo', async () => {
    const t = makeTask({ id: 'upd_id' });
    vi.mocked(updateTask).mockReturnValue(t);
    const tool = findTool('taskpilot_update_task');
    await tool.handler({ id: 'upd_id', status: 'done' });
    const lastCall = vi.mocked(updateTask).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('upd_id');
    expect(lastCall?.[1]).toEqual({ status: 'done' });
  });

  it('update_task: throws when task missing', async () => {
    vi.mocked(updateTask).mockReturnValue(null);
    const tool = findTool('taskpilot_update_task');
    await expect(
      tool.handler({ id: 'gone', status: 'done' }),
    ).rejects.toThrow(/not found/);
  });

  it('derive_task: writes a derive request and flips agent_status to assigned', async () => {
    const t = makeTask({ id: 'der_id', tags: ['work'] });
    vi.mocked(getTask).mockReturnValue(t);
    vi.mocked(listTasks).mockReturnValue([]);
    vi.mocked(getChildren).mockReturnValue([]);
    vi.mocked(writeDeriveRequest).mockResolvedValue('/path/to/derive.json');
    const tool = findTool('taskpilot_derive_task');
    const result = (await tool.handler({ id: 'der_id' })) as {
      task_id: string;
      file_path: string;
      message: string;
    };
    expect(result.task_id).toBe('der_id');
    expect(result.file_path).toBe('/path/to/derive.json');
    expect(vi.mocked(writeDeriveRequest)).toHaveBeenCalled();
    expect(vi.mocked(updateTask)).toHaveBeenCalledWith('der_id', {
      agent_status: 'assigned',
    });
  });

  it('derive_task: refuses when parent already has non-cancelled children', async () => {
    const t = makeTask({ id: 'der_parent' });
    vi.mocked(getTask).mockReturnValue(t);
    vi.mocked(getChildren).mockReturnValue([
      makeTask({ id: 'child_1', status: 'queued' }),
    ]);
    vi.mocked(writeDeriveRequest).mockClear();
    const tool = findTool('taskpilot_derive_task');
    await expect(tool.handler({ id: 'der_parent' })).rejects.toThrow(
      /already has 1 non-cancelled/,
    );
    expect(vi.mocked(writeDeriveRequest)).not.toHaveBeenCalled();
  });

  it('execute_task: writes an execute request', async () => {
    const t = makeTask({ id: 'exe_id' });
    vi.mocked(getTask).mockReturnValue(t);
    vi.mocked(writeExecuteRequest).mockResolvedValue('/path/to/execute.json');
    const tool = findTool('taskpilot_execute_task');
    const result = (await tool.handler({ id: 'exe_id' })) as {
      task_id: string;
      file_path: string;
    };
    expect(result.task_id).toBe('exe_id');
    expect(result.file_path).toBe('/path/to/execute.json');
    expect(vi.mocked(writeExecuteRequest)).toHaveBeenCalled();
  });

  it('agent_status (single task): returns logs + children count', async () => {
    const t = makeTask({ id: 'as_id', agent_status: 'running' });
    vi.mocked(getTask).mockReturnValue(t);
    vi.mocked(getChildren).mockReturnValue([makeTask({ id: 'c1' })]);
    vi.mocked(getLogsForTask).mockReturnValue([]);
    const tool = findTool('taskpilot_agent_status');
    const result = (await tool.handler({ task_id: 'as_id' })) as {
      children_count: number;
      agent_status: string;
    };
    expect(result.agent_status).toBe('running');
    expect(result.children_count).toBe(1);
  });

  it('agent_status (no args): returns active pipeline tasks', async () => {
    const active = makeTask({ id: 'a', agent_status: 'running' });
    const inactive = makeTask({ id: 'b', agent_status: 'pending' });
    vi.mocked(listTasks).mockReturnValue([active, inactive]);
    const tool = findTool('taskpilot_agent_status');
    const result = (await tool.handler({})) as { count: number };
    expect(result.count).toBe(1);
  });
});

describe('mcp tools — calendar tools', () => {
  it('events: throws CalendarNotConfiguredError when not authenticated', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    const tool = findTool('taskpilot_calendar_events');
    await expect(tool.handler({})).rejects.toThrow(/not configured/i);
  });

  it('events: returns events when authenticated', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    vi.mocked(listEvents).mockResolvedValue([]);
    const tool = findTool('taskpilot_calendar_events');
    const result = (await tool.handler({})) as { count: number };
    expect(result.count).toBe(0);
  });

  it('availability: rejects non-positive durations', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    const tool = findTool('taskpilot_calendar_availability');
    await expect(
      tool.handler({
        from: '2026-05-26T09:00:00Z',
        to: '2026-05-26T17:00:00Z',
        duration_minutes: 0,
      }),
    ).rejects.toThrow(/positive/);
  });

  it('availability: returns slots when authenticated', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    vi.mocked(getAvailability).mockResolvedValue([
      { start: '2026-05-26T09:00:00Z', end: '2026-05-26T10:00:00Z' },
    ]);
    const tool = findTool('taskpilot_calendar_availability');
    const result = (await tool.handler({
      from: '2026-05-26T09:00:00Z',
      to: '2026-05-26T17:00:00Z',
      duration_minutes: 30,
    })) as { count: number };
    expect(result.count).toBe(1);
  });

  it('create_event: passes through to createEvent', async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(true);
    vi.mocked(createEvent).mockResolvedValue({
      id: 'evt_1',
      summary: 'Test',
      description: null,
      start: '2026-05-26T09:00:00Z',
      end: '2026-05-26T10:00:00Z',
      attendees: [],
      extendedProperties: { private: {}, shared: {} },
      updated: null,
      taskId: null,
    });
    const tool = findTool('taskpilot_calendar_create_event');
    const result = (await tool.handler({
      summary: 'Test',
      start: '2026-05-26T09:00:00Z',
      end: '2026-05-26T10:00:00Z',
    })) as { event: { id: string } };
    expect(result.event.id).toBe('evt_1');
  });
});

describe('mcp tools — io tools', () => {
  it('io_pending: returns empty arrays when nothing pending', async () => {
    const tool = findTool('taskpilot_io_pending');
    const result = (await tool.handler({})) as {
      derive: unknown[];
      execute: unknown[];
      counts: { derive: number; execute: number };
    };
    expect(result.counts.derive).toBe(0);
    expect(result.counts.execute).toBe(0);
  });

  it('io_pending: surfaces files in IO_DERIVE and IO_EXECUTE', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(
      path.join(PATHS.IO_DERIVE, 'task_1.json'),
      '{}',
      'utf8',
    );
    await fs.writeFile(
      path.join(PATHS.IO_EXECUTE, 'task_2.json'),
      '{}',
      'utf8',
    );
    const tool = findTool('taskpilot_io_pending');
    const result = (await tool.handler({})) as {
      counts: { derive: number; execute: number };
    };
    expect(result.counts.derive).toBeGreaterThanOrEqual(1);
    expect(result.counts.execute).toBeGreaterThanOrEqual(1);
  });

  it('io_read: throws when neither derive nor execute file exists', async () => {
    const tool = findTool('taskpilot_io_read');
    await expect(tool.handler({ task_id: 'absent_xyz' })).rejects.toThrow(
      /No derive\/ or execute\/ request/,
    );
  });

  it('io_write_result: writes result.json and returns paths', async () => {
    const tool = findTool('taskpilot_io_write_result');
    const result = (await tool.handler({
      task_id: 'wr_t1',
      result: {
        task_id: 'wr_t1',
        status: 'succeeded',
        completed_at: '2026-05-26T13:00:00Z',
        summary: 'ok',
        output_files: [],
      },
    })) as { ok: boolean; result_path: string };
    expect(result.ok).toBe(true);
    const fs = await import('node:fs');
    expect(fs.existsSync(result.result_path)).toBe(true);
  });
});
