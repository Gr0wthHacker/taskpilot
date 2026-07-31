import { EventEmitter } from 'node:events';

import type {
  ContextObservation,
  Deliberation,
  DerivationResponse,
  ExecutionResult,
  Task,
} from '@/shared/types';
import type { DeliberationResult } from '@/shared/io-schemas';

/**
 * Reason a task entered the review queue. Drives the filter in the renderer
 * Review view and lets downstream listeners discriminate without re-reading
 * the task.
 */
export type ReviewReason = 'derivation' | 'result' | 'failed';

/**
 * Map of event names to their listener payload tuples.
 *
 * Every entry in {@link IoEvents} corresponds to a single event the I/O
 * subsystem may emit. The payload tuple matches the arguments listeners
 * will receive.
 */
export interface IoEvents extends Record<string, unknown[]> {
  /** Emitted after a derivation response has been ingested into the DB. */
  derived_ingested: [{ taskId: string; response: DerivationResponse; childIds: string[] }];

  /** Emitted after an execution result has been ingested into the DB. */
  result_ingested: [{ taskId: string; result: ExecutionResult; outputFiles: string[] }];

  /** Emitted after a new inbox task file has been ingested into the DB. */
  inbox_ingested: [{ taskId: string; task: Task }];

  /** Emitted when the watcher encounters a recoverable error. */
  io_error: [{ scope: string; message: string; path?: string; error?: unknown }];

  /** Emitted whenever the pipeline counts may have changed. */
  pipeline_changed: [{ reason: string }];

  /**
   * Emitted when one or more tasks become eligible for the human review
   * queue. The renderer uses this to badge the sidebar without polling.
   */
  review_added: [Array<{ taskId: string; reason: ReviewReason }>];

  /**
   * Emitted after a deliberation request has been written to
   * `~/.taskpilot/io/deliberate/<batch_id>.json` and the corresponding
   * `deliberations` row inserted in `status='pending'`.
   */
  deliberation_requested: [
    { deliberationId: string; batchId: string; observationIds: string[] },
  ];

  /**
   * Emitted immediately after a `context_observations` row has been persisted
   * via `POST /api/context/capture` or `POST /api/context/capture/batch`. The
   * ambient monitor batcher listens for this to maybe-fire a deliberation when
   * the unbatched queue crosses the configured size threshold.
   */
  observation_captured: [ContextObservation];

  /**
   * Emitted after a deliberation result has been ingested. The row is now
   * `completed` (or `failed`/`skipped`) and any side-effects (task creation,
   * notification) have already fired.
   */
  deliberation_ingested: [
    {
      deliberationId: string;
      batchId: string;
      result: DeliberationResult;
      deliberation: Deliberation;
    },
  ];

  /**
   * Emitted after a Claude Code conversation has been ingested or updated in
   * the catalogue. `kind` distinguishes a fresh insert from a content-hash
   * change; the renderer uses it to invalidate the Conversations list query
   * without a full poll.
   */
  conversation_ingested: [
    {
      conversationId: string;
      sessionId: string;
      kind: 'created' | 'updated' | 'compressed';
      linkedTaskIds: string[];
    },
  ];

  /**
   * Fired after a memory enrichment response is ingested (either successful
   * or failed). Renderer invalidates `['memory']` so list + detail refresh.
   */
  memory_enriched: [
    {
      memory_id: string;
      status: 'enriched' | 'failed';
    },
  ];

  /**
   * Fired when an integration (calendar, gmail, github, slack, notion, etc.)
   * detects it's no longer authenticated — typically after an OAuth refresh
   * failure or a revoked PAT. Renderer surfaces a "Reconnect" banner. The
   * event repeats safely; consumers should dedupe by integration+status.
   */
  integration_status: [
    {
      integration: 'calendar' | 'gmail' | 'github' | 'slack' | 'notion';
      status: 'connected' | 'disconnected' | 'rate_limited' | 'error';
      message?: string;
      at: string;
    },
  ];

  /**
   * Fired after a per-business status delta has been appended (via the io
   * watcher or the HTTP endpoint). Renderer uses this to invalidate the
   * Businesses query without polling.
   */
  business_status_updated: [{ tag: string; headline: string; at: string }];
}

/**
 * Typed event emitter with strongly typed `on`/`once`/`off`/`emit` signatures.
 *
 * Wraps Node's `EventEmitter` so consumers get IntelliSense for every event
 * defined in {@link IoEvents}.
 */
export class TypedEmitter<TEvents extends Record<string, unknown[]>> {
  private readonly emitter = new EventEmitter();

  on<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof TEvents & string>(
    event: K,
    listener: (...args: TEvents[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof TEvents & string>(event: K, ...args: TEvents[K]): boolean {
    return this.emitter.emit(event, ...args);
  }

  removeAllListeners<K extends keyof TEvents & string>(event?: K): this {
    if (event === undefined) {
      this.emitter.removeAllListeners();
    } else {
      this.emitter.removeAllListeners(event);
    }
    return this;
  }

  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.emitter.listenerCount(event);
  }
}

/**
 * Process-wide singleton used by the I/O subsystem to broadcast lifecycle
 * events. The API server, MCP server, and IPC layer all subscribe to this
 * emitter so they can push updates to clients.
 */
export const ioEvents: TypedEmitter<IoEvents> = new TypedEmitter<IoEvents>();
