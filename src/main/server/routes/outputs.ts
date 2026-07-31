/**
 * `/api/tasks/:id/outputs` and `/api/tasks/:id/briefing-pack` routes (Wave 15).
 *
 * Thin HTTP skin over `@/main/outputs/collector` and
 * `@/main/outputs/briefing-pack`. The outputs endpoint returns the
 * {@link OutputBundle} as JSON; the briefing-pack endpoint streams a ZIP
 * file built from the same bundle.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { Router, type Request, type Response } from 'express';

import {
  OutputsError,
  collectOutputs,
  readOutputFileContent,
} from '@/main/outputs/collector';
import { buildBriefingPack } from '@/main/outputs/briefing-pack';
import { tasksRepository } from '@/main/db/repositories/tasks';
import { taskIdSchema } from '@/shared/io-schemas';
import type {
  GetOutputFileContentResponse,
  GetTaskOutputsResponse,
} from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function assertValidId(id: string): void {
  const parsed = taskIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new ApiHttpError(400, 'invalid_task_id', `Invalid task id: ${id}`);
  }
}

/**
 * Best-effort cleanup of the briefing-pack temp file + its parent directory.
 * Runs after the response has finished streaming. Errors are swallowed —
 * a leftover tmp file is a non-fatal nuisance, not a correctness bug.
 */
async function cleanupTemp(filePath: string): Promise<void> {
  try {
    await fsp.rm(path.dirname(filePath), { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function outputsRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET /api/tasks/:id/outputs ---------------------------------------------
  router.get(
    '/:id/outputs',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      assertValidId(id);
      try {
        const bundle = await collectOutputs(id);
        const response: GetTaskOutputsResponse = bundle;
        res.json(response);
      } catch (err) {
        if (err instanceof OutputsError) {
          if (err.code === 'not_found') {
            throw new ApiHttpError(404, 'not_found', err.message);
          }
          throw new ApiHttpError(500, err.code, err.message);
        }
        throw err;
      }
    }),
  );

  // GET /api/tasks/:id/outputs/file?path=... -------------------------------
  // Full (capped) content of a single output/attachment file for the in-app
  // viewer. Path is validated against the task's output dir + attachments in
  // the collector, so a crafted `?path=` can't escape the task's sandbox.
  router.get(
    '/:id/outputs/file',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      assertValidId(id);
      const requested =
        typeof req.query.path === 'string' ? req.query.path : '';
      if (!requested) {
        throw new ApiHttpError(
          400,
          'bad_request',
          'Missing ?path= query parameter',
        );
      }
      try {
        const file = await readOutputFileContent(id, requested);
        const response: GetOutputFileContentResponse = file;
        res.json(response);
      } catch (err) {
        if (err instanceof OutputsError) {
          const status =
            err.code === 'not_found'
              ? 404
              : err.code === 'forbidden'
                ? 403
                : 500;
          throw new ApiHttpError(status, err.code, err.message);
        }
        throw err;
      }
    }),
  );

  // GET /api/tasks/:id/briefing-pack ---------------------------------------
  router.get(
    '/:id/briefing-pack',
    asyncHandler(async (req: Request, res: Response) => {
      const id = String(req.params.id);
      assertValidId(id);
      const task = tasksRepository.findById(id);
      if (!task) {
        throw new ApiHttpError(404, 'not_found', `Task ${id} not found`);
      }
      let bundle;
      try {
        bundle = await collectOutputs(id);
      } catch (err) {
        if (err instanceof OutputsError) {
          throw new ApiHttpError(500, err.code, err.message);
        }
        throw err;
      }

      const pack = await buildBriefingPack(task, bundle);
      const filename = `task-${id}-briefing.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(pack.size_bytes));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );

      const stream = fs.createReadStream(pack.path);
      // Promise-shaped pipe so the asyncHandler awaits the full stream
      // before resolving — fixes a Windows quirk where the temp file
      // can get unlinked while the OS is still flushing the socket.
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        res.on('close', () => resolve());
        res.on('finish', () => resolve());
        stream.pipe(res);
      });

      // Best-effort cleanup of the temp directory.
      await cleanupTemp(pack.path);
    }),
  );

  return router;
}
