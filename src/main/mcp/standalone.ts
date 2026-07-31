/**
 * Standalone MCP server runner for `npm run mcp`.
 *
 * Boots `startMcpServer()` outside of Electron — this is what MCP clients
 * (Claude Desktop, Claude Code, claude.ai's local MCP integrations) launch
 * via stdio. The process stays alive as long as the stdio transport is
 * open; SIGINT/SIGTERM trigger a graceful shutdown.
 *
 * IMPORTANT: all diagnostic output goes to stderr. The stdio transport uses
 * stdout for JSON-RPC frames — writing anything else to it corrupts the
 * client connection.
 */

import { closeDb } from '@/main/db';
import { readApiToken } from '@/main/api-auth';

import { startMcpServer } from './index';

let shuttingDown = false;

/**
 * Defensive: load the per-install bearer token at module boot so any future
 * MCP tool that needs to hit the local HTTP API has a value to send. The
 * MCP server runs in the same process boundary as the API and most tools
 * call into the DB directly, so this is rarely necessary — but the loader
 * is cheap and surfacing the token early means we never have a tool fail
 * mid-call because the file disappeared.
 *
 * Errors are swallowed: if the token file is missing the MCP server is
 * still expected to operate (DB-only tools don't need it).
 */
async function preloadApiToken(): Promise<void> {
  try {
    const token = await readApiToken();
    if (token) {
      // eslint-disable-next-line no-process-env
      process.env.TASKPILOT_API_TOKEN_PRELOADED = '1';
    }
  } catch {
    /* non-fatal — DB-only tools don't need it. */
  }
}

function logStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  await preloadApiToken();
  const handle = await startMcpServer('stdio');
  logStderr('[taskpilot:mcp] server up on stdio');

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logStderr(`[taskpilot:mcp] received ${signal}, shutting down…`);
    void handle
      .stop()
      .catch((err) => {
        logStderr(
          `[taskpilot:mcp] shutdown error: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        try {
          closeDb();
        } catch {
          // best-effort
        }
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Don't die silently — log and continue. Most repository / FS exceptions
  // are recoverable and we don't want a single bad tool call to take down
  // the whole MCP integration.
  process.on('unhandledRejection', (reason) => {
    logStderr(
      `[taskpilot:mcp] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  });
  process.on('uncaughtException', (err) => {
    logStderr(`[taskpilot:mcp] uncaughtException: ${err.message}`);
  });
}

main().catch((err) => {
  logStderr(
    `[taskpilot:mcp] failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
