/**
 * End-to-end integration smoke test.
 *
 * Walks the full happy path:
 *   1. Create a parent task via the tasks repo.
 *   2. Write a derive request via the protocol layer.
 *   3. Simulate Claude writing a derived response into IO_DERIVED.
 *   4. Ingest the response — assert child tasks exist with depends_on resolved.
 *
 * All paths are redirected into a tmpdir; the DB is in-memory.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../helpers/mock-paths';
import { useMockedDb } from '../helpers/mock-db';

const PATHS = mockTaskpilotPaths();

import { createTask, getChildren, getTask } from '@/main/db/repositories/tasks';
import { writeDeriveRequest } from '@/main/io/protocol';
import { ingestDerived } from '@/main/io/ingestion';
import { derivePath, derivedPath } from '@/main/io/paths';
import type { DerivationResponse } from '@/shared/types';

describe('integration smoke — derive round trip', () => {
  useMockedDb();

  it('creates → derive request → ingest → children visible', async () => {
    // 1. Create parent
    const parent = createTask({
      title: 'launch newsletter',
      priority: 'p1',
      tags: ['marketing'],
    });
    expect(getTask(parent.id)).not.toBeNull();

    // 2. Write derive request
    const derivePath_ = await writeDeriveRequest(parent, {
      calendar_snapshot: '{"events":[]}',
      related_tasks: [],
      available_tools: ['cowork', 'cli'],
      execution_modes: ['cowork', 'cli'],
    });
    expect(fs.existsSync(derivePath_)).toBe(true);
    // The path lives under our mocked IO_DERIVE.
    expect(derivePath_.startsWith(PATHS.IO_DERIVE)).toBe(true);
    // Path helper agrees on the location.
    expect(derivePath_).toBe(derivePath(parent.id));

    // 3. Simulate downstream Claude writing the derived response.
    const response: DerivationResponse = {
      task_id: parent.id,
      derived_at: '2026-05-26T12:00:00Z',
      derivatives: [
        {
          title: 'write the post',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: 'use voice guide',
          estimated_minutes: 45,
          depends_on: [],
          review_required: false,
        },
        {
          title: 'send to list',
          agent_executable: true,
          agent_method: 'cli',
          agent_instructions: 'mailchimp',
          estimated_minutes: 15,
          depends_on: ['write the post'],
          review_required: true,
        },
      ],
    };
    await fsp.writeFile(
      derivedPath(parent.id),
      JSON.stringify(response, null, 2),
      'utf8',
    );

    // 4. Ingest into DB (this is what the watcher would do).
    const childIds = await ingestDerived(parent.id, response);
    expect(childIds).toHaveLength(2);

    const children = getChildren(parent.id);
    expect(children).toHaveLength(2);
    const titles = children.map((c) => c.title).sort();
    expect(titles).toEqual(['send to list', 'write the post']);

    // Children inherit parent priority + tags.
    expect(children.every((c) => c.priority === 'p1')).toBe(true);
    expect(children.every((c) => c.tags.includes('marketing'))).toBe(true);

    // depends_on resolves via title lookup.
    const second = children.find((c) => c.title === 'send to list');
    const first = children.find((c) => c.title === 'write the post');
    const ctx = second?.context as Record<string, unknown> | null;
    expect(ctx?.depends_on).toEqual([first?.id]);

    // Parent flips to needs_review.
    expect(getTask(parent.id)?.agent_status).toBe('needs_review');

    // Derive request file is cleaned up after ingestion.
    expect(fs.existsSync(derivePath(parent.id))).toBe(false);
  });
});
