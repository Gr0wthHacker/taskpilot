/**
 * MCP tools for the file-based agent I/O pipeline.
 *
 * `pending`  → what's waiting on Claude to act on
 * `read`     → fetch the full derive/execute payload for a single task
 * `write_result` → let the MCP client submit an ExecutionResult back to TaskPilot
 *
 * These give a Claude client a way to do the full Cowork/Code roundtrip
 * entirely through MCP, without needing direct filesystem access.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  IO_DERIVE,
  IO_DERIVED,
  IO_EXECUTE,
  IO_RESULTS,
} from '@/shared/constants';
import { executionResultSchema, taskIdSchema } from '@/shared/io-schemas';
import {
  derivePath,
  executePath,
  outputDir,
  resultPath,
} from '@/main/io/paths';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schemas                                                             */
/* -------------------------------------------------------------------------- */

const pendingInput = z.object({});

const readInput = z.object({
  task_id: taskIdSchema,
});

const writeResultInput = z.object({
  task_id: taskIdSchema,
  result: executionResultSchema,
  output_files: z.array(z.string().max(4_096)).max(1_024).optional(),
});

/* -------------------------------------------------------------------------- */
/*  Filesystem helpers                                                        */
/* -------------------------------------------------------------------------- */

interface PendingFileRef {
  task_id: string;
  path: string;
  written_at: string;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function listPendingDir(dir: string): Promise<PendingFileRef[]> {
  const entries = await safeReadDir(dir);
  const out: PendingFileRef[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.endsWith('.tmp.json') || entry.endsWith('.json.tmp')) continue;
    const filePath = path.join(dir, entry);
    const taskId = entry.slice(0, -'.json'.length);
    try {
      const st = await fs.stat(filePath);
      out.push({
        task_id: taskId,
        path: filePath,
        written_at: new Date(st.mtimeMs).toISOString(),
      });
    } catch {
      // skip entries we can't stat
    }
  }
  return out;
}

async function readJsonOrNull(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

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

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const pendingTool: McpTool<typeof pendingInput> = {
  name: 'taskpilot_io_pending',
  description:
    "List every derivation and execution request that TaskPilot has written for an agent to pick up. Use to answer 'what is Claude supposed to be doing?' or to find tasks ready to be derived/executed by Cowork or Claude Code.",
  inputSchema: pendingInput,
  async handler() {
    const [derive, execute] = await Promise.all([
      listPendingDir(IO_DERIVE),
      listPendingDir(IO_EXECUTE),
    ]);
    return {
      derive,
      execute,
      counts: { derive: derive.length, execute: execute.length },
    };
  },
};

const readTool: McpTool<typeof readInput> = {
  name: 'taskpilot_io_read',
  description:
    'Fetch the full derive or execute JSON for a task — the payload another Claude would pick up. Mirrors `taskpilot io read` on the CLI. Use to inspect what was requested before acting on it.',
  inputSchema: readInput,
  async handler(input) {
    const drive = derivePath(input.task_id);
    const exec = executePath(input.task_id);

    const out: {
      task_id: string;
      derive: unknown | null;
      execute: unknown | null;
    } = {
      task_id: input.task_id,
      derive: null,
      execute: null,
    };

    if (await pathExists(drive)) {
      out.derive = await readJsonOrNull(drive);
    }
    if (await pathExists(exec)) {
      out.execute = await readJsonOrNull(exec);
    }

    if (out.derive === null && out.execute === null) {
      throw new Error(
        `No derive/ or execute/ request found for task ${input.task_id}`,
      );
    }
    return out;
  },
};

const writeResultTool: McpTool<typeof writeResultInput> = {
  name: 'taskpilot_io_write_result',
  description:
    'Submit an ExecutionResult for a task — what Cowork/Claude Code normally writes to io/results/<task-id>/result.json. The payload is validated against the ExecutionResult schema. Use when an external Claude has finished work and wants to hand it back to TaskPilot via MCP instead of writing to disk directly.',
  inputSchema: writeResultInput,
  async handler(input) {
    // Schema-validated by Zod above, but parse once more so we get a clean
    // typed value (rather than the inferred-from-Zod opaque type) and so the
    // shape on disk exactly matches what ingestion expects.
    const result = executionResultSchema.parse(input.result);

    const outDir = outputDir(input.task_id);
    await fs.mkdir(outDir, { recursive: true });

    const dest = resultPath(input.task_id);
    await writeJsonAtomic(dest, result);

    // The optional `output_files` array is a hint to callers (and humans
    // inspecting the directory) about what artifacts were promised. We
    // record it alongside the result for diagnostics; the canonical list of
    // files on disk is whatever's actually in `outputDir`.
    const promised = input.output_files ?? [];
    return {
      ok: true,
      task_id: input.task_id,
      result_path: dest,
      output_dir: outDir,
      promised_output_files: promised,
      results_root: IO_RESULTS,
      derived_root: IO_DERIVED,
      message:
        "Result written. TaskPilot's watcher will ingest it on the next scan; the task's agent_status will reflect the submitted status.",
    };
  },
};

export const ioTools: McpTool[] = [
  pendingTool as unknown as McpTool,
  readTool as unknown as McpTool,
  writeResultTool as unknown as McpTool,
];
