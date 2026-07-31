/**
 * Auto-PR description generator.
 *
 * Given a task id (and optionally a branch's recent commit subjects),
 * assemble a PR body from observable context:
 *   • Task title + description + agent instructions (the "why")
 *   • Recent decisions on the task (the trade-offs the model wrote down)
 *   • Linked conversation digests (the discussion thread that produced this)
 *   • Branch commit subjects (the "what")
 *
 * No LLM call in this module — purely a templating pass over data we
 * already store. A future Claude session can pull the generated draft and
 * polish it, or the model can do that inline before calling openPR.
 */

import { listLinksForTask } from '@/main/db/repositories/conversations';
import { getConversation } from '@/main/db/repositories/conversations';
import { getTask } from '@/main/db/repositories/tasks';
import { listDecisions } from '@/main/db/repositories/decisions';
import type { Task } from '@/shared/types';

export interface GeneratePrDescriptionInput {
  task_id: string;
  /** Recent commit subjects on the head branch (newest first). Optional. */
  commit_subjects?: string[];
  /** Optional override title; defaults to the task title. */
  title_override?: string;
}

export interface GeneratedPrDescription {
  title: string;
  body: string;
  /** Sources we pulled from — useful for debugging / showing the user. */
  sources: {
    task_id: string;
    decision_count: number;
    conversation_count: number;
    commit_count: number;
  };
}

/**
 * Build a PR title + body from task context. Returns null when the task
 * doesn't exist.
 */
export function generatePrDescription(
  input: GeneratePrDescriptionInput,
): GeneratedPrDescription | null {
  const task = getTask(input.task_id);
  if (!task) return null;

  const decisions = listDecisions({ task_id: input.task_id, limit: 10 });
  const conversationLinks = listLinksForTask(input.task_id);
  const conversations = conversationLinks
    .map((l) => getConversation(l.conversation_id))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .slice(0, 3);

  const commitSubjects = input.commit_subjects ?? [];

  const lines: string[] = [];

  // Summary — pulled from description, agent instructions, or title.
  lines.push('## Summary');
  lines.push('');
  lines.push(extractSummary(task));
  lines.push('');

  // What changed — from commits if available.
  if (commitSubjects.length > 0) {
    lines.push('## What changed');
    lines.push('');
    for (const c of commitSubjects.slice(0, 10)) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }

  // Decisions — copy them in verbatim, they're the trade-offs.
  if (decisions.length > 0) {
    lines.push('## Decisions / trade-offs');
    lines.push('');
    for (const d of decisions) {
      lines.push(`- _(${d.category})_ ${d.text}`);
    }
    lines.push('');
  }

  // Discussion — point at the conversations that produced this.
  if (conversations.length > 0) {
    lines.push('## Discussion context');
    lines.push('');
    for (const c of conversations) {
      const topics = c.topics.slice(0, 4).join(', ');
      lines.push(
        `- ${c.title ?? `(conversation ${c.id})`}${topics ? ` _(topics: ${topics})_` : ''}`,
      );
    }
    lines.push('');
  }

  // Tags — preserve them so reviewers see business / goal context.
  if (task.tags.length > 0) {
    lines.push('## Tags');
    lines.push('');
    lines.push(task.tags.map((t) => `\`${t}\``).join(' '));
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `_Auto-generated from TaskPilot task \`${task.id}\`. Edit freely before merging._`,
  );

  return {
    title: input.title_override ?? task.title,
    body: lines.join('\n'),
    sources: {
      task_id: task.id,
      decision_count: decisions.length,
      conversation_count: conversations.length,
      commit_count: commitSubjects.length,
    },
  };
}

function extractSummary(task: Task): string {
  // Prefer description; fall back to agent_instructions; else just the title.
  if (task.description && task.description.trim().length > 0) {
    return task.description.trim().slice(0, 1_200);
  }
  if (task.agent_instructions && task.agent_instructions.trim().length > 0) {
    return task.agent_instructions.trim().slice(0, 1_200);
  }
  return `Implements: ${task.title}`;
}
