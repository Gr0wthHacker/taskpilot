/**
 * Standalone API server runner for `npm run server`.
 *
 * Boots `startApiServer()` outside of Electron — useful for headless dev,
 * Claude Code workflows, and integration tests. The process stays alive as
 * long as the server is listening; SIGINT/SIGTERM trigger a graceful shutdown
 * that also stops the watcher and context refresh loop.
 */

import { startApiServer } from './index';

let shuttingDown = false;

async function main(): Promise<void> {
  const handle = await startApiServer();
  // eslint-disable-next-line no-console
  console.log(
    `[taskpilot:server] standalone API server up on port ${handle.port}`,
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[taskpilot:server] received ${signal}, shutting down…`);
    void handle
      .stop()
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.log(
          '[taskpilot:server] shutdown error:',
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Surface unhandled errors so the process doesn't die silently. We log and
  // continue running — most repository/watcher exceptions are recoverable.
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:server] unhandledRejection:',
      reason instanceof Error ? reason.message : String(reason),
    );
  });
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.log('[taskpilot:server] uncaughtException:', err.message);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[taskpilot:server] failed to start:',
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
  process.exit(1);
});
