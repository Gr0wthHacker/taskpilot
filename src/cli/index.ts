#!/usr/bin/env node
/**
 * TaskPilot CLI entrypoint.
 *
 * Thin commander wrapper around:
 *  - the local HTTP API at http://localhost:7847 (most commands)
 *  - direct filesystem reads/writes in ~/.taskpilot/io/* (the `io read` and
 *    `io write-result` commands, which must work even with the app offline)
 *
 * Output contract:
 *  - JSON by default. One JSON object/array on stdout, no decoration.
 *  - `--pretty` switches to human-readable tables and colored output.
 *  - `--json` is accepted for clarity; mutually exclusive with `--pretty`
 *    (last one wins via commander).
 *
 * Exit codes:
 *   0  success
 *   1  any thrown error / non-2xx API response
 *   2  needs-review (e.g. ExecutionResult.status === 'needs_review')
 */

import { Command } from 'commander';
import { setApiBase, ApiError, ApiConnectionError } from './api-client.js';
import { setPretty } from './format.js';
import { registerTaskCommand } from './commands/task.js';
import { registerCalCommand } from './commands/cal.js';
import { registerIoCommand } from './commands/io.js';
import { registerSystemCommands } from './commands/system.js';
import { APP_VERSION } from '@/shared/constants';

function buildProgram(): Command {
  const program = new Command();

  program
    .name('taskpilot')
    .description('TaskPilot CLI — task & calendar manager for Claude-first workflows')
    .version(APP_VERSION)
    .option('--json', 'Emit JSON output (default)')
    .option('--pretty', 'Emit human-readable output')
    .option('--api <url>', 'Override the local API base URL (default: http://localhost:7847)')
    .enablePositionalOptions();

  // Apply global options before any subcommand action runs. Commander invokes
  // the `preAction` hook on the root program for every subcommand.
  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ json?: boolean; pretty?: boolean; api?: string }>();
    // pretty wins only if explicitly set; otherwise default JSON
    setPretty(Boolean(opts.pretty) && !opts.json);
    setApiBase(opts.api);
  });

  registerTaskCommand(program);
  registerCalCommand(program);
  registerIoCommand(program);
  registerSystemCommands(program);

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err: unknown): void {
  // Distinguish error classes for exit-code mapping.
  if (err instanceof ApiConnectionError) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }

  if (err instanceof ApiError) {
    // Needs-review surfaces as a normal 2xx body in most flows; the dedicated
    // `io write-result` command sets exit code 2 directly. We still honor a
    // body that explicitly signals needs-review here.
    const status = err.body?.code === 'needs_review' ? 2 : 1;
    if (process.env.TASKPILOT_DEBUG === '1') {
      process.stderr.write(JSON.stringify({ error: err.message, status: err.status, body: err.body }, null, 2) + '\n');
    } else {
      const payload = {
        error: err.message,
        status: err.status,
        ...(err.body?.details !== undefined ? { details: err.body.details } : {}),
      };
      process.stderr.write(JSON.stringify(payload) + '\n');
    }
    process.exit(status);
  }

  // Validation/parse errors from option parsers, etc.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(JSON.stringify({ error: message }) + '\n');
  process.exit(1);
}

main().catch(handleError);
