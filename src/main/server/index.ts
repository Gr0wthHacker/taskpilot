/**
 * Local HTTP API server.
 *
 * Boots an Express app on `API_PORT` (7847), mounts every route module, and
 * sets up CORS, JSON body parsing, request logging, and a canonical
 * `{ error: { code, message } }` error envelope.
 *
 * As a side effect of booting, the server also:
 *   - ensures every required `~/.taskpilot/io/*` directory exists
 *   - starts the I/O watcher with handlers that delegate to the ingestion module
 *   - kicks off the background context refresh loop
 *   - attaches the SSE bridge that fans `ioEvents` out to renderer clients
 *
 * Each of those subsystems is wrapped in a try/catch so a single failure
 * doesn't take down the API. The watcher state is tracked in `watcher-state.ts`
 * so `/api/io/status` can surface it accurately.
 */

import http from 'node:http';

import cors from 'cors';
import express, {
  type Application,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { API_PORT } from '@/shared/constants';
import { getOrCreateApiToken, redactToken } from '@/main/api-auth';
import { ioEvents } from '@/main/io/events';
// Side-effect import: registers the recurrence completion hook with the
// tasks repository so marking a recurring task done spawns the next.
import '@/main/recurrence';
// Side-effect import: registers the pre-delete hook so removing a task
// scrubs references from other tasks' `context.links`.
import '@/main/links';
// Side-effect import: registers the pre-delete hook so removing a task
// wipes its attachments directory.
import '@/main/attachments';
// Side-effect import: registers the result_ingested listener that bumps
// the task's phase forward on a successful execute (Wave 15).
import '@/main/phases';
// Side-effect import: registers task/decision write + pre-delete hooks so the
// full-text search index stays incrementally in sync (Wave 17).
import '@/main/search/hooks';

import { ApiHttpError } from './errors';
import { authMiddleware, hostCheckMiddleware } from './middleware/auth';
import { idempotency, ValidationError } from './middleware';
import { attachmentsRouter } from './routes/attachments';
import { auditRouter } from './routes/audit';
import { backupsRouter } from './routes/backups';
import { briefingRouter } from './routes/briefing';
import { browserRouter } from './routes/browser';
import { businessesRouter } from './routes/businesses';
import { calendarRouter } from './routes/calendar';
import { calendarAuthRouter } from './routes/calendar-auth';
import { contentRouter } from './routes/content';
import { contextRouter } from './routes/context';
import { costRouter } from './routes/cost';
import { dataRouter, systemRouter } from './routes/data';
import { decisionsRouter, decisionsRootRouter } from './routes/decisions';
import { deliveryRouter } from './routes/delivery';
import { desktopRouter } from './routes/desktop';
import { feedbackRouter } from './routes/feedback';
import { githubRouter } from './routes/github';
import { gmailRouter } from './routes/gmail';
import { goalsRouter, taskGoalRouter } from './routes/goals';
import { graphRouter } from './routes/graph';
import { healthRouter } from './routes/health';
import { ioRouter } from './routes/io';
import { journalRouter } from './routes/journal';
import { taskLinksRouter, skillsRouter } from './routes/links';
import { lovableRouter } from './routes/lovable';
import { notionRouter } from './routes/notion';
import { oauthCallbackRouter } from './routes/oauth-callback';
import { onboardingRouter } from './routes/onboarding';
import { outputsRouter } from './routes/outputs';
import { knowledgeRouter } from './routes/knowledge';
import { memoryRouter } from './routes/memory';
import { claudeRunnerRouter } from './routes/claude-runner';
import {
  permissionsProfilesRouter,
  taskPermissionsRouter,
} from './routes/permissions';
import { phasesRouter, taskPhasesRouter } from './routes/phases';
import { planRouter } from './routes/plan';
import { redditRouter } from './routes/reddit';
import { reportsRouter } from './routes/reports';
import { searchRouter } from './routes/search';
import { statusReportRouter } from './routes/status-report';
import { resultsRouter } from './routes/results';
import { reviewRouter } from './routes/review';
import { schedulesRouter } from './routes/schedules';
import { settingsRouter } from './routes/settings';
import { slackRouter } from './routes/slack';
import { tasksRouter } from './routes/tasks';
import { telemetryRouter } from './routes/telemetry';
import { templatesRouter } from './routes/templates';
import { webRouter } from './routes/web';
import { setupObserverRoutes } from '@/main/observer/api';
import { webhooksRouter } from './routes/webhooks';
import { genericWebhooksRouter } from './routes/generic-webhooks';
import { webhooksConfigsRouter } from './routes/webhooks-configs';
import { importRouter } from './routes/import';
import {
  conversationsRouter,
  taskConversationsRouter,
} from './routes/conversations';
import { attachIoEventBridge, sseRouter } from './sse';
import { setWatcherState } from './watcher-state';

/* -------------------------------------------------------------------------- */
/*  Logging                                                                   */
/* -------------------------------------------------------------------------- */

function requestLogger(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req, res, next) => {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const durMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      // eslint-disable-next-line no-console
      console.log(
        `[taskpilot:api] ${req.method} ${req.originalUrl} ${res.statusCode} ${durMs.toFixed(1)}ms`,
      );
    });
    next();
  };
}

/* -------------------------------------------------------------------------- */
/*  Error envelope                                                            */
/* -------------------------------------------------------------------------- */

interface CanonicalErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function errorHandler(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (err, _req, res, _next) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (err instanceof ApiHttpError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err instanceof ValidationError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err instanceof SyntaxError && 'status' in err) {
      // Body-parser raises SyntaxError with .status=400 on malformed JSON.
      status = 400;
      code = 'invalid_json';
      message = err.message;
    } else if (err instanceof Error) {
      message = err.message;
    }

    const body: CanonicalErrorBody = { error: { code, message } };
    if (details !== undefined) body.error.details = details;

    // eslint-disable-next-line no-console
    console.log(
      `[taskpilot:api] error ${status} ${code} :: ${message}`,
    );

    res.status(status).json(body);
  };
}

/* -------------------------------------------------------------------------- */
/*  App construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Origins allowed to talk to the local API. The packaged renderer ships
 * under `file://` or `app://`; the dev server runs at `localhost:5173`. We
 * deliberately do NOT include a lenient `localhost:*` catch-all anymore —
 * any unknown port hitting this API should fail closed. Wave 10 / S8.
 */
const CORS_ORIGINS: readonly string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  // Packaged Electron renderers ship under `file://` or the custom `app://`
  // scheme. Both arrive at `cors()` as the literal origin string below.
  'file://',
  'app://',
];

interface BuildAppOptions {
  apiToken: string;
  /** Extra ports the Host-header guard should accept (e.g. ephemeral test
   * binds via `port: 0`). The canonical `API_PORT` is always accepted. */
  extraAllowedPorts?: ReadonlyArray<number>;
}

function buildApp(options: BuildAppOptions): Application {
  const app = express();

  // Host-header check is the very first middleware so DNS-rebinding attacks
  // never reach CORS, body parsing, or routes. Wave 10 / S8.
  app.use(
    hostCheckMiddleware({
      acceptedPorts: [API_PORT, ...(options.extraAllowedPorts ?? [])],
    }),
  );

  app.use(
    cors({
      origin(origin, cb) {
        // Allow same-origin / curl (no Origin header). Otherwise the origin
        // must be an exact match — no `localhost:*` catch-all, no regex
        // fallback.
        if (!origin) return cb(null, true);
        if (CORS_ORIGINS.includes(origin)) return cb(null, true);
        // `file://` and `app://` packaged renderers send origins that vary
        // by Electron version (sometimes `file://`, sometimes `app://app-id`).
        // Accept any URL whose origin starts with one of the whitelisted
        // schemes.
        if (origin.startsWith('file://') || origin.startsWith('app://')) {
          return cb(null, true);
        }
        return cb(new ApiHttpError(403, 'cors_denied', `Origin ${origin} not allowed`));
      },
      credentials: true,
    }),
  );

  // `/api/data/import` accepts full DB dumps which routinely exceed the 1mb
  // default. Mount a path-scoped JSON parser with a wider limit BEFORE the
  // global one so the size check at body-parser time uses 100mb on that path.
  // The global parser below short-circuits when `req.body` is already set.
  app.use('/api/data', express.json({ limit: '100mb' }));
  // GitHub webhook receiver must see the raw body so HMAC verification matches
  // what GitHub actually sent. Mount the router (which runs its own
  // `express.raw` capture) BEFORE the global JSON parser claims the stream.
  // Wave 10 — Agent C.
  app.use('/api/webhooks', webhooksRouter());
  // Wave 13 — Agent M. The generic webhook receiver shares the same
  // raw-body-for-HMAC concern and must also run before the global JSON
  // parser. Mounted under `/api/webhooks/incoming` so the registry CRUD
  // (mounted later, after the JSON parser) can sit at
  // `/api/webhooks/configs` without colliding.
  app.use('/api/webhooks/incoming', genericWebhooksRouter());
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger());

  // Bearer-token auth runs after body parsing so 401s carry the standard
  // canonical error envelope. The middleware allowlists `/api/health`,
  // `/api/config`, `/oauth/callback`, and `/api/webhooks/*`. The token is
  // captured at construction time — rotation requires a server restart.
  // Wave 10 / S8.
  //
  // Tests boot the server with `TASKPILOT_DISABLE_AUTH=1` so the existing
  // route-level integration suites don't have to thread auth headers
  // through every fetch. The dedicated `tests/api-auth.test.ts` suite
  // builds the middleware standalone to exercise the real auth path.
  if (process.env.TASKPILOT_DISABLE_AUTH !== '1') {
    app.use(authMiddleware(options.apiToken));
  }

  // Idempotency-Key support. Pass-through when the header is absent so
  // existing clients are unaffected; clients that send the header get
  // exactly-once semantics for the first 2xx response over a 24h window.
  // Mounted after auth so retries are scoped to the same authenticated
  // identity (the bearer token is currently per-install, so this is
  // effectively per-install — fine until we add scoped tokens).
  app.use(idempotency());

  // Mount routes ------------------------------------------------------------
  app.use('/api', healthRouter());
  app.use('/api', sseRouter());
  app.use('/api/tasks', tasksRouter());
  // Permissions live alongside tasks. Mount AFTER tasksRouter so existing
  // `:id/*` routes still win — the permissions router only adds new paths
  // (`:id/permissions`) that the main tasks router doesn't handle.
  app.use('/api/tasks', taskPermissionsRouter());
  // Task links (Wave 12 intelligence layer). Mounted under /api/tasks so the
  // :id/links/* paths sit alongside :id and :id/permissions.
  app.use('/api/tasks', taskLinksRouter());
  // File attachments (Wave 13). Mounted under /api/tasks so the
  // :id/attachments/* paths sit alongside :id/permissions / :id/links.
  app.use('/api/tasks', attachmentsRouter());
  // Task journal (Wave 15A). Adds GET /:id/journal under /api/tasks.
  app.use('/api/tasks', journalRouter());
  // Decision log (Wave 16). Adds GET/POST /:id/decisions under /api/tasks;
  // the DELETE /:id sibling lives at /api/decisions (keyed by decision id).
  app.use('/api/tasks', decisionsRouter());
  // Task outputs panel + briefing pack (Wave 15). Adds :id/outputs and
  // :id/briefing-pack under /api/tasks.
  app.use('/api/tasks', outputsRouter());
  // Task phase model (Wave 15). Adds :id/phase{,/advance,/regress}.
  app.use('/api/tasks', taskPhasesRouter());
  // Task → goal attach/detach (Wave 17). Adds POST :id/goal under /api/tasks.
  app.use('/api/tasks', taskGoalRouter());
  // Pipeline catalog CRUD (Wave 15).
  app.use('/api/phases', phasesRouter());
  app.use('/api/permissions', permissionsProfilesRouter());
  // Skills registry — listing, suggestion, custom registration.
  app.use('/api/skills', skillsRouter());
  // Mount calendar-auth BEFORE the generic calendar router so its routes
  // (e.g. /api/calendar/status, /api/calendar/auth/*) win over any catch-all
  // patterns in the main calendar router.
  app.use('/api/calendar', calendarAuthRouter());
  app.use('/api/calendar', calendarRouter());
  // Ambient monitor (v6) — capture, observations, deliberations, screenshots,
  // status. Bearer-protected like the rest; the Chrome extension authenticates
  // via the same `~/.taskpilot/api-token` Claude Code reads.
  app.use('/api/context', contextRouter());
  app.use('/api/io', ioRouter());
  app.use('/api/results', resultsRouter());
  app.use('/api/review', reviewRouter());
  // Recurring schedules (time-driven fan-out across goal repos).
  app.use('/api/schedules', schedulesRouter());
  // Full-text search across tasks/decisions/outputs/attachments (Wave 17).
  app.use('/api/search', searchRouter());
  app.use('/api/knowledge', knowledgeRouter());
  app.use('/api/memory', memoryRouter());
  app.use('/api/claude-runner', claudeRunnerRouter());
  app.use('/api/settings', settingsRouter());
  app.use('/api/templates', templatesRouter());
  app.use('/api/onboarding', onboardingRouter());
  // Observer system (v2 ambient intelligence).
  const observerRouter = express.Router();
  setupObserverRoutes(observerRouter);
  app.use('/api', observerRouter);
  // Data + system routes (Wave 7 power features). Body parsing for
  // `/api/data` uses the wider limit declared above.
  app.use('/api/data', dataRouter());
  app.use('/api/system', systemRouter());

  // Operational hardening (Wave 12 / Agent K): db backups + anonymous
  // telemetry collector. Telemetry is opt-in (default OFF); backups run
  // unconditionally daily with rotation.
  app.use('/api/backups', backupsRouter());
  app.use('/api/telemetry', telemetryRouter());

  // Encrypted append-only ambient audit log. Read-only — writes are wired
  // into the relevant repositories + the deliberation orchestrator/ingester
  // via `appendAuditEventSafe` so they can't be forged over HTTP.
  app.use('/api/audit', auditRouter());

  // Wave 13 — Agent N: cost tracking + feedback loop.
  app.use('/api/cost', costRouter());
  app.use('/api/feedback', feedbackRouter());

  // Wave 16: decision log delete (keyed by the decision's own id, so it
  // sits at its own top-level namespace rather than under /api/tasks).
  app.use('/api/decisions', decisionsRootRouter());

  // Wave 13 — Agent M: generic webhook config CRUD + bulk import.
  // These require the bearer token (the inbound receivers mounted above
  // use HMAC instead).
  app.use('/api/webhooks/configs', webhooksConfigsRouter());
  app.use('/api/import', importRouter());

  // Wave 18 — Claude Code session catalogue.
  app.use('/api/conversations', conversationsRouter());
  app.use('/api/tasks', taskConversationsRouter());

  app.use('/api/github', githubRouter());
  app.use('/api/gmail', gmailRouter());
  // Web search + fetch primitives. Pluggable search adapters
  // (Brave/Serper/DuckDuckGo) and a bounded HTML fetch with text extraction.
  app.use('/api/web', webRouter());
  // Managed Chrome browser control via CDP. Spawns an isolated profile under
  // `~/.taskpilot/chrome-profile/` on first use; the user's real Chrome
  // session is unaffected.
  app.use('/api/browser', browserRouter());
  // Desktop input — screenshot + keyboard + mouse. Gated by the
  // `desktop_input_enabled` setting (default false). Windows-only in v1;
  // returns 501 on other platforms.
  app.use('/api/desktop', desktopRouter());
  app.use('/api/slack', slackRouter());
  app.use('/api/notion', notionRouter());
  app.use('/api/plan', planRouter());
  app.use('/api/reddit', redditRouter());
  // Cross-task knowledge graph (Wave 17). Read-only — nodes + edges scoped by
  // all/workspace/tag/root.
  app.use('/api/graph', graphRouter());
  // Goals / Initiatives tier (Wave 17). CRUD + progress aggregation.
  app.use('/api/goals', goalsRouter());
  // Per-business status surface (projects.json driven).
  app.use('/api/businesses', businessesRouter());
  // Client delivery queue + templates (T693/T694).
  app.use('/api/delivery', deliveryRouter());
  // Publishing pipeline (long-form → DEAI → atomized → scheduled → published).
  app.use('/api/content', contentRouter());
  // Morning brief — auto-generated daily CEO update.
  app.use('/api/briefing', briefingRouter());
  // Status report routes (Wave 16E) own `/api/reports/status*`. Mounted
  // BEFORE the analytics reportsRouter so the status paths resolve here.
  app.use('/api/reports', statusReportRouter());
  app.use('/api/reports', reportsRouter());
  // Lovable per-task CRUD lives under /api/tasks/:id/lovable. Mounted at /api
  // so the path stays under the existing tasks namespace without colliding
  // with the main tasksRouter (which doesn't handle /lovable).
  app.use('/api', lovableRouter());

  // OAuth redirect target — mounted at the server root, NOT under `/api/`,
  // because Google sends the browser straight to this URL.
  app.use('/', oauthCallbackRouter());

  // 404 --------------------------------------------------------------------
  app.use((req, _res, next) => {
    next(
      new ApiHttpError(
        404,
        'route_not_found',
        `No route for ${req.method} ${req.originalUrl}`,
      ),
    );
  });

  // Error handler must come last ------------------------------------------
  app.use(errorHandler());

  return app;
}

/* -------------------------------------------------------------------------- */
/*  Subsystem boot                                                            */
/* -------------------------------------------------------------------------- */

interface SubsystemHandles {
  stopWatcher?: () => Promise<void>;
  stopContextRefresh?: () => void;
  stopAutoExecute?: () => void;
  stopSlackCapture?: () => void;
  stopGmailCapture?: () => void;
  stopNotionSync?: () => void;
  stopIssueSyncBack?: () => void;
  stopScheduledBackups?: () => void;
  stopTelemetry?: () => void;
  stopAuditRetention?: () => void;
  stopAutoSummary?: () => void;
  stopStatusReportScheduler?: () => void;
  stopSchedules?: () => void;
  stopKnowledge?: () => Promise<void>;
  stopTaskStats?: () => void;
  stopMemoryStats?: () => void;
  stopClaudeRunner?: () => Promise<void>;
  unregisterWatcherPausable?: () => void;
}

async function bootSubsystems(): Promise<SubsystemHandles> {
  const handles: SubsystemHandles = {};

  // I/O directories ---------------------------------------------------------
  try {
    const { ensureIoDirs } = await import('@/main/io/paths');
    await ensureIoDirs();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] ensureIoDirs failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Watcher -----------------------------------------------------------------
  try {
    const [watcherMod, ingestionMod, deliberationMod] = await Promise.all([
      import('@/main/io/watcher') as Promise<
        typeof import('@/main/io/watcher')
      >,
      import('@/main/io/ingestion') as Promise<
        typeof import('@/main/io/ingestion')
      >,
      // Deliberation ingestion. Lazy-loaded so non-Electron callers (CLI,
      // MCP, test harness) don't pull in the Electron-bound notifications
      // module until the watcher actually fires a result event.
      import('@/main/deliberation/ingestion') as Promise<
        typeof import('@/main/deliberation/ingestion')
      >,
    ]);

    const memoryMod = await import('@/main/memory/protocol');
    const businessesMod = await import('@/main/businesses');
    const handle = watcherMod.startWatcher({
      onDerivedFound: async (taskId, response) => {
        await ingestionMod.ingestDerived(taskId, response);
      },
      onResultFound: async (taskId, result, outputFiles) => {
        await ingestionMod.ingestResult(taskId, result, outputFiles);
      },
      onInboxFound: async (taskId, task) => {
        await ingestionMod.ingestInbox(taskId, task);
      },
      onDeliberatedFound: async (_batchId, result) => {
        await deliberationMod.ingestDeliberation(result);
      },
      onMemoryEnrichedFound: async (_memoryId, response) => {
        memoryMod.ingestEnrichResponse(response);
      },
      onStatusUpdateFound: async (_dropId, payload) => {
        await businessesMod.recordUpdate(payload.business, {
          at: payload.at ?? new Date().toISOString(),
          headline: payload.headline,
          ...(payload.what_changed !== undefined
            ? { what_changed: payload.what_changed }
            : {}),
          ...(payload.source !== undefined ? { source: payload.source } : {}),
          ...(payload.links !== undefined ? { links: payload.links } : {}),
        });
      },
      onError: (info) => {
        // eslint-disable-next-line no-console
        console.log(
          `[taskpilot:api] watcher error (${info.scope}): ${info.message}`,
        );
      },
    });

    setWatcherState('running');
    handles.stopWatcher = async () => {
      try {
        await handle.stop();
      } finally {
        setWatcherState('stopped');
      }
    };

    // Register the watcher as pausable so the restore handler can stop
    // dispatches before swapping the DB file. Pause uses the same stop()
    // path; resume restarts via a deferred boot of a fresh handle. Since
    // restoreBackup() forces a requires_restart anyway, resume here is a
    // best-effort to keep the process functional until the user actually
    // quits — we re-call the watcher boot on resume.
    try {
      const { registerPausable } = await import(
        '@/main/lifecycle/pause-registry'
      );
      const pausableHandle = registerPausable({
        name: 'io-watcher',
        pause: async () => {
          try {
            await handle.stop();
          } finally {
            setWatcherState('stopped');
          }
        },
        // Resume is best-effort: a clean resume of chokidar after stop
        // requires rebooting the handle. Since restore returns
        // requires_restart=true the user will reboot the app shortly;
        // we leave the watcher stopped until then so we never re-attach
        // to a partially-restored DB.
        resume: () => {
          // Intentionally a no-op. The next process boot will restart it.
        },
      });
      handles.unregisterWatcherPausable = () => pausableHandle.unregister();
    } catch {
      /* pause registry optional — restore still works, just no coordination */
    }
  } catch (err) {
    setWatcherState('error');
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] watcher boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Context refresh ---------------------------------------------------------
  try {
    const mod = (await import('@/main/io/context-refresh')) as {
      startContextRefresh?: () => () => void;
    };
    if (typeof mod.startContextRefresh === 'function') {
      handles.stopContextRefresh = mod.startContextRefresh();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] context refresh boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Search index (Wave 17) --------------------------------------------------
  // Build the FTS5 index once at boot from the current DB contents. The
  // rebuild is synchronous (better-sqlite3) and bounded by the local task
  // count, so it's cheap; it never throws (derived data). When FTS5 isn't
  // compiled in, the rebuild is a no-op and the query side falls back to a
  // LIKE scan. Incremental upserts are wired via the repository hooks +
  // ingestion, so this only needs to run once.
  try {
    const { rebuildIndex } = await import('@/main/search/indexer');
    const stats = rebuildIndex();
    // eslint-disable-next-line no-console
    console.log(
      `[taskpilot:api] search index built (fts=${stats.fts_available}): ${stats.tasks} tasks, ${stats.decisions} decisions, ${stats.executions} outputs, ${stats.attachments} attachments`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] search index build failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // SSE bridge --------------------------------------------------------------
  try {
    attachIoEventBridge();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] sse bridge attach failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Audit task CRUD ---------------------------------------------------------
  // Hooks the task repository's existing write + delete listeners into the
  // audit log. Idempotent — safe to re-run on every boot.
  try {
    const { installAuditTaskHooks } = await import('@/main/audit/task-hooks');
    installAuditTaskHooks();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] audit task hooks failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Auto completion summary (Wave 16) ---------------------------------------
  // Subscribe to `result_ingested` so a one-liner completion summary is
  // generated whenever a task reaches `done`. Ingestion ALSO fires this
  // inline on the done transition; the generator is a best-effort upsert onto
  // `context.completion_summary`, so this subscription is a safety net that
  // covers any path that emits the event without going through ingestion's
  // inline call. Both routes swallow errors and never block.
  try {
    const onResult = (payload: {
      taskId: string;
      result: { status: string };
    }): void => {
      if (payload.result?.status !== 'succeeded') return;
      void (async (): Promise<void> => {
        try {
          const mod = await import('@/main/auto-summary');
          await mod.generateAndStoreCompletionSummary(payload.taskId);
        } catch {
          /* non-fatal */
        }
      })();
    };
    ioEvents.on('result_ingested', onResult);
    handles.stopAutoSummary = (): void => {
      ioEvents.off('result_ingested', onResult);
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] auto-summary subscription failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Task stats tick ---------------------------------------------------------
  // Materialized counts for the sidebar badges + daily-plan view. Two refresh
  // paths:
  //   1. installTaskStatsHooks — subscribes to addOnTaskWritten +
  //      registerOnTaskPreDelete so any mutation triggers a debounced (200ms)
  //      recompute. This is the eager path.
  //   2. startTaskStatsTick — slow safety-net tick (every 10s) for any path
  //      that bypasses the repo write hooks (raw SQL, restore, etc).
  try {
    const {
      installTaskStatsHooks,
      startTaskStatsTick,
      stopTaskStatsTick,
    } = await import('@/main/task-stats');
    const stopHooks = await installTaskStatsHooks();
    startTaskStatsTick();
    handles.stopTaskStats = () => {
      try {
        stopHooks();
      } catch {
        /* non-fatal */
      }
      stopTaskStatsTick();
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] task-stats boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Memory stats tick -------------------------------------------------------
  // Same shape as task-stats: eager debounced refresh on writes, plus a slow
  // 10s safety-net tick. Best-effort — failure here only makes the sidebar
  // memory badge stale, not the data.
  try {
    const {
      installMemoryStatsHooks,
      startMemoryStatsTick,
      stopMemoryStatsTick,
    } = await import('@/main/memory/stats');
    const stopMemHooks = await installMemoryStatsHooks();
    startMemoryStatsTick();
    handles.stopMemoryStats = () => {
      try {
        stopMemHooks();
      } catch {
        /* non-fatal */
      }
      stopMemoryStatsTick();
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] memory-stats boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Claude auto-runner ------------------------------------------------------
  // Always start the loop. It self-suppresses every tick when the
  // `claude_runner_enabled` setting is off, so the cost when disabled is
  // a single Date.now() comparison + a re-armed timer.
  try {
    const { startClaudeRunner } = await import('@/main/claude-runner');
    const runner = startClaudeRunner();
    handles.stopClaudeRunner = runner.stop;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] claude-runner boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Auto-execute loop -------------------------------------------------------
  // Started unconditionally; the loop short-circuits each tick when the
  // `auto_execute_enabled` setting is off, so flipping the toggle at runtime
  // takes effect on the next event without needing a restart.
  try {
    const { startAutoExecute } = await import('@/main/auto-execute');
    const handle = startAutoExecute();
    handles.stopAutoExecute = handle.stop;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] auto-execute boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Knowledge base ----------------------------------------------------------
  // Ensure the knowledge root, run an initial reindex (catch files dropped
  // while the app was closed), and watch for changes. Best-effort.
  try {
    const { startKnowledge } = await import('@/main/knowledge');
    const handle = await startKnowledge();
    handles.stopKnowledge = handle.stop;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] knowledge boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Slack capture loop ------------------------------------------------------
  // Boots unconditionally; the loop short-circuits each tick when Slack
  // isn't configured or `agent_paused` is set, so the same start call works
  // whether or not a token has been pasted yet. Wave 11 / Agent D.
  try {
    const { startCaptureJob: startSlackCapture } = await import(
      '@/main/slack/capture'
    );
    const handle = startSlackCapture({ skipInitialTick: true });
    handles.stopSlackCapture = handle.stop;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] slack capture boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Gmail capture loop ------------------------------------------------------
  // Same shape as the Slack loop: boots unconditionally, each tick is a
  // no-op until OAuth grants land. Wave 11 / Agent E.
  try {
    const { startGmailCapture, stopGmailCapture } = await import('@/main/gmail');
    startGmailCapture();
    handles.stopGmailCapture = stopGmailCapture;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] gmail capture boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Notion mirror loop ------------------------------------------------------
  // One-way push from TaskPilot tasks → Notion pages. Each tick is a
  // no-op until the user connects a token and selects a database, so
  // booting unconditionally is cheap. Wave 13 / Agent L.
  try {
    const { startSyncJob } = await import('@/main/notion/sync');
    const handle = startSyncJob({ skipInitialTick: true });
    handles.stopNotionSync = handle.stop;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] notion sync boot failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // GitHub issue sync-back hook ---------------------------------------------
  // Installs a task-completion listener that mirrors task → issue state
  // (close on done, reopen on requeue) when the
  // `github_issues_sync_back` setting is true. Wave 13 / Agent L.
  try {
    const { installCompletionHook } = await import('@/main/github/issues-sync');
    const unsubscribe = installCompletionHook();
    handles.stopIssueSyncBack = unsubscribe;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] github issues sync-back hook failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Auto-launch reconciliation ---------------------------------------------
  // Read the persisted `auto_launch_enabled` setting and push it back into
  // Electron's login item. The DB is initialized by this point (the
  // watcher subsystem above touches it), so the settings repo is safe to
  // call. A no-op outside Electron.
  try {
    const { applyAutoLaunchOnBoot } = await import('@/main/auto-launch');
    applyAutoLaunchOnBoot();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(
      '[taskpilot:api] auto-launch reconcile failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Scheduled DB backups ----------------------------------------------------
  // Daily snapshot under `~/.taskpilot/backups/`, retaining the newest 14.
  // The boot snapshot is delayed a few seconds so any startup migration
  // churn settles first. Tests opt out via TASKPILOT_DISABLE_BACKUPS=1 so
  // the integration suite doesn't write into the user's home dir.
  if (process.env.TASKPILOT_DISABLE_BACKUPS !== '1') {
    try {
      const { startScheduledBackups } = await import('@/main/backups');
      const { setScheduledBackupsHandle } = await import(
        '@/main/backups/scheduler'
      );
      const handle = startScheduledBackups({ retainCount: 14, runOnBoot: true });
      setScheduledBackupsHandle(handle);
      handles.stopScheduledBackups = (): void => {
        try {
          handle.stop();
        } finally {
          setScheduledBackupsHandle(null);
        }
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:api] scheduled backups boot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Audit-log retention -----------------------------------------------------
  // Daily sweep that drops per-month audit files older than
  // `ambient_audit_retention_days` (default 90). The pruner is read-only with
  // respect to in-flight events; the boot delay keeps cold-start I/O quiet.
  // Tests opt out via TASKPILOT_DISABLE_AUDIT_RETENTION=1 so a fresh test
  // suite doesn't spin up a 24h interval timer.
  if (process.env.TASKPILOT_DISABLE_AUDIT_RETENTION !== '1') {
    try {
      const { startAuditRetention } = await import('@/main/audit/retention');
      const { settingsRepository } = await import(
        '@/main/db/repositories/settings'
      );
      let retentionDays = 90;
      try {
        const raw = settingsRepository.get('ambient_audit_retention_days');
        const n =
          typeof raw === 'number' ? raw : raw !== null ? Number(raw) : NaN;
        if (Number.isFinite(n) && n > 0) retentionDays = Math.floor(n);
      } catch {
        /* keep default */
      }
      const handle = startAuditRetention({ retentionDays });
      handles.stopAuditRetention = handle.stop;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:api] audit retention boot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Telemetry collector -----------------------------------------------------
  // Always-on local logging; upload only fires when the user has opted in
  // AND set an endpoint. Tests opt out via TASKPILOT_DISABLE_TELEMETRY=1.
  if (process.env.TASKPILOT_DISABLE_TELEMETRY !== '1') {
    try {
      const { startTelemetry, record } = await import('@/main/telemetry');
      const handle = startTelemetry();
      handles.stopTelemetry = handle.stop;
      // Log the launch event unconditionally — it carries no PII (just app
      // version + platform). The upload pump still respects the opt-in.
      record({ kind: 'launch' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:api] telemetry boot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Status report scheduler (Wave 16E) --------------------------------------
  // Minute-tick cron loop; each tick is a no-op until the user enables the
  // schedule (`status_report_enabled`) and the cron matches. Booting
  // unconditionally is cheap (a single unref'd interval). Tests opt out via
  // TASKPILOT_DISABLE_STATUS_REPORT=1 so the integration suite doesn't spin
  // up a timer that could fire mid-run.
  if (process.env.TASKPILOT_DISABLE_STATUS_REPORT !== '1') {
    try {
      const { startScheduler } = await import('@/main/reports/report-scheduler');
      const handle = startScheduler({ skipInitialTick: true });
      handles.stopStatusReportScheduler = handle.stop;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:api] status report scheduler boot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Recurring schedules scheduler (v5) --------------------------------------
  // Minute-tick loop that fires schedules whose next_fire_at has passed.
  // Each fire fans out (per repo in linked goal × per child template). Boots
  // unconditionally; the loop is a no-op when no schedules are due. Tests
  // disable via TASKPILOT_DISABLE_SCHEDULES=1 so timer fires can't sneak
  // into integration runs.
  if (process.env.TASKPILOT_DISABLE_SCHEDULES !== '1') {
    try {
      const { startSchedulesScheduler } = await import(
        '@/main/schedules/scheduler'
      );
      const handle = startSchedulesScheduler({ skipInitialTick: false });
      handles.stopSchedules = handle.stop;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(
        '[taskpilot:api] schedules scheduler boot failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Morning brief + boot tasks — once per day, on first launch.
  // Both are best-effort: a failure here MUST NOT block API boot. Tests
  // opt out via TASKPILOT_DISABLE_BOOT_TASKS=1 so the integration suite
  // doesn't seed tasks in the wrong DB.
  if (process.env.TASKPILOT_DISABLE_BOOT_TASKS !== '1') {
    void (async () => {
      try {
        const { generateMorningBrief, isMorningBriefDue } = await import(
          '@/main/briefing/morning-brief'
        );
        if (isMorningBriefDue()) {
          const result = await generateMorningBrief();
          // eslint-disable-next-line no-console
          console.log(
            `[taskpilot:api] morning brief generated (${result.date}, ${result.bytes} bytes)`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          '[taskpilot:api] morning brief generation failed:',
          err instanceof Error ? err.message : String(err),
        );
      }

      try {
        const { fireBootTasksIfDue } = await import('@/main/boot-tasks');
        const summary = fireBootTasksIfDue();
        if (summary.fired > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[taskpilot:api] boot tasks fired: ${summary.fired} ` +
              `(ids: ${summary.task_ids.join(', ')})`,
          );
        } else if (summary.skipped_reason) {
          // eslint-disable-next-line no-console
          console.log(
            `[taskpilot:api] boot tasks skipped: ${summary.skipped_reason}`,
          );
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(
          '[taskpilot:api] boot tasks failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  }

  return handles;
}

/* -------------------------------------------------------------------------- */
/*  Public entry                                                              */
/* -------------------------------------------------------------------------- */

export interface ApiServerHandle {
  port: number;
  stop: () => Promise<void>;
}

let serverHandle: ApiServerHandle | null = null;

/**
 * Boot the API server. Returns once it's listening on the chosen port.
 * Calling twice is a no-op; the existing handle is returned.
 *
 * @param options.port - Override the default `API_PORT`. Used by tests that
 *   need to run multiple servers in parallel without colliding on the
 *   well-known port. Production callers should leave this unset.
 */
export async function startApiServer(
  options: { port?: number } = {},
): Promise<ApiServerHandle> {
  if (serverHandle) return serverHandle;

  const port = options.port ?? API_PORT;

  // Resolve the bearer token first so the middleware factory can capture it
  // at construction time. Token errors never surface the value itself —
  // logs go through `redactToken()`.
  const apiToken = await getOrCreateApiToken();
  // Touch the helper so it stays imported even when no caller currently
  // needs it (defensive — guarantees we have a grep-able mask helper).
  void redactToken;

  // Bind the http listener first to learn the ephemeral port (when port=0),
  // then build the Express app with that port wired into the host-check
  // middleware's allowed-port set.
  const httpServer = http.createServer();

  const boundPort = await new Promise<number>((resolve, reject) => {
    const onError = (err: unknown): void => {
      httpServer.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      const addr = httpServer.address();
      const resolved =
        addr && typeof addr === 'object' ? addr.port : port;
      resolve(resolved);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    // Pass 0 to bind an OS-assigned ephemeral port; otherwise use the
    // requested value.
    httpServer.listen(port, '127.0.0.1');
  });

  const app = buildApp({
    apiToken,
    extraAllowedPorts: boundPort === API_PORT ? [] : [boundPort],
  });
  // Attach the request handler now that we know which port to authorize.
  httpServer.on('request', app);

  // eslint-disable-next-line no-console
  console.log(`[taskpilot:api] listening on http://127.0.0.1:${boundPort}`);

  const subsystems = await bootSubsystems();

  const stop = async (): Promise<void> => {
    if (subsystems.stopKnowledge) {
      try {
        await subsystems.stopKnowledge();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopAutoExecute) {
      try {
        subsystems.stopAutoExecute();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopSlackCapture) {
      try {
        subsystems.stopSlackCapture();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopGmailCapture) {
      try {
        subsystems.stopGmailCapture();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopNotionSync) {
      try {
        subsystems.stopNotionSync();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopIssueSyncBack) {
      try {
        subsystems.stopIssueSyncBack();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopWatcher) {
      await subsystems.stopWatcher().catch(() => {
        /* non-fatal */
      });
    }
    if (subsystems.stopTaskStats) {
      try {
        subsystems.stopTaskStats();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopMemoryStats) {
      try {
        subsystems.stopMemoryStats();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopClaudeRunner) {
      await subsystems.stopClaudeRunner().catch(() => {
        /* non-fatal */
      });
    }
    if (subsystems.stopContextRefresh) {
      try {
        subsystems.stopContextRefresh();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopScheduledBackups) {
      try {
        subsystems.stopScheduledBackups();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopTelemetry) {
      try {
        subsystems.stopTelemetry();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopAuditRetention) {
      try {
        subsystems.stopAuditRetention();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopAutoSummary) {
      try {
        subsystems.stopAutoSummary();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopStatusReportScheduler) {
      try {
        subsystems.stopStatusReportScheduler();
      } catch {
        /* non-fatal */
      }
    }
    if (subsystems.stopSchedules) {
      try {
        subsystems.stopSchedules();
      } catch {
        /* non-fatal */
      }
    }
    // Browser sessions + managed Chrome. Best-effort: a half-shutdown server
    // shouldn't be blocked by a stuck Chrome process.
    try {
      const { closeAllSessions, stopChrome } = await import('@/main/browser');
      await closeAllSessions();
      await stopChrome();
    } catch {
      /* non-fatal */
    }
    ioEvents.removeAllListeners();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    serverHandle = null;
  };

  serverHandle = { port: boundPort, stop };
  return serverHandle;
}
