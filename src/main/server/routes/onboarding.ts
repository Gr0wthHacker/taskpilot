/**
 * `/api/onboarding/...` routes.
 *
 * Drives the first-launch wizard. Stores a single boolean-ish setting key —
 * `onboarding_completed_at` — that the renderer queries on startup to decide
 * whether to redirect into the wizard or load the regular shell.
 *
 * The "load sample tasks" step posts here so the demo data ends up in the same
 * DB the rest of the app uses, going through the same repository the regular
 * task-creation routes use.
 */

import { Router } from 'express';

import { createTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';
import type { CreateTaskInput } from '@/shared/types';

import { asyncHandler } from '../middleware';

const SETTING_KEY = 'onboarding_completed_at';

export interface OnboardingStatusResponse {
  completed: boolean;
  completed_at?: string;
}

export interface OnboardingCompleteResponse {
  ok: true;
  completed_at: string;
}

export interface OnboardingSampleDataResponse {
  created: number;
}

/**
 * Five demo tasks chosen to show the range of the app: a couple of priorities,
 * a mix of agent methods, and a parent that will derive children once the user
 * exercises the workflow. Titles are deliberately recognizable so the user
 * can tell at a glance which tasks are seed data.
 */
const SAMPLE_TASKS: CreateTaskInput[] = [
  {
    title: 'Welcome to TaskPilot - try the Inbox',
    description:
      'This is a sample task. Inbox is where new work lands before you triage it. Drag to Board to plan, or send to Claude via Derive to break it down.',
    priority: 'p2',
    agent_method: 'human_only',
    agent_executable: false,
    tags: ['sample', 'welcome'],
  },
  {
    title: 'Draft a launch announcement post',
    description:
      'Demo of a writing task Claude can derive into smaller steps (outline -> draft -> edit). Open the Derive workflow to see how it works.',
    priority: 'p1',
    agent_method: 'cowork',
    agent_executable: true,
    agent_instructions:
      'Break this into outline, draft, edit subtasks. Each subtask should be human-reviewable.',
    tags: ['sample', 'writing'],
  },
  {
    title: 'Refactor the auth module',
    description:
      'Demo of a code task suited for Claude Code (CLI execution). The agent reads files, proposes changes, and writes a result for review.',
    priority: 'p1',
    agent_method: 'cli',
    agent_executable: true,
    agent_instructions:
      'Identify the auth module, summarize current structure, propose a refactor plan.',
    tags: ['sample', 'code'],
  },
  {
    title: 'Pay the quarterly tax estimate',
    description:
      'Demo of a P0 human-only task. TaskPilot will not try to automate this — it just keeps the deadline visible.',
    priority: 'p0',
    agent_method: 'human_only',
    agent_executable: false,
    tags: ['sample', 'finance'],
  },
  {
    title: 'Sort old screenshots folder',
    description:
      'Demo of a low-priority background task. P3 tasks stay out of the Daily Plan until you bump the priority or pin them.',
    priority: 'p3',
    agent_method: 'either',
    agent_executable: true,
    agent_instructions:
      'List files, group by month, suggest a rename pattern. No destructive moves without approval.',
    tags: ['sample', 'cleanup'],
  },
];

export function onboardingRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler(async (_req, res) => {
      const raw = settingsRepository.get(SETTING_KEY);
      const completedAt = typeof raw === 'string' && raw.length > 0 ? raw : null;
      const body: OnboardingStatusResponse = {
        completed: completedAt !== null,
      };
      if (completedAt !== null) body.completed_at = completedAt;
      res.json(body);
    }),
  );

  router.post(
    '/complete',
    asyncHandler(async (_req, res) => {
      const completedAt = new Date().toISOString();
      settingsRepository.set(SETTING_KEY, completedAt);
      const body: OnboardingCompleteResponse = { ok: true, completed_at: completedAt };
      res.json(body);
    }),
  );

  router.post(
    '/sample-data',
    asyncHandler(async (_req, res) => {
      let created = 0;
      for (const input of SAMPLE_TASKS) {
        try {
          createTask(input);
          created += 1;
        } catch {
          // Non-fatal — keep going. If one row collides on an id we still want
          // the rest of the sample set to land.
        }
      }
      const body: OnboardingSampleDataResponse = { created };
      res.json(body);
    }),
  );

  return router;
}

export const __onboarding_internals = {
  SETTING_KEY,
  SAMPLE_TASKS,
};
