import { describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from '../../helpers/mock-paths';
import { useMockedDb } from '../../helpers/mock-db';

mockTaskpilotPaths();
useMockedDb();

import { propagateToTask } from '@/main/conversations/side-effects';
import { listDecisionsForTask } from '@/main/decisions';
import { createConversation } from '@/main/db/repositories/conversations';
import { createTask } from '@/main/db/repositories/tasks';

function conv(over: Partial<Parameters<typeof createConversation>[0]> = {}) {
  return createConversation({
    id: '',
    source: 'claude_code',
    source_id: 's',
    source_path: null,
    project_path: null,
    title: 'T',
    started_at: '2026-05-01T00:00:00.000Z',
    ended_at: '2026-05-01T01:00:00.000Z',
    model: null,
    message_count: 1,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    digest: '',
    topics: [],
    key_decisions: [],
    files_touched: [],
    compressed_at: null,
    archived_at: null,
    content_hash: 'h',
    ...over,
  });
}

describe('propagateToTask', () => {
  it('writes each key_decision as a decision-category entry', () => {
    const task = createTask({ title: 'task' });
    const c = conv({
      key_decisions: [
        'we decided to ship the new flow',
        'the plan is to refactor next week',
      ],
    });
    propagateToTask(c, task.id, []);
    const decisions = listDecisionsForTask(task.id);
    expect(decisions.length).toBeGreaterThanOrEqual(2);
    const decisionCats = decisions.filter((d) => d.category === 'decision');
    expect(decisionCats).toHaveLength(2);
    expect(decisionCats[0].author).toBe('claude');
    expect(decisionCats[0].link).toContain('taskpilot://conversation/');
  });

  it('deduplicates on re-run (idempotent)', () => {
    const task = createTask({ title: 'task' });
    const c = conv({ key_decisions: ['we decided to ship'] });
    propagateToTask(c, task.id, []);
    propagateToTask(c, task.id, []);
    const decisions = listDecisionsForTask(task.id);
    const matching = decisions.filter((d) => d.text === 'we decided to ship');
    expect(matching).toHaveLength(1);
  });

  it('writes small code blocks as reference entries; ignores large blocks', () => {
    const task = createTask({ title: 'task' });
    const c = conv();
    const tiny = 'const x = 1;';
    const huge = 'x'.repeat(5_000);
    propagateToTask(c, task.id, [tiny, huge]);
    const refs = listDecisionsForTask(task.id).filter(
      (d) => d.category === 'reference',
    );
    const codeRefs = refs.filter((d) => d.text.startsWith('Code snippet'));
    expect(codeRefs).toHaveLength(1);
    expect(codeRefs[0].text).toContain(tiny);
  });

  it('consolidates files touched into a single reference entry (with truncation note)', () => {
    const task = createTask({ title: 'task' });
    const c = conv({
      files_touched: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`),
    });
    propagateToTask(c, task.id, []);
    const refs = listDecisionsForTask(task.id).filter(
      (d) =>
        d.category === 'reference' && d.text.startsWith('Touched 20 files'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].text).toContain('+ 12 more'); // 20 total - 8 shown
  });

  it('skips short or empty decisions', () => {
    const task = createTask({ title: 'task' });
    const c = conv({
      key_decisions: ['ok', 'we decided to keep this real fix'],
    });
    propagateToTask(c, task.id, []);
    const decisions = listDecisionsForTask(task.id).filter(
      (d) => d.category === 'decision',
    );
    expect(decisions).toHaveLength(1);
  });
});
