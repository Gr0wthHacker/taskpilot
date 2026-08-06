/**
 * Suggestion Engine - Phase 3
 *
 * Generates ranked suggestions based on context.
 * 4 types:
 *  1. Next Steps (unblock critical path)
 *  2. Related Research (similar queries/docs)
 *  3. Risks & Gaps (missing tests, documentation, etc.)
 *  4. Cross-Project Connections (reuse patterns)
 *
 * Runs every 5 minutes, generates top 3-5 suggestions.
 */

import {
  getContextStateDecoded,
} from '@/main/db/repositories/context-state';
import {
  getActiveSuggestions,
  createSuggestion,
  dismissSuggestion as dismissDb,
} from '@/main/db/repositories/suggestions-repo';
import { listObservationEvents } from '@/main/db/repositories/observation-events';
import type { Suggestion } from '@/shared/schema-v2';

interface SuggestionCandidate {
  type: 'next_step' | 'related_research' | 'risk' | 'connection';
  title: string;
  description: string;
  urgency: 'high' | 'medium' | 'low';
  action: string;
  estimated_minutes: number;
  confidence: number;
  evidence: string[];
}

interface SuggestionEngineState {
  running: boolean;
  interval: NodeJS.Timeout | null;
  lastGenerated: Set<string>; // Dedup suggestions
}

const state: SuggestionEngineState = {
  running: false,
  interval: null,
  lastGenerated: new Set(),
};

/**
 * Start the suggestion engine. Runs every 5 minutes.
 */
export function startSuggestionEngine(): void {
  if (state.running) return;
  state.running = true;

  // Run once after 1 minute (let context stabilize)
  setTimeout(() => {
    generateSuggestions().catch(console.debug);
  }, 60_000);

  // Then every 5 minutes
  state.interval = setInterval(() => {
    generateSuggestions().catch(console.debug);
  }, 5 * 60 * 1000);
}

/**
 * Stop the suggestion engine.
 */
export function stopSuggestionEngine(): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.running = false;
}

/**
 * Generate and rank suggestions based on current context.
 */
async function generateSuggestions(): Promise<Suggestion[]> {
  const context = getContextStateDecoded();

  // Generate candidates from all 4 types
  const allCandidates: SuggestionCandidate[] = [
    ...generateNextStepSuggestions(context),
    ...generateRelatedResearchSuggestions(context),
    ...generateRiskSuggestions(context),
    ...generateConnectionSuggestions(context),
  ];

  // Rank by score
  const ranked = rankSuggestions(allCandidates);

  // Filter to top 5, avoid duplicates
  const topSuggestions = ranked
    .slice(0, 5)
    .filter((s) => {
      const key = `${s.type}:${s.title}`;
      if (state.lastGenerated.has(key)) return false;
      state.lastGenerated.add(key);
      return true;
    });

  // Create in DB
  const created: Suggestion[] = [];
  for (let i = 0; i < topSuggestions.length; i++) {
    const s = topSuggestions[i];
    const suggestion = createSuggestion({
      rank: i + 1,
      type: s.type,
      title: s.title,
      description: s.description,
      urgency: s.urgency,
      action: s.action,
      estimated_minutes: s.estimated_minutes,
      confidence: s.confidence,
      evidence: JSON.stringify(s.evidence),
    });
    created.push(suggestion);
  }

  return created;
}

/**
 * Generate "next step" suggestions.
 * Unblock critical path: PR waiting, test failing, deployment needed.
 */
function generateNextStepSuggestions(context: any): SuggestionCandidate[] {
  const suggestions: SuggestionCandidate[] = [];

  // From context blockers
  const blockers = context.blockers || [];
  for (const blocker of blockers) {
    if (blocker.type === 'waiting_for_review') {
      suggestions.push({
        type: 'next_step',
        title: `Unblock: ${blocker.description}`,
        description: `This has been waiting for ${Math.floor(blocker.duration_minutes / 60)} hours. Consider following up.`,
        urgency: blocker.duration_minutes > 120 ? 'high' : 'medium',
        action: 'Review PR',
        estimated_minutes: 15,
        confidence: 0.9,
        evidence: ['blocker_detected', 'pr_waiting'],
      });
    }
  }

  // From candidate threads
  const candidates = context.candidate_threads || [];
  for (const candidate of candidates.slice(0, 2)) {
    if (candidate.priority === 'high') {
      suggestions.push({
        type: 'next_step',
        title: candidate.description,
        description: `Natural next step based on your current work.`,
        urgency: 'high',
        action: 'Start',
        estimated_minutes: 10,
        confidence: 0.8,
        evidence: candidate.evidence || [],
      });
    }
  }

  return suggestions;
}

/**
 * Generate "related research" suggestions.
 * Show related queries, docs, patterns.
 */
function generateRelatedResearchSuggestions(context: any): SuggestionCandidate[] {
  const suggestions: SuggestionCandidate[] = [];

  const recentEvents = listObservationEvents({
    source: 'search',
    limit: 10,
  });

  // If multiple searches on the same topic, suggest deep dive
  if (recentEvents.length > 2) {
    const queries = recentEvents.map((e) => JSON.parse(e.data).query);
    const uniqueQueries = [...new Set(queries)];

    if (uniqueQueries.length > 0) {
      suggestions.push({
        type: 'related_research',
        title: `Deep dive: ${uniqueQueries[0]}`,
        description: `You've searched this 3+ times. Consider focused research.`,
        urgency: 'medium',
        action: 'Research',
        estimated_minutes: 30,
        confidence: 0.75,
        evidence: ['repeated_queries'],
      });
    }
  }

  // Suggest docs for current project
  if (context.current_project_name) {
    suggestions.push({
      type: 'related_research',
      title: `Read: ${context.current_project_name} documentation`,
      description: `Strengthen context on your current project.`,
      urgency: 'low',
      action: 'Read Docs',
      estimated_minutes: 20,
      confidence: 0.7,
      evidence: ['active_project'],
    });
  }

  return suggestions;
}

/**
 * Generate "risk" suggestions.
 * Missing tests, documentation gaps, stuck reviews.
 */
function generateRiskSuggestions(context: any): SuggestionCandidate[] {
  const suggestions: SuggestionCandidate[] = [];

  const recentEvents = listObservationEvents({ limit: 50 });

  // If code changed but no tests modified, suggest tests
  const codeChanges = recentEvents.filter((e) => e.source === 'code' && JSON.parse(e.data).type === 'file_change');
  const testChanges = recentEvents.filter((e) => e.source === 'code' && JSON.parse(e.data).path?.includes('.test'));

  if (codeChanges.length > testChanges.length) {
    suggestions.push({
      type: 'risk',
      title: 'Risk: Code changed, tests unchanged',
      description: `You've modified code but not test files. Consider adding tests.`,
      urgency: 'medium',
      action: 'Add Tests',
      estimated_minutes: 25,
      confidence: 0.8,
      evidence: ['code_test_mismatch'],
    });
  }

  // If API endpoint added, suggest documentation
  const apiEvents = recentEvents.filter((e) => e.source === 'code' && JSON.parse(e.data).path?.includes('/api/'));
  if (apiEvents.length > 0) {
    suggestions.push({
      type: 'risk',
      title: 'Gap: API endpoint added, no documentation',
      description: `Document your new API endpoint.`,
      urgency: 'medium',
      action: 'Document',
      estimated_minutes: 15,
      confidence: 0.75,
      evidence: ['api_added'],
    });
  }

  return suggestions;
}

/**
 * Generate "cross-project connection" suggestions.
 * Patterns used elsewhere, dependencies, reusable code.
 */
function generateConnectionSuggestions(context: any): SuggestionCandidate[] {
  const suggestions: SuggestionCandidate[] = [];

  // This is more advanced; for now, generic suggestions
  if (context.current_project_name) {
    suggestions.push({
      type: 'connection',
      title: `Explore: Reusable patterns in ${context.current_project_name}`,
      description: `Extract utilities or components for other projects.`,
      urgency: 'low',
      action: 'Refactor',
      estimated_minutes: 40,
      confidence: 0.6,
      evidence: ['architecture_review'],
    });
  }

  return suggestions;
}

/**
 * Score and rank suggestions.
 *
 * score = (urgency_weight * urgency_score) +
 *         (momentum_weight * momentum_score) +
 *         (relevance_weight * relevance_score) -
 *         (time_penalty)
 */
function rankSuggestions(candidates: SuggestionCandidate[]): SuggestionCandidate[] {
  const scored = candidates.map((s) => {
    let score = 0;

    // Urgency weight: 40%
    const urgencyMap = { high: 1.0, medium: 0.6, low: 0.3 };
    score += 0.4 * (urgencyMap[s.urgency] || 0);

    // Confidence weight: 30%
    score += 0.3 * s.confidence;

    // Type bias: 20%
    // Next steps are generally most valuable
    const typeMap = {
      next_step: 1.0,
      risk: 0.8,
      related_research: 0.6,
      connection: 0.4,
    };
    score += 0.2 * (typeMap[s.type] || 0.5);

    // Time estimate penalty: 10%
    // Prefer quick wins
    const timePenalty = Math.min(s.estimated_minutes / 60, 1.0);
    score -= 0.1 * timePenalty;

    return { ...s, _score: score };
  });

  return scored.sort((a, b) => (b._score ?? 0) - (a._score ?? 0)) as SuggestionCandidate[];
}

/**
 * Get active suggestions (not dismissed, not acted on).
 */
export function getActiveSuggestions_(): Suggestion[] {
  return getActiveSuggestions(5);
}

/**
 * Dismiss a suggestion for 24h.
 */
export function dismissSuggestion(id: string): Suggestion | null {
  return dismissDb(id);
}
