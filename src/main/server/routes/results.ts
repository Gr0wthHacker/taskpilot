/**
 * `POST /api/results` — public alias for submitting an `ExecutionResult`.
 *
 * Identical behavior to `POST /api/io/results`. Exposed at the shorter path
 * because that's where the renderer's Execution view posts. Keeping both
 * mounts means CLI scripts and renderer code don't need to coordinate on a
 * single canonical URL.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';
import { z } from 'zod';

import { ingestResult } from '@/main/io/ingestion';
import { outputDir, resultPath } from '@/main/io/paths';
import { executionResultSchema, taskIdSchema } from '@/shared/io-schemas';
import type { SubmitResultResponse } from '@/shared/api-contract';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

const submitResultBodySchema = z.object({
  task_id: taskIdSchema,
  result: executionResultSchema,
  output_files: z.array(z.string().max(4_096)).max(1_024).optional(),
});

/**
 * Atomic JSON write — temp file + fsync + rename. Same pattern the protocol
 * layer uses for derive/execute payloads.
 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

async function listOutputFiles(taskId: string): Promise<string[]> {
  let dir: string;
  try {
    dir = outputDir(taskId);
  } catch {
    return [];
  }
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

export function resultsRouter(): Router {
  const router = Router();

  router.post(
    '/',
    validateBody(submitResultBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof submitResultBodySchema>;

      if (body.result.task_id !== body.task_id) {
        throw new ApiHttpError(
          400,
          'task_id_mismatch',
          'body.task_id and body.result.task_id must match',
        );
      }

      const dest = resultPath(body.task_id);
      const outDir = outputDir(body.task_id);
      await fs.mkdir(outDir, { recursive: true });
      await writeJsonAtomic(dest, body.result);

      const outputs = await listOutputFiles(body.task_id);
      try {
        await ingestResult(body.task_id, body.result, outputs);
      } catch (err: unknown) {
        throw new ApiHttpError(
          500,
          'ingest_failed',
          err instanceof Error ? err.message : 'ingestion failed',
        );
      }

      const response: SubmitResultResponse = {
        ok: true,
        task_id: body.task_id,
        result_path: dest,
      };
      res.status(201).json(response);
    }),
  );

  return router;
}
