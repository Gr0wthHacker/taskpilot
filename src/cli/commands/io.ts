/**
 * `taskpilot io ...` subcommands.
 *
 * Most commands hit the local API. Two commands (`io read` and `io write-result`)
 * bypass the server and touch the filesystem directly so Claude Code can use
 * them when the desktop app isn't running.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { apiGet, apiPost } from '../api-client.js';
import { printJson, pickPretty } from '../format.js';
import {
  IO_DERIVE,
  IO_EXECUTE,
  IO_RESULTS,
} from '@/shared/constants';
import { ExecutionResultSchema } from '@/shared/io-schemas';

/* -------------------------------------------------------------------------- */
/*  Filesystem helpers (offline-safe)                                         */
/* -------------------------------------------------------------------------- */

function readJsonFile<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function atomicWriteJson(dest: string, payload: unknown): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
}

/* -------------------------------------------------------------------------- */
/*  Command registration                                                      */
/* -------------------------------------------------------------------------- */

export function registerIoCommand(program: Command): void {
  const io = program.command('io').description('Inspect the Claude I/O pipeline');

  io
    .command('pending')
    .description('List pending derivation/execution requests')
    .action(async () => {
      const result = await apiGet<unknown>('/api/io/pending');
      printJson(result);
    });

  io
    .command('results')
    .description('List derivation/execution results awaiting ingestion')
    .action(async () => {
      const result = await apiGet<unknown>('/api/io/results');
      printJson(result);
    });

  io
    .command('ingest')
    .description('Force the file watcher to re-scan the I/O directories')
    .action(async () => {
      const result = await apiPost<unknown>('/api/io/ingest');
      if (pickPretty()) {
        process.stdout.write('Watcher re-scan requested\n');
      } else {
        printJson(result ?? { ok: true });
      }
    });

  io
    .command('status')
    .description('Pipeline counts and watcher state')
    .action(async () => {
      const result = await apiGet<unknown>('/api/io/status');
      printJson(result);
    });

  // ------------------------------------------------------------------------
  // io read — offline, direct filesystem
  // ------------------------------------------------------------------------
  io
    .command('read <taskId>')
    .description(
      'Read the derive/<id>.json or execute/<id>.json request file directly from disk',
    )
    .action((taskId: string) => {
      const derivePath = path.join(IO_DERIVE, `${taskId}.json`);
      const executePath = path.join(IO_EXECUTE, `${taskId}.json`);

      let chosen: string | null = null;
      if (fs.existsSync(derivePath)) chosen = derivePath;
      else if (fs.existsSync(executePath)) chosen = executePath;

      if (!chosen) {
        process.stderr.write(
          `No request file found for task ${taskId}.\n` +
            `  checked: ${derivePath}\n  checked: ${executePath}\n`,
        );
        process.exitCode = 1;
        return;
      }

      try {
        const data = readJsonFile(chosen);
        printJson(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to read ${chosen}: ${msg}\n`);
        process.exitCode = 1;
      }
    });

  // ------------------------------------------------------------------------
  // io write-result — offline, direct filesystem, Zod-validated
  // ------------------------------------------------------------------------
  io
    .command('write-result <taskId> <pathToJson>')
    .description(
      'Validate an ExecutionResult JSON file and place it at ~/.taskpilot/io/results/<task-id>/result.json',
    )
    .action((taskId: string, pathToJson: string) => {
      const sourcePath = path.resolve(pathToJson);
      if (!fs.existsSync(sourcePath)) {
        process.stderr.write(`Source file not found: ${sourcePath}\n`);
        process.exitCode = 1;
        return;
      }

      let raw: unknown;
      try {
        raw = readJsonFile(sourcePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Could not parse ${sourcePath} as JSON: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      const parsed = ExecutionResultSchema.safeParse(raw);
      if (!parsed.success) {
        process.stderr.write('ExecutionResult validation failed:\n');
        process.stderr.write(JSON.stringify(parsed.error.format(), null, 2) + '\n');
        process.exitCode = 1;
        return;
      }

      if (parsed.data.task_id !== taskId) {
        process.stderr.write(
          `task_id mismatch: file has "${parsed.data.task_id}", CLI arg was "${taskId}"\n`,
        );
        process.exitCode = 1;
        return;
      }

      const dest = path.join(IO_RESULTS, taskId, 'result.json');
      try {
        atomicWriteJson(dest, parsed.data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to write ${dest}: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      if (pickPretty()) {
        process.stdout.write(`Wrote result for ${taskId} to ${dest}\n`);
      } else {
        printJson({ ok: true, task_id: taskId, path: dest });
      }

      // ExecutionResult.status === 'needs_review' → exit code 2
      if (parsed.data.status === 'needs_review') {
        process.exitCode = 2;
      }
    });
}
