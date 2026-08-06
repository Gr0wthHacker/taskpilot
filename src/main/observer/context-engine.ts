/**
 * Context Engine - Phase 2
 *
 * Maintains live model of "what is Jack working on right now?"
 * Runs inference every 10 seconds to update:
 *  - Current project
 *  - Active research threads
 *  - Blockers
 *  - Candidate next steps
 */

import {
  getContextStateDecoded,
  updateContextState,
} from '@/main/db/repositories/context-state';
import {
  listObservationEvents,
  countObservationEventsBySource,
} from '@/main/db/repositories/observation-events';
import {
  getActiveResearchThreads,
  findResearchThreadByQuery,
  createResearchThread,
  updateResearchThread,
  getResearchThreadDecoded,
} from '@/main/db/repositories/research-threads';
import type { ResearchThread } from '@/shared/schema-v2';

interface InferenceState {
  running: boolean;
  interval: NodeJS.Timeout | null;
}

const state: InferenceState = {
  running: false,
  interval: null,
};

/**
 * Start the context engine. Runs inference every 10 seconds.
 */
export function startContextEngine(): void {
  if (state.running) return;
  state.running = true;

  // Run once immediately
  runInference().catch(console.debug);

  // Then every 10 seconds
  state.interval = setInterval(() => {
    runInference().catch(console.debug);
  }, 10_000);
}

/**
 * Stop the context engine.
 */
export function stopContextEngine(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.running = false;
}

/**
 * Single inference pass: update context state based on recent observations.
 */
async function runInference(): Promise<void> {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  // Get recent events
  const recentEvents = listObservationEvents({
    startTime: twoHoursAgo,
  });

  // 1. Infer current project
  const currentProject = inferCurrentProject(recentEvents);

  // 2. Link events to research threads
  await linkEventsToThreads(recentEvents);

  // 3. Get active threads
  const activeThreads = getActiveResearchThreads(120); // Last 2 hours
  const activeThreadsJson = JSON.stringify(
    activeThreads.map((t) => ({
      id: t.id,
      query: t.query,
      status: t.status,
      last_active: t.last_active,
    }))
  );

  // 4. Infer blockers
  const blockers = inferBlockers(recentEvents, oneHourAgo);

  // 5. Infer candidate next steps
  const candidates = inferCandidateThreads(recentEvents, currentProject);

  // Update context state
  updateContextState({
    current_project_name: currentProject?.name || null,
    current_project_repo: currentProject?.repo || null,
    current_project_goal: currentProject?.goal || null,
    current_project_started_at: currentProject?.started_at || null,
    current_project_confidence: currentProject?.confidence || 0,
    research_threads: activeThreadsJson,
    blockers: JSON.stringify(blockers),
    candidate_threads: JSON.stringify(candidates),
  });
}

/**
 * Infer the current project based on file changes in the last 2 hours.
 */
function inferCurrentProject(events: any[]): { name: string; repo: string; goal?: string; started_at: string; confidence: number } | null {
  // Group code change events by repo/directory
  const codeEvents = events.filter((e) => e.source === 'code');
  if (codeEvents.length === 0) return null;

  // Extract repos/directories from file paths
  const repos: Record<string, number> = {};
  for (const event of codeEvents) {
    const data = JSON.parse(event.data);
    const path = data.path || '';

    // Try to extract repo name from path
    // e.g., /home/jack/projects/taskpilot/src/... → taskpilot
    const match = path.match(/\/([a-z0-9_-]+)\/src\/|\/([a-z0-9_-]+)\/package\.json/i);
    const repo = match ? match[1] || match[2] : 'unknown';

    repos[repo] = (repos[repo] || 0) + 1;
  }

  // Most-edited repo is the current project
  const currentRepo = Object.entries(repos).sort(([, a], [, b]) => b - a)[0];
  if (!currentRepo) return null;

  const [repo, count] = currentRepo;
  const confidence = Math.min(count / 5, 1.0); // Normalize to 0-1

  return {
    name: repo,
    repo,
    started_at: new Date().toISOString(),
    confidence,
  };
}

/**
 * Link new observation events to research threads.
 * Creates new threads for novel search queries; updates existing ones.
 */
async function linkEventsToThreads(events: any[]): Promise<void> {
  const searchEvents = events.filter((e) => e.source === 'search');

  for (const event of searchEvents) {
    const data = JSON.parse(event.data);
    const query = data.query || '';
    if (!query) continue;

    // Check if thread exists
    let thread = findResearchThreadByQuery(query);

    if (!thread) {
      // Create new thread
      thread = createResearchThread({
        query,
        started_at: event.timestamp,
        last_active: event.timestamp,
        status: 'active',
        observation_event_ids: JSON.stringify([event.id]),
      });
    } else {
      // Update existing thread
      const decoded = getResearchThreadDecoded(thread);
      const eventIds = [...decoded.observation_event_ids, event.id];

      updateResearchThread(thread.id, {
        last_active: event.timestamp,
        observation_event_ids: JSON.stringify(eventIds),
      });
    }
  }
}

/**
 * Infer blockers from events.
 * Examples: PR waiting for review, test failing, file not saved.
 */
function inferBlockers(events: any[], withinTimeframe: string): Array<{ type: string; description: string; duration_minutes: number }> {
  const blockers: Array<{ type: string; description: string; duration_minutes: number }> = [];

  // Detect GitHub activity: PRs waiting for review
  const prEvents = events.filter((e) => e.source === 'github' && JSON.parse(e.data).type === 'PullRequest');
  for (const event of prEvents) {
    const data = JSON.parse(event.data);
    if (data.action === 'opened') {
      const now = new Date().getTime();
      const eventTime = new Date(event.timestamp).getTime();
      const durationMinutes = Math.floor((now - eventTime) / 60000);

      blockers.push({
        type: 'waiting_for_review',
        description: `PR #${data.pr_number}: "${data.pr_title}" — waiting for review`,
        duration_minutes: durationMinutes,
      });
    }
  }

  return blockers;
}

/**
 * Infer candidate next steps based on context.
 * Examples: next file in sequence, follow-up from research, risk to address.
 */
function inferCandidateThreads(
  events: any[],
  currentProject: any
): Array<{ type: string; description: string; priority: string; evidence: string[] }> {
  const candidates: Array<{ type: string; description: string; priority: string; evidence: string[] }> = [];

  // If working on tests, suggest running test suite
  const testEvents = events.filter((e) => e.source === 'code' && JSON.parse(e.data).extension === '.test.ts');
  if (testEvents.length > 0) {
    candidates.push({
      type: 'next_file',
      description: 'Run test suite to validate changes',
      priority: 'high',
      evidence: ['test_file_modified'],
    });
  }

  // If research is active, suggest related reading
  const searchEvents = events.filter((e) => e.source === 'search');
  if (searchEvents.length > 0) {
    candidates.push({
      type: 'follow_up',
      description: 'Deep dive into research findings',
      priority: 'medium',
      evidence: ['active_research'],
    });
  }

  // If no commits in a while but files changed, suggest commit
  const codeChanges = events.filter((e) => e.source === 'code');
  if (codeChanges.length > 0) {
    candidates.push({
      type: 'next_file',
      description: 'Commit recent changes',
      priority: 'medium',
      evidence: ['uncommitted_changes'],
    });
  }

  return candidates;
}
