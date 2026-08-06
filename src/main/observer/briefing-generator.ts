/**
 * Morning Briefing Generator - Phase 4
 *
 * Generates daily briefing at 8 AM showing:
 *  - Work completed yesterday
 *  - Suggested focus for today
 *  - What changed overnight
 */

import {
  listTasks,
} from '@/main/db/repositories/tasks';
import {
  getContextStateDecoded,
} from '@/main/db/repositories/context-state';
import {
  getActiveSuggestions,
} from '@/main/db/repositories/suggestions-repo';
import {
  listObservationEvents,
  countObservationEventsBySource,
} from '@/main/db/repositories/observation-events';

export interface BriefingContent {
  generated_at: string;
  summary: string;
  yesterday: {
    tasks_completed: number;
    research_threads: string[];
    files_modified: number;
  };
  today: {
    suggestions: Array<{
      rank: number;
      title: string;
      estimated_minutes: number;
    }>;
    current_project: string | null;
    active_threads: string[];
  };
  overnight_changes: {
    new_comments_on_prs: number;
    new_issues: number;
    deployed_changes: boolean;
  };
}

/**
 * Generate morning briefing content.
 */
export function generateBriefing(): BriefingContent {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Tasks completed yesterday
  const completedTasks = listTasks({
    status: 'done',
    limit: 50,
  }).filter((t) => new Date(t.updated_at) > yesterday);

  // Observation events by source (yesterday)
  const eventCounts = countObservationEventsBySource(
    yesterday.toISOString(),
    now.toISOString()
  );

  // Current context
  const context = getContextStateDecoded();

  // Today's suggestions
  const suggestions = getActiveSuggestions(3);

  // Recent GitHub activity (last 12 hours)
  const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const recentGitHubEvents = listObservationEvents({
    source: 'github',
    startTime: twelveHoursAgo,
  });

  return {
    generated_at: now.toISOString(),
    summary: generateSummary(completedTasks.length, context),
    yesterday: {
      tasks_completed: completedTasks.length,
      research_threads: context.research_threads?.slice(0, 3)?.map((t: any) => t.query) || [],
      files_modified: eventCounts.code || 0,
    },
    today: {
      suggestions: suggestions.map((s, i) => ({
        rank: i + 1,
        title: s.action || s.title,
        estimated_minutes: s.estimated_minutes || 15,
      })),
      current_project: context.current_project_name,
      active_threads: context.research_threads?.slice(0, 3)?.map((t: any) => t.query) || [],
    },
    overnight_changes: {
      new_comments_on_prs: recentGitHubEvents.filter(
        (e) => JSON.parse(e.data).type === 'PullRequestReview'
      ).length,
      new_issues: recentGitHubEvents.filter(
        (e) => JSON.parse(e.data).type === 'Issues'
      ).length,
      deployed_changes: recentGitHubEvents.some(
        (e) => JSON.parse(e.data).type === 'PushEvent'
      ),
    },
  };
}

/**
 * Generate brief text summary.
 */
function generateSummary(completedCount: number, context: any): string {
  const project = context.current_project_name || 'your work';
  const threads = (context.research_threads || []).length;

  if (completedCount === 0) {
    return `Good morning! No tasks completed yesterday. Focus on ${project} today.`;
  }

  return `Good morning! You completed ${completedCount} task${completedCount > 1 ? 's' : ''} yesterday. ${threads > 0 ? `Continued ${threads} research thread${threads > 1 ? 's' : ''}.` : ''} Here's your focus for today.`;
}

/**
 * Format briefing as markdown for display.
 */
export function formatBriefingMarkdown(briefing: BriefingContent): string {
  const lines: string[] = [];

  lines.push('# Good morning! ☀️\n');

  lines.push(briefing.summary + '\n');

  // Yesterday
  lines.push('## Yesterday\'s Work\n');
  lines.push(`- ✓ Completed: ${briefing.yesterday.tasks_completed} task${briefing.yesterday.tasks_completed > 1 ? 's' : ''}`);
  if (briefing.yesterday.files_modified > 0) {
    lines.push(`- 📝 Modified: ${briefing.yesterday.files_modified} file${briefing.yesterday.files_modified > 1 ? 's' : ''}`);
  }
  if (briefing.yesterday.research_threads.length > 0) {
    lines.push(`- 🔍 Researched: ${briefing.yesterday.research_threads.join(', ')}`);
  }
  lines.push('');

  // Today
  lines.push('## Today\'s Suggested Focus\n');
  for (const s of briefing.today.suggestions) {
    lines.push(`${s.rank}. **${s.title}** (${s.estimated_minutes} min)`);
  }
  lines.push('');

  // Overnight
  if (briefing.overnight_changes.new_comments_on_prs > 0 ||
      briefing.overnight_changes.new_issues > 0 ||
      briefing.overnight_changes.deployed_changes) {
    lines.push('## What Changed Overnight\n');
    if (briefing.overnight_changes.new_comments_on_prs > 0) {
      lines.push(`- 💬 ${briefing.overnight_changes.new_comments_on_prs} new comment${briefing.overnight_changes.new_comments_on_prs > 1 ? 's' : ''} on your PRs`);
    }
    if (briefing.overnight_changes.new_issues > 0) {
      lines.push(`- ⚠️ ${briefing.overnight_changes.new_issues} new issue${briefing.overnight_changes.new_issues > 1 ? 's' : ''}`);
    }
    if (briefing.overnight_changes.deployed_changes) {
      lines.push(`- 🚀 Changes deployed`);
    }
    lines.push('');
  }

  lines.push('[View All] • [Dismiss]');

  return lines.join('\n');
}
