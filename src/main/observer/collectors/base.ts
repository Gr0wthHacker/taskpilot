/**
 * Base collector interface.
 * Each data source (browser, GitHub, code, etc.) implements this.
 */

export interface ObserverCollector {
  /**
   * Start collecting events. Called at app boot.
   * Should set up listeners, API polling, file watchers, etc.
   */
  start(): Promise<void>;

  /**
   * Stop collecting. Called on app shutdown.
   */
  stop(): Promise<void>;

  /**
   * Human-readable name for this collector.
   */
  name: string;

  /**
   * Whether the collector is currently active.
   */
  isRunning(): boolean;
}

/**
 * All collectors fire a common event type through the observer bus.
 */
export interface ObservationEventPayload {
  source: 'browser' | 'github' | 'code' | 'search' | 'notes' | 'terminal';
  type: string;
  data: Record<string, unknown>;
  raw?: string;
  tags?: string[];
  confidence?: number;
}

/**
 * Global collector registry and event bus.
 */
let collectors: ObserverCollector[] = [];
let eventHandlers: Array<(event: ObservationEventPayload) => void> = [];
let isRunning = false;

export function registerCollector(collector: ObserverCollector): void {
  collectors.push(collector);
}

export function onObservationEvent(handler: (event: ObservationEventPayload) => void): () => void {
  eventHandlers.push(handler);
  // Return unsubscribe function
  return () => {
    eventHandlers = eventHandlers.filter((h) => h !== handler);
  };
}

/**
 * Emit an observation event (called by collectors).
 */
export function emitObservation(event: ObservationEventPayload): void {
  for (const handler of eventHandlers) {
    handler(event);
  }
}

/**
 * Start all registered collectors.
 */
export async function startObservers(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  await Promise.allSettled(collectors.map((c) => c.start().catch(() => {})));
}

/**
 * Stop all collectors.
 */
export async function stopObservers(): Promise<void> {
  if (!isRunning) return;
  isRunning = false;

  await Promise.allSettled(collectors.map((c) => c.stop().catch(() => {})));
}

/**
 * Get current collector status.
 */
export function getCollectorStatus(): Array<{ name: string; running: boolean }> {
  return collectors.map((c) => ({
    name: c.name,
    running: c.isRunning(),
  }));
}
