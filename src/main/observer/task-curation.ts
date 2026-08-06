/**
 * Task Curation - Phase 5
 *
 * Converts suggestions into auto-approved tasks that flow into the v1 pipeline.
 * Uses auto-approval heuristic to determine which tasks can run without review.
 */

import { createTask, updateTask } from '@/main/db/repositories/tasks';
import {
  getSuggestion,
  actionSuggestion,
} from '@/main/db/repositories/suggestions-repo';
import {
  createAutoApproval,
} from '@/main/db/repositories/auto-approvals';
import type { Task } from '@/shared/types';

/**
 * Auto-approval criteria.
 * Task is auto-approved if it meets low-risk criteria.
 */
interface AutoApproveCriteria {
  estimated_minutes: number;
  confidence: number;
  operation_type: 'read_only' | 'local_execute' | 'api_call' | 'code_push';
  risk_level: 'low' | 'medium' | 'high';
}

/**
 * Determine if a suggestion can be auto-approved.
 */
function canAutoApprove(criteria: AutoApproveCriteria): boolean {
  return (
    criteria.risk_level === 'low' &&
    criteria.estimated_minutes <= 20 &&
    criteria.confidence >= 0.7 &&
    ['read_only', 'local_execute'].includes(criteria.operation_type)
  );
}

/**
 * Create an auto-approvable task from a suggestion.
 * Returns the created task and whether it was auto-approved.
 */
export function curateTaskFromSuggestion(
  suggestionId: string
): { task: Task; autoApproved: boolean; reason: string } | null {
  const suggestion = getSuggestion(suggestionId);
  if (!suggestion) return null;

  // Infer criteria from suggestion type and content
  const criteria = inferCriteria(suggestion);

  // Determine if auto-approvable
  const autoApprove = canAutoApprove(criteria);

  // Create task
  const task = createTask({
    title: suggestion.action || suggestion.title,
    description: suggestion.description || null,
    priority: suggestion.urgency === 'high' ? 'p0' : suggestion.urgency === 'medium' ? 'p1' : 'p2',
    agent_executable: true,
    agent_method: criteria.operation_type === 'api_call' ? 'either' : 'cli',
    agent_instructions: `From suggestion: ${suggestion.description}\n\nEstimated time: ${suggestion.estimated_minutes} min\nConfidence: ${Math.round(suggestion.confidence * 100)}%`,
    tags: ['auto-derived', `via-suggestion:${suggestion.type}`],
  });

  // If auto-approve, queue it (status='queued')
  if (autoApprove) {
    updateTask(task.id, {
      status: 'queued',
      agent_status: 'pending',
    });

    // Log auto-approval
    const reason = `suggestion-derived, ${criteria.risk_level}-risk, ${criteria.estimated_minutes}min, ${Math.round(criteria.confidence * 100)}% confidence`;
    createAutoApproval({
      task_id: task.id,
      suggestion_id: suggestionId,
      reason,
      risk_level: criteria.risk_level,
      operation_type: criteria.operation_type,
    });

    // Mark suggestion as actioned
    actionSuggestion(suggestionId);

    return {
      task,
      autoApproved: true,
      reason,
    };
  } else {
    // If not auto-approvable, leave in 'inbox' for user review
    updateTask(task.id, {
      status: 'inbox',
      agent_status: 'pending',
    });

    return {
      task,
      autoApproved: false,
      reason: `Risk level '${criteria.risk_level}' requires review`,
    };
  }
}

/**
 * Infer auto-approval criteria from suggestion.
 */
function inferCriteria(suggestion: any): AutoApproveCriteria {
  const title = (suggestion.title || '').toLowerCase();
  const description = (suggestion.description || '').toLowerCase();

  let operationType: 'read_only' | 'local_execute' | 'api_call' | 'code_push' = 'local_execute';
  let riskLevel: 'low' | 'medium' | 'high' = 'medium';

  // Classify operation type
  if (
    ['read', 'research', 'documentation', 'summarize'].some((keyword) =>
      title.includes(keyword) || description.includes(keyword)
    )
  ) {
    operationType = 'read_only';
    riskLevel = 'low';
  } else if (
    ['test', 'lint', 'format', 'compile'].some((keyword) =>
      title.includes(keyword) || description.includes(keyword)
    )
  ) {
    operationType = 'local_execute';
    riskLevel = 'low';
  } else if (
    ['commit', 'push', 'merge', 'deploy'].some((keyword) =>
      title.includes(keyword) || description.includes(keyword)
    )
  ) {
    operationType = 'code_push';
    riskLevel = 'high';
  } else if (
    ['api', 'call', 'fetch', 'webhook'].some((keyword) =>
      title.includes(keyword) || description.includes(keyword)
    )
  ) {
    operationType = 'api_call';
    riskLevel = 'high';
  }

  return {
    estimated_minutes: Math.max(1, Math.min(suggestion.estimated_minutes || 15, 60)),
    confidence: Math.max(0, Math.min((suggestion.confidence ?? 0.7), 1)),
    operation_type: operationType,
    risk_level: riskLevel,
  };
}

/**
 * Process all high-confidence suggestions that can be auto-approved.
 * Call this periodically to auto-curate tasks.
 */
export function autoApproveSuggestions(): Array<{ suggestion_id: string; task_id: string; auto_approved: boolean }> {
  const { getActiveSuggestions } = require('@/main/db/repositories/suggestions-repo');

  const suggestions = getActiveSuggestions(10);
  const results: Array<{ suggestion_id: string; task_id: string; auto_approved: boolean }> = [];

  for (const suggestion of suggestions) {
    const result = curateTaskFromSuggestion(suggestion.id);
    if (result) {
      results.push({
        suggestion_id: suggestion.id,
        task_id: result.task.id,
        auto_approved: result.autoApproved,
      });
    }
  }

  return results;
}
