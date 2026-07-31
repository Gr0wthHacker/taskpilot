/**
 * Render a {@link BusinessSnapshot} into a Markdown document.
 *
 * The output is what lands in `~/.taskpilot/businesses/<tag>/STATUS.md` and
 * what the MCP `taskpilot_business_status` tool returns to a future Claude
 * session as the "instant context" payload. The shape is optimised for an
 * LLM doing a quick orient — short bullet sections, ISO timestamps, no
 * decorative emoji.
 */

import type { BusinessSnapshot } from './snapshot';

export function renderStatusMarkdown(snapshot: BusinessSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${snapshot.name} — Status`);
  lines.push('');
  lines.push(`_Tag: \`${snapshot.tag}\`  ·  Computed: ${snapshot.computed_at}_`);
  if (snapshot.last_touched_at) {
    lines.push(`_Last touched: ${snapshot.last_touched_at}_`);
  }
  lines.push('');
  lines.push(`> ${snapshot.headline}`);
  lines.push('');

  // Next steps come first — that's the highest-value section for a session
  // that's trying to "just pick up where I left off".
  lines.push('## Next steps');
  lines.push('');
  if (snapshot.next_steps.length === 0) {
    lines.push('- (no suggested next steps)');
  } else {
    for (const step of snapshot.next_steps) {
      const refSuffix = step.task_id ? ` _(task \`${step.task_id}\`)_` : '';
      lines.push(`- ${step.text}${refSuffix}`);
    }
  }
  lines.push('');

  // Tasks at a glance.
  lines.push('## Open tasks');
  lines.push('');
  const c = snapshot.task_counts;
  lines.push(
    `Totals — inbox ${c.inbox} · queued ${c.queued} · in-progress ${c.in_progress} · blocked ${c.blocked} · overdue ${c.overdue} · done ${c.done}`,
  );
  lines.push('');
  if (snapshot.open_tasks.length === 0) {
    lines.push('- (no open tasks)');
  } else {
    for (const t of snapshot.open_tasks.slice(0, 10)) {
      const due = t.due ? ` · due ${t.due}` : '';
      lines.push(
        `- [${t.priority}] **${t.title}** _(${t.status}${due}, \`${t.id}\`)_`,
      );
    }
  }
  lines.push('');

  // Recent explicit deltas — the cross-session feed.
  lines.push('## Recent status updates');
  lines.push('');
  if (snapshot.recent_updates.length === 0) {
    lines.push('- (no updates logged yet)');
  } else {
    for (const u of snapshot.recent_updates.slice(0, 10)) {
      lines.push(`- **${u.at}** — ${u.headline}`);
      if (u.what_changed) lines.push(`  - ${u.what_changed}`);
      if (u.source) lines.push(`  - _source: ${u.source}_`);
    }
  }
  lines.push('');

  // Decisions, when any.
  if (snapshot.recent_decisions.length > 0) {
    lines.push('## Recent decisions');
    lines.push('');
    for (const d of snapshot.recent_decisions) {
      lines.push(
        `- **${d.created_at}** _(${d.category}, task \`${d.task_id}\`)_ — ${d.text}`,
      );
    }
    lines.push('');
  }

  // Conversations linked by repo CWD match.
  if (snapshot.recent_conversations.length > 0) {
    lines.push('## Recent Claude sessions touching this work');
    lines.push('');
    for (const cv of snapshot.recent_conversations) {
      const topics = cv.topics.slice(0, 4).join(', ');
      lines.push(
        `- **${cv.ended_at}** — ${cv.title}${topics ? ` _(topics: ${topics})_` : ''}`,
      );
    }
    lines.push('');
  }

  // Repos.
  if (snapshot.repos.length > 0) {
    lines.push('## Repos');
    lines.push('');
    for (const r of snapshot.repos) lines.push(`- \`${r}\``);
    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_TaskPilot business status — derived from open tasks, recent decisions, mapped Claude sessions, and explicit cross-session updates._',
  );
  lines.push('');
  return lines.join('\n');
}
