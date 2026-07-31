/**
 * MCP tools for TaskPilot tasks.
 *
 * Each tool wraps a thin slice of the tasks repository or I/O protocol and
 * returns its payload as a single JSON text content block — the standard
 * format MCP clients (Claude, etc.) expect.
 *
 * Tool descriptions are written for Claude — they are the only thing the
 * model sees when deciding which tool to invoke.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  agentMethodSchema,
  agentStatusSchema,
  tagSchema,
  taskIdSchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '@/shared/io-schemas';
import {
  createTask,
  getChildren,
  getTask,
  listTasks,
  updateTask,
} from '@/main/db/repositories/tasks';
import { getLogsForTask } from '@/main/db/repositories/execution-logs';
import { contextPath, outputDir } from '@/main/io/paths';
import {
  writeDeriveRequest,
  writeExecuteRequest,
} from '@/main/io/protocol';
import type { Task, TaskFilter } from '@/shared/types';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const listTasksInput = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  agent_executable: z.boolean().optional(),
  parent_id: taskIdSchema.optional(),
  tag: tagSchema.optional(),
  limit: z.number().int().positive().max(1_000).optional(),
});

const getTaskInput = z.object({
  id: taskIdSchema,
});

const createTaskInput = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  priority: taskPrioritySchema.optional(),
  due: z.string().max(64).optional(),
  tags: z.array(tagSchema).max(64).optional(),
  agent_method: agentMethodSchema.optional(),
  agent_instructions: z.string().max(50_000).optional(),
  parent_id: taskIdSchema.optional(),
});

const updateTaskInput = z.object({
  id: taskIdSchema,
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  due: z.string().max(64).optional(),
  tags: z.array(tagSchema).max(64).optional(),
  agent_executable: z.boolean().optional(),
  agent_method: agentMethodSchema.optional(),
  agent_instructions: z.string().max(50_000).optional(),
  agent_status: agentStatusSchema.optional(),
  parent_id: taskIdSchema.optional(),
});

const deriveTaskInput = z.object({
  id: taskIdSchema,
});

const executeTaskInput = z.object({
  id: taskIdSchema,
});

const agentStatusInput = z.object({
  task_id: taskIdSchema.optional(),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function requireTask(id: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task ${id} not found`);
  return task;
}

/**
 * Read the cached calendar snapshot from `IO_CONTEXT/calendar.json`. Falls
 * back to a stub if the context refresh subsystem hasn't written one yet —
 * derivation requests should never block on calendar availability.
 */
async function readCalendarSnapshot(): Promise<string> {
  try {
    return await fs.readFile(contextPath('calendar'), 'utf8');
  } catch {
    return JSON.stringify({ events: [], note: 'calendar snapshot unavailable' });
  }
}

function findRelatedTasks(task: Task): string[] {
  if (task.tags.length === 0) return [];
  const all = listTasks({ limit: 200 });
  const related: string[] = [];
  for (const candidate of all) {
    if (candidate.id === task.id) continue;
    if (candidate.tags.some((t) => task.tags.includes(t))) {
      related.push(candidate.id);
    }
  }
  return related;
}

async function resolveParentOutputs(task: Task): Promise<Record<string, string[]>> {
  const parentIds = new Set<string>();
  if (task.parent_id) parentIds.add(task.parent_id);

  if (task.context && typeof task.context === 'object') {
    const dependsOn = (task.context as Record<string, unknown>)['depends_on'];
    if (Array.isArray(dependsOn)) {
      for (const dep of dependsOn) {
        if (typeof dep === 'string' && dep.length > 0) parentIds.add(dep);
      }
    }
  }

  const out: Record<string, string[]> = {};
  for (const parentId of parentIds) {
    const dir = outputDir(parentId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      out[parentId] = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      out[parentId] = [];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const listTasksTool: McpTool<typeof listTasksInput> = {
  name: 'taskpilot_list_tasks',
  description:
    'List TaskPilot tasks with optional filters. Use when the user asks about their tasks, todo list, or what they need to do. Filter by status (inbox/queued/in_progress/blocked/done/failed), priority (p0-p3), whether the task is agent-executable, parent id, or tag.',
  inputSchema: listTasksInput,
  async handler(input) {
    const filter: TaskFilter = {};
    if (input.status !== undefined) filter.status = input.status;
    if (input.priority !== undefined) filter.priority = input.priority;
    if (input.agent_executable !== undefined) {
      filter.agent_only = input.agent_executable;
    }
    if (input.parent_id !== undefined) filter.parent = input.parent_id;
    if (input.tag !== undefined) filter.tag = input.tag;
    if (input.limit !== undefined) filter.limit = input.limit;

    const tasks = listTasks(filter);
    return { tasks, count: tasks.length };
  },
};

const getTaskTool: McpTool<typeof getTaskInput> = {
  name: 'taskpilot_get_task',
  description:
    'Fetch the full record for a single TaskPilot task by id. Use when the user names a task or you need its details (description, agent instructions, context, tags) to take further action.',
  inputSchema: getTaskInput,
  async handler(input) {
    return { task: requireTask(input.id) };
  },
};

const createTaskTool: McpTool<typeof createTaskInput> = {
  name: 'taskpilot_create_task',
  description:
    'Create a new TaskPilot task. Use when the user says "add a task", "remind me to", "I need to", or otherwise asks to capture something for later. New tasks land in the inbox unless overridden.',
  inputSchema: createTaskInput,
  async handler(input) {
    const task = createTask({
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 'p2',
      due: input.due ?? null,
      tags: input.tags ?? [],
      agent_method: input.agent_method ?? 'human_only',
      agent_instructions: input.agent_instructions ?? null,
      parent_id: input.parent_id ?? null,
    });
    return { task };
  },
};

const updateTaskTool: McpTool<typeof updateTaskInput> = {
  name: 'taskpilot_update_task',
  description:
    'Update fields on an existing TaskPilot task. Use to change status (e.g. mark done), priority, description, tags, agent settings, etc. Only supplied fields are written.',
  inputSchema: updateTaskInput,
  async handler(input) {
    const { id, ...rest } = input;
    // The repo distinguishes between "field absent" and "field set to null"
    // via `'key' in patch`. Strip undefined values so we don't accidentally
    // null out fields the caller didn't intend to touch.
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined) patch[k] = v;
    }
    const task = updateTask(id, patch as Parameters<typeof updateTask>[1]);
    if (!task) throw new Error(`Task ${id} not found`);
    return { task };
  },
};

const deriveTaskTool: McpTool<typeof deriveTaskInput> = {
  name: 'taskpilot_derive_task',
  description:
    'Queue a TaskPilot task for derivation — i.e. ask another Claude (running in Cowork or Claude Code) to break the task into smaller actionable sub-tasks. This tool writes a derivation request file to io/derive/<id>.json; the downstream Claude reads it and writes back to io/derived/. Use when a task is too big to tackle directly and needs to be planned out.',
  inputSchema: deriveTaskInput,
  async handler(input) {
    const task = requireTask(input.id);
    // Re-derive duplication guard. Matches the HTTP /api/tasks/:id/derive
    // route: `ingestDerived` mints fresh child ids on every pass, so
    // calling derive twice on the same parent leaves two batches behind.
    const liveChildren = getChildren(task.id).filter(
      (c) => c.status !== 'cancelled',
    );
    if (liveChildren.length > 0) {
      throw new Error(
        `Task ${task.id} already has ${liveChildren.length} non-cancelled descendant(s). Re-deriving would create duplicates. Reject the existing derivation (which deletes children first) or delete them individually before calling derive again.`,
      );
    }
    const calendar_snapshot = await readCalendarSnapshot();
    const related_tasks = findRelatedTasks(task);
    const file_path = await writeDeriveRequest(task, {
      calendar_snapshot,
      related_tasks,
      available_tools: ['cowork', 'cli'],
      execution_modes: ['cowork', 'cli'],
    });
    updateTask(task.id, { agent_status: 'assigned' });
    return {
      task_id: task.id,
      file_path,
      message: `Derivation request written. A downstream Claude should pick it up from io/derive/ and respond in io/derived/.`,
    };
  },
};

const executeTaskTool: McpTool<typeof executeTaskInput> = {
  name: 'taskpilot_execute_task',
  description:
    'Queue a TaskPilot task for execution by another Claude (Cowork or Claude Code). Writes an execution request file to io/execute/<id>.json with the task, parent outputs, and instructions. Use when a task is ready to be actually done by an agent, not just planned.',
  inputSchema: executeTaskInput,
  async handler(input) {
    const task = requireTask(input.id);
    const parent_outputs = await resolveParentOutputs(task);
    const file_path = await writeExecuteRequest(
      task,
      parent_outputs,
      { tags: task.tags },
      task.agent_instructions ?? undefined,
    );
    updateTask(task.id, { agent_status: 'assigned' });
    return {
      task_id: task.id,
      file_path,
      message: `Execution request written. A downstream Claude should pick it up from io/execute/ and write results to io/results/${task.id}/.`,
    };
  },
};

const agentStatusTool: McpTool<typeof agentStatusInput> = {
  name: 'taskpilot_agent_status',
  description:
    'Report the agent-pipeline status of a single task (when task_id is supplied) or list every task that currently has an agent running, pending, or needing review (when called with no arguments). Use to answer "what is Claude working on?" or "where did task X land?".',
  inputSchema: agentStatusInput,
  async handler(input) {
    if (input.task_id !== undefined) {
      const task = requireTask(input.task_id);
      const children = getChildren(task.id);
      const logs = getLogsForTask(task.id);
      return {
        task_id: task.id,
        status: task.status,
        agent_status: task.agent_status,
        agent_method: task.agent_method,
        agent_executable: task.agent_executable,
        children_count: children.length,
        execution_logs: logs,
      };
    }
    // No argument — return all tasks that are mid-flight in the agent pipeline.
    const candidates = listTasks({ limit: 500 });
    const active = candidates.filter(
      (t) =>
        t.agent_status === 'assigned' ||
        t.agent_status === 'running' ||
        t.agent_status === 'needs_review' ||
        t.status === 'in_progress',
    );
    return {
      count: active.length,
      tasks: active.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        agent_status: t.agent_status,
        agent_method: t.agent_method,
        priority: t.priority,
        updated_at: t.updated_at,
      })),
    };
  },
};

export const taskTools: McpTool[] = [
  listTasksTool as unknown as McpTool,
  getTaskTool as unknown as McpTool,
  createTaskTool as unknown as McpTool,
  updateTaskTool as unknown as McpTool,
  deriveTaskTool as unknown as McpTool,
  executeTaskTool as unknown as McpTool,
  agentStatusTool as unknown as McpTool,
];
