/**
 * Observer Bootstrap
 *
 * Initializes all v2 components at app startup.
 * Call once during app initialization.
 */

import { startObserverService, stopObserverService } from './observer/service';
import { startContextEngine, stopContextEngine } from './observer/context-engine';
import { startSuggestionEngine, stopSuggestionEngine } from './observer/suggestion-engine';
import { autoApproveSuggestions } from './observer/task-curation';
import { settingsRepository } from './db/repositories/settings';

interface ObserverBootstrapOptions {
  githubToken?: string;
  enabled?: boolean;
}

let bootstrapped = false;

/**
 * Initialize the observer system.
 * Called from main.ts or electron main process.
 */
export async function initializeObserver(options: ObserverBootstrapOptions = {}): Promise<void> {
  if (bootstrapped) return;

  const enabled = options.enabled ?? settingsRepository.get<boolean>('observer_enabled') ?? true;

  if (!enabled) {
    console.log('Observer system disabled in settings');
    return;
  }

  console.log('Initializing observer system...');

  try {
    try {
      // 1. Start observation layer
      const githubToken = options.githubToken || (settingsRepository.get<string>('github_token') ?? undefined);
      await startObserverService(githubToken);

      // 2. Start context engine (runs inference every 10s)
      startContextEngine();

      // 3. Start suggestion engine (runs every 5 min)
      startSuggestionEngine();
    } catch (err) {
      console.error('Observer initialization error (tables may not exist yet):', err);
      // Continue with app startup even if observer tables don't exist yet
      // They'll be created on next migration run or next app restart
      return;
    }

    // 4. Auto-curate suggestions every 15 minutes
    setInterval(() => {
      try {
        autoApproveSuggestions();
      } catch (err) {
        console.debug('Auto-curation failed:', err);
      }
    }, 15 * 60 * 1000);

    bootstrapped = true;
    console.log('Observer system initialized');
  } catch (err) {
    console.error('Failed to initialize observer:', err);
    bootstrapped = false;
  }
}

/**
 * Shutdown the observer system.
 * Called on app shutdown.
 */
export async function shutdownObserver(): Promise<void> {
  if (!bootstrapped) return;

  console.log('Shutting down observer system...');

  try {
    stopSuggestionEngine();
    stopContextEngine();
    await stopObserverService();

    bootstrapped = false;
    console.log('Observer system shut down');
  } catch (err) {
    console.error('Error shutting down observer:', err);
  }
}

/**
 * Check if observer is initialized.
 */
export function isObserverInitialized(): boolean {
  return bootstrapped;
}
