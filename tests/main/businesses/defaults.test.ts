/**
 * Tests for per-business defaults (permission profile + branch policy) being
 * spliced onto derived and inbox tasks during ingestion.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import {
  invalidateCache,
  PROJECTS_FILE_PATH,
} from '@/main/businesses/loader';
import { resolveBusinessDefaults } from '@/main/businesses';
import { ingestDerived, ingestInbox } from '@/main/io/ingestion';
import { createTask, getTask } from '@/main/db/repositories/tasks';
import type { Task } from '@/shared/types';

function writeProjects(): void {
  fs.mkdirSync(path.dirname(PROJECTS_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    PROJECTS_FILE_PATH,
    JSON.stringify(
      {
        projects: [
          {
            name: 'Leal Health',
            tag: 'leal-health',
            default_permission_profile: 'github-pr',
            branch_policy: 'agent/{task_id}',
            repos: ['Gr0wthHacker/leal-x'],
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  invalidateCache();
}

function clearProjects(): void {
  try {
    fs.unlinkSync(PROJECTS_FILE_PATH);
  } catch {
    /* ignore */
  }
  invalidateCache();
}

describe('businesses/defaults', () => {
  beforeEach(writeProjects);
  afterEach(clearProjects);

  it('resolveBusinessDefaults returns the configured profile + policy', () => {
    const out = resolveBusinessDefaults(['leal-health']);
    expect(out.business?.tag).toBe('leal-health');
    expect(out.branch_policy).toBe('agent/{task_id}');
    expect(out.permissions).not.toBeNull();
    // github-pr profile mandates allowed git tools.
    expect(out.permissions?.allowed_tools?.join(',')).toMatch(/git/);
  });

  it('returns all-nulls when no business matches', () => {
    const out = resolveBusinessDefaults(['unrelated-tag']);
    expect(out.business).toBeNull();
    expect(out.permissions).toBeNull();
    expect(out.branch_policy).toBeNull();
  });

  it('splices defaults onto derived children when the parent carries the tag', async () => {
    const parent = createTask({
      title: 'Parent epic',
      priority: 'p1',
      tags: ['leal-health'],
    });
    const childIds = await ingestDerived(parent.id, {
      task_id: parent.id,
      derived_at: new Date().toISOString(),
      derivatives: [
        {
          title: 'Child A',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 10,
          depends_on: [],
          review_required: false,
        },
      ],
    });
    expect(childIds).toHaveLength(1);
    const child = getTask(childIds[0]!);
    expect(child).not.toBeNull();
    const ctx = (child!.context ?? {}) as Record<string, unknown>;
    expect(ctx.business).toBe('leal-health');
    expect(ctx.branch_policy).toBe('agent/{task_id}');
    expect(ctx.permissions).toBeTypeOf('object');
  });

  it('skips derived children whose parent has no business tag', async () => {
    const parent = createTask({
      title: 'Untagged epic',
      priority: 'p2',
      tags: [],
    });
    const childIds = await ingestDerived(parent.id, {
      task_id: parent.id,
      derived_at: new Date().toISOString(),
      derivatives: [
        {
          title: 'Untagged child',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: null,
          estimated_minutes: 5,
          depends_on: [],
          review_required: false,
        },
      ],
    });
    const child = getTask(childIds[0]!);
    const ctx = (child!.context ?? {}) as Record<string, unknown>;
    expect(ctx.business).toBeUndefined();
    expect(ctx.permissions).toBeUndefined();
    expect(ctx.branch_policy).toBeUndefined();
  });

  it('splices defaults onto inbox tasks too', async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'inbox-leal-1',
      title: 'inbox via drop',
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
      tags: ['leal-health'],
      created_at: now,
      updated_at: now,
    };
    await ingestInbox(task.id, task);
    const fetched = getTask(task.id);
    const ctx = (fetched!.context ?? {}) as Record<string, unknown>;
    expect(ctx.business).toBe('leal-health');
    expect(ctx.permissions).toBeTypeOf('object');
  });

  it('does not overwrite an inbox task that already declared its own permissions', async () => {
    const now = new Date().toISOString();
    const task: Task = {
      id: 'inbox-leal-2',
      title: 'inbox with own perms',
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
      context: {
        permissions: {
          allowed_tools: ['Read'],
          network_access: 'off',
        },
      },
      tags: ['leal-health'],
      created_at: now,
      updated_at: now,
    };
    await ingestInbox(task.id, task);
    const fetched = getTask(task.id);
    const ctx = (fetched!.context ?? {}) as Record<string, unknown>;
    const perms = ctx.permissions as Record<string, unknown>;
    expect(perms.allowed_tools).toEqual(['Read']);
  });
});
