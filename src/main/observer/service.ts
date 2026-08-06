/**
 * Observer service.
 * Orchestrates all collectors and ingests events into the database.
 * This is the core of Phase 1.
 */

import {
  registerCollector,
  onObservationEvent,
  startObservers,
  stopObservers,
  getCollectorStatus,
  type ObservationEventPayload,
} from './collectors/base';
import { BrowserCollector } from './collectors/browser';
import { CodeCollector } from './collectors/code';
import { GitHubCollector } from './collectors/github';
import { NotesCollector } from './collectors/notes';
import { createObservationEvent } from '@/main/db/repositories/observation-events';

let unsubscribeHandler: (() => void) | null = null;

/**
 * Initialize and start the observer service.
 * Call once at app boot.
 */
export async function startObserverService(githubToken?: string): Promise<void> {
  // Register all collectors
  registerCollector(new CodeCollector());
  registerCollector(new BrowserCollector());
  registerCollector(new GitHubCollector(githubToken));
  registerCollector(new NotesCollector());

  // Subscribe to all observation events
  unsubscribeHandler = onObservationEvent((event) => {
    // Ingest into database
    try {
      createObservationEvent({
        timestamp: new Date().toISOString(),
        source: event.source,
        type: event.type,
        data: JSON.stringify(event.data),
        raw: event.raw,
        tags: event.tags ? JSON.stringify(event.tags) : null,
        confidence: event.confidence ?? 1.0,
      });
    } catch (err) {
      console.debug('Observer: failed to ingest event', err);
    }
  });

  // Start all collectors
  await startObservers();

  console.log('Observer service started');
}

/**
 * Stop the observer service.
 * Call on app shutdown.
 */
export async function stopObserverService(): Promise<void> {
  if (unsubscribeHandler) {
    unsubscribeHandler();
    unsubscribeHandler = null;
  }

  await stopObservers();

  console.log('Observer service stopped');
}

/**
 * Get status of all collectors.
 */
export function getObserverStatus(): Array<{ name: string; running: boolean }> {
  return getCollectorStatus();
}

/**
 * Manually emit an observation (for testing or manual logging).
 */
export function logObservation(event: Omit<ObservationEventPayload, 'confidence'> & { confidence?: number }): void {
  createObservationEvent({
    timestamp: new Date().toISOString(),
    source: event.source,
    type: event.type,
    data: JSON.stringify(event.data),
    raw: event.raw,
    tags: event.tags ? JSON.stringify(event.tags) : null,
    confidence: event.confidence ?? 0.9,
  });
}
