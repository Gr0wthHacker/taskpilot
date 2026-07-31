/**
 * `/api/graph` route (Wave 17).
 *
 * Read-only. Returns the cross-task knowledge graph (nodes + edges) for a
 * given scope. Delegates all the real work to the pure {@link buildGraph}
 * function in `@/main/graph/builder` — this router is only query validation +
 * envelope shaping.
 *
 * Query contract:
 *   - `?scope=all|workspace|tag|root` (default `all`).
 *   - `?value=<id|tag>` — required for `workspace` / `tag` / `root`, ignored
 *     for `all`.
 *
 * Invalid query strings 400 via Zod / the standard ValidationError envelope.
 * A missing workspace / tag / root id yields an empty graph (200) rather than
 * a 404 — the renderer renders an empty-state panel for that case.
 */

import { Router } from 'express';
import { z } from 'zod';

import {
  buildGraph,
  defaultBuildGraphDeps,
  type BuildGraphDeps,
  type GoalMembershipLoader,
} from '@/main/graph/builder';
import type { GraphResponse, GraphScope } from '@/shared/api-contract';
import type { Task } from '@/shared/types';

import { asyncHandler, validateQuery } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const graphQuerySchema = z
  .object({
    scope: z.enum(['all', 'workspace', 'tag', 'root']).optional(),
    // `value` is the workspace id / tag / root task id. We keep the alphabet
    // permissive (it covers task ids, tag slugs, and workspace slugs) but
    // bounded so a giant query string can't be smuggled through.
    value: z.string().min(1).max(128).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/*  Goal membership (defensive — Wave 17G may or may not be present)          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a goal loader that surfaces a real goal label when the goals module
 * (Wave 17G) is available, falling back to the builder's context-only default
 * otherwise. We probe the module with `require` inside a try/catch so the
 * graph never hard-depends on goals existing — if the module is absent, a
 * malformed export, or throws, we degrade to "no enriched labels".
 *
 * Resolved once at router construction so we don't pay the probe per request.
 */
function resolveGoalLoader(): GoalMembershipLoader | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@/main/goals') as {
      readTaskGoalId?: (task: Task) => string | null;
      getGoal?: (id: string) => { id: string; title?: string } | null;
    };
    if (typeof mod.readTaskGoalId !== 'function') return undefined;
    const readTaskGoalId = mod.readTaskGoalId;
    const getGoal = mod.getGoal;
    return (task: Task) => {
      const goalId = readTaskGoalId(task);
      if (!goalId) return null;
      const goal = typeof getGoal === 'function' ? getGoal(goalId) : null;
      const label =
        goal && typeof goal.title === 'string' && goal.title.length > 0
          ? goal.title
          : goalId;
      return { id: goalId, label };
    };
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function graphRouter(): Router {
  const router = Router();

  const goalLoader = resolveGoalLoader();
  const deps: BuildGraphDeps = goalLoader
    ? { ...defaultBuildGraphDeps, loadGoal: goalLoader }
    : defaultBuildGraphDeps;

  // GET /api/graph?scope=all|workspace|tag|root&value=... -------------------
  router.get(
    '/',
    validateQuery(graphQuerySchema),
    asyncHandler(async (req, res) => {
      const q = req.query as z.infer<typeof graphQuerySchema>;
      const kind = q.scope ?? 'all';
      const scope: GraphScope =
        kind === 'all'
          ? { kind: 'all' }
          : { kind, ...(q.value !== undefined ? { value: q.value } : {}) };

      const body: GraphResponse = buildGraph({ scope }, deps);
      res.json(body);
    }),
  );

  return router;
}
