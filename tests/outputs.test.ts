/**
 * Outputs collector + briefing-pack zipper (Wave 15).
 *
 * Roundtrip tests for `@/main/outputs/collector` and
 * `@/main/outputs/briefing-pack`. The collector is exercised across all
 * sources (output files, attachments, integration context, cost rollup,
 * execution logs, confidence). The briefing pack is decoded with a tiny
 * inline ZIP reader so we can assert the entries exist without pulling in
 * an `unzipper`-style dependency.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

const PATHS = mockTaskpilotPaths();

// Imports must come AFTER mockTaskpilotPaths so the vi.mock factory wins.
import {
  collectOutputs,
  readArtifacts,
  readMetrics,
  readOutputFiles,
  sniffContentType,
  OutputsError,
} from '@/main/outputs/collector';
import { buildBriefingPack } from '@/main/outputs/briefing-pack';
import { createTask, updateTask, getTask } from '@/main/db/repositories/tasks';
import { executionLogsRepository } from '@/main/db/repositories/execution-logs';
import { costEventsRepository } from '@/main/db/repositories/cost-events';
import { saveAttachment } from '@/main/attachments';
import { outputDir, resultPath } from '@/main/io/paths';
import type { ExecutionResult } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function makeTask(): { id: string } {
  const task = createTask({ title: 'outputs-test', priority: 'p2' });
  return { id: task.id };
}

async function writeOutputFile(
  taskId: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = outputDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, content, 'utf8');
  return dest;
}

async function writeResult(
  taskId: string,
  result: ExecutionResult,
): Promise<void> {
  const dest = resultPath(taskId);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(result, null, 2));
}

/**
 * Decode a STORE-only ZIP buffer into a map of `{ name -> Buffer }`. We
 * only walk the central directory because every entry was written
 * uncompressed, so file data sits inline at the local-header offset.
 */
function readZipEntries(zip: Buffer): Map<string, Buffer> {
  // Find the end-of-central-directory record (last 22 bytes of any
  // STORE-only zip without a comment).
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('No EOCD record found');
  const cdSize = zip.readUInt32LE(eocdOffset + 12);
  const cdOffset = zip.readUInt32LE(eocdOffset + 16);

  const entries = new Map<string, Buffer>();
  let cursor = cdOffset;
  while (cursor < cdOffset + cdSize) {
    const sig = zip.readUInt32LE(cursor);
    if (sig !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.slice(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    // Walk to the local header to learn the data offset.
    const lhNameLen = zip.readUInt16LE(localOffset + 26);
    const lhExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + lhNameLen + lhExtraLen;
    const dataSize = zip.readUInt32LE(localOffset + 22);
    const data = zip.slice(dataOffset, dataOffset + dataSize);
    entries.set(name, Buffer.from(data));

    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/*  MIME sniffing                                                              */
/* -------------------------------------------------------------------------- */

describe('outputs — sniffContentType', () => {
  it('returns text/markdown for .md', () => {
    expect(sniffContentType('foo.md')).toBe('text/markdown');
    expect(sniffContentType('FOO.MD')).toBe('text/markdown');
  });

  it('returns application/json for .json', () => {
    expect(sniffContentType('data.json')).toBe('application/json');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(sniffContentType('mystery.xyz')).toBe('application/octet-stream');
    expect(sniffContentType('no-extension')).toBe('application/octet-stream');
  });

  it('handles a few binary extensions', () => {
    expect(sniffContentType('a.png')).toBe('image/png');
    expect(sniffContentType('a.pdf')).toBe('application/pdf');
    expect(sniffContentType('a.zip')).toBe('application/zip');
  });
});

/* -------------------------------------------------------------------------- */
/*  Collector — defensive when sources are missing                             */
/* -------------------------------------------------------------------------- */

describe('outputs — collector defensiveness', () => {
  useMockedDb();

  it('throws OutputsError(not_found) for an unknown task id', async () => {
    await expect(collectOutputs('does-not-exist')).rejects.toBeInstanceOf(
      OutputsError,
    );
  });

  it('returns an empty bundle for a fresh task', async () => {
    const { id } = makeTask();
    const bundle = await collectOutputs(id);
    expect(bundle.task_id).toBe(id);
    expect(bundle.files).toEqual([]);
    expect(bundle.attachments).toEqual([]);
    expect(bundle.artifacts).toEqual([]);
    expect(bundle.summary).toBeNull();
    expect(bundle.metrics.total_cost_usd).toBe(0);
    expect(bundle.metrics.execution_count).toBe(0);
    expect(bundle.metrics.last_confidence).toBeNull();
    expect(bundle.metrics.time_to_done_hours).toBeNull();
  });

  it('returns [] for readOutputFiles when the output dir is missing', async () => {
    const { id } = makeTask();
    const files = await readOutputFiles(id);
    expect(files).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Collector — files, attachments, summary                                    */
/* -------------------------------------------------------------------------- */

describe('outputs — files + attachments + summary', () => {
  useMockedDb();

  beforeEach(() => {
    // Each test gets a fresh tmp home (mockTaskpilotPaths) and DB
    // (useMockedDb). Nothing else to clean here.
    if (fs.existsSync(PATHS.IO_RESULTS)) {
      // Keep IO_RESULTS itself; the test will create per-task dirs.
    }
  });

  it('aggregates output files with preview for text and sniffed MIME', async () => {
    const { id } = makeTask();
    await writeOutputFile(id, 'summary.md', '# Hello\n\nThis is text.');
    await writeOutputFile(id, 'data.json', '{"key":"value"}');
    // Write a binary-ish file so its preview should NOT populate.
    const dir = outputDir(id);
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const bundle = await collectOutputs(id);
    expect(bundle.files).toHaveLength(3);

    const md = bundle.files.find((f) => f.path.endsWith('summary.md'));
    expect(md).toBeDefined();
    expect(md?.content_type).toBe('text/markdown');
    expect(md?.preview).toContain('# Hello');

    const json = bundle.files.find((f) => f.path.endsWith('data.json'));
    expect(json?.content_type).toBe('application/json');
    expect(json?.preview).toContain('"key"');

    const png = bundle.files.find((f) => f.path.endsWith('logo.png'));
    expect(png?.content_type).toBe('image/png');
    expect(png?.preview).toBeUndefined();
  });

  it('returns the summary string from result.json when present', async () => {
    const { id } = makeTask();
    await writeResult(id, {
      task_id: id,
      status: 'succeeded',
      completed_at: '2026-05-27T12:00:00.000Z',
      summary: 'Drafted the report.',
      output_files: [],
    });
    const bundle = await collectOutputs(id);
    expect(bundle.summary).toBe('Drafted the report.');
  });

  it('returns null summary for a malformed result.json', async () => {
    const { id } = makeTask();
    const dest = resultPath(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '{not json');
    const bundle = await collectOutputs(id);
    expect(bundle.summary).toBeNull();
  });

  it('includes user attachments as OutputFile entries', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'brief.txt',
      data: Buffer.from('Hello from the brief.', 'utf8'),
      contentType: 'text/plain',
    });
    const bundle = await collectOutputs(id);
    expect(bundle.attachments).toHaveLength(1);
    expect(bundle.attachments[0]?.path).toContain('brief.txt');
    expect(bundle.attachments[0]?.content_type).toBe('text/plain');
    expect(bundle.attachments[0]?.preview).toContain('Hello from the brief.');
  });
});

/* -------------------------------------------------------------------------- */
/*  Collector — external artifacts                                             */
/* -------------------------------------------------------------------------- */

describe('outputs — artifacts from task.context', () => {
  useMockedDb();

  it('surfaces a github_issue artifact when context.github_issue is set', async () => {
    const task = createTask({
      title: 'gh-issue',
      priority: 'p2',
      context: {
        github_issue: {
          owner: 'foo',
          repo: 'bar',
          number: 7,
          url: 'https://github.com/foo/bar/issues/7',
          state: 'open',
        },
      },
    });
    const got = getTask(task.id);
    expect(got).not.toBeNull();
    const arts = readArtifacts(got!);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({
      kind: 'github_issue',
      number: 7,
      state: 'open',
      url: 'https://github.com/foo/bar/issues/7',
    });
  });

  it('surfaces a notion_page artifact when context.notion_page_id is set', async () => {
    const task = createTask({
      title: 'notion',
      priority: 'p2',
      context: {
        notion_page_id: 'abc123',
        notion_page_url: 'https://www.notion.so/abc123',
        notion_synced_at: '2026-05-27T10:00:00.000Z',
      },
    });
    const arts = readArtifacts(getTask(task.id)!);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({
      kind: 'notion_page',
      page_id: 'abc123',
      url: 'https://www.notion.so/abc123',
      last_synced: '2026-05-27T10:00:00.000Z',
    });
  });

  it('surfaces a slack_thread artifact when context.slack_permalink is set', async () => {
    const task = createTask({
      title: 'slack',
      priority: 'p2',
      context: {
        slack_permalink: 'https://acme.slack.com/archives/C1/p1700000000000200',
        slack_channel: 'general',
        slack_thread_ts: '1700000000.000200',
      },
    });
    const arts = readArtifacts(getTask(task.id)!);
    expect(arts).toContainEqual({
      kind: 'slack_thread',
      permalink: 'https://acme.slack.com/archives/C1/p1700000000000200',
      channel: 'general',
      thread_ts: '1700000000.000200',
    });
  });

  it('surfaces a gmail_draft artifact, preferring draft id over message id', async () => {
    const task = createTask({
      title: 'gmail',
      priority: 'p2',
      context: {
        gmail_draft_id: 'r-draft-1',
        gmail_message_id: 'm-1',
        gmail_thread_id: 't-1',
        gmail_subject: 'Re: review',
      },
    });
    const arts = readArtifacts(getTask(task.id)!);
    const drafts = arts.filter((a) => a.kind === 'gmail_draft');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      message_id: 'r-draft-1',
      thread_id: 't-1',
      subject: 'Re: review',
    });
  });

  it('surfaces a calendar_event artifact when task.calendar_event_id is set', async () => {
    const task = createTask({
      title: 'cal',
      priority: 'p2',
      calendar_event_id: 'evt-xyz',
    });
    const arts = readArtifacts(getTask(task.id)!);
    expect(arts).toContainEqual({
      kind: 'calendar_event',
      event_id: 'evt-xyz',
    });
  });

  it('surfaces a github_pr artifact when context.github_pr is structured', async () => {
    const task = createTask({
      title: 'pr',
      priority: 'p2',
      context: {
        github_pr: {
          number: 42,
          url: 'https://github.com/foo/bar/pull/42',
          state: 'merged',
        },
      },
    });
    const arts = readArtifacts(getTask(task.id)!);
    expect(arts).toContainEqual({
      kind: 'github_pr',
      number: 42,
      url: 'https://github.com/foo/bar/pull/42',
      state: 'merged',
    });
  });

  it('returns no artifacts when context lacks the canonical fields', async () => {
    const task = createTask({ title: 'plain', priority: 'p2' });
    expect(readArtifacts(getTask(task.id)!)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Collector — metrics rollup                                                 */
/* -------------------------------------------------------------------------- */

describe('outputs — metrics', () => {
  useMockedDb();

  it('sums cost events, counts logs, and computes time-to-done', () => {
    const task = createTask({
      title: 'metrics',
      priority: 'p2',
      created_at: '2026-05-27T00:00:00.000Z',
    });
    const id = task.id;

    costEventsRepository.create({
      task_id: id,
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.0125,
      model: 'claude-3-opus',
      source: 'execution',
    });
    costEventsRepository.create({
      task_id: id,
      input_tokens: 200,
      output_tokens: 100,
      cost_usd: 0.0025,
      source: 'derive',
    });

    executionLogsRepository.create({
      task_id: id,
      method: 'cli',
      status: 'failed',
      started_at: '2026-05-27T01:00:00.000Z',
      completed_at: '2026-05-27T01:05:00.000Z',
      output: 'fail',
    });
    executionLogsRepository.create({
      task_id: id,
      method: 'cli',
      status: 'succeeded',
      started_at: '2026-05-27T02:00:00.000Z',
      completed_at: '2026-05-27T03:00:00.000Z',
      output: 'win',
    });

    updateTask(id, {
      context: { last_confidence: 0.85 },
    });

    const refreshed = getTask(id);
    const metrics = readMetrics(id, refreshed!);
    expect(metrics.total_cost_usd).toBeCloseTo(0.015, 6);
    expect(metrics.total_input_tokens).toBe(1200);
    expect(metrics.total_output_tokens).toBe(600);
    // First succeeded log completed at 03:00 (3 hours after created_at).
    expect(metrics.time_to_done_hours).toBe(3);
    expect(metrics.execution_count).toBe(2);
    expect(metrics.last_confidence).toBe(0.85);
  });

  it('returns null time_to_done when no succeeded run exists', () => {
    const task = createTask({ title: 'no-success', priority: 'p2' });
    executionLogsRepository.create({
      task_id: task.id,
      method: 'cli',
      status: 'failed',
      started_at: '2026-05-27T00:00:00.000Z',
      completed_at: '2026-05-27T00:01:00.000Z',
    });
    const metrics = readMetrics(task.id, getTask(task.id)!);
    expect(metrics.time_to_done_hours).toBeNull();
    expect(metrics.execution_count).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Briefing pack — zip contents                                               */
/* -------------------------------------------------------------------------- */

describe('outputs — briefing pack', () => {
  useMockedDb();

  it('produces a zip with README, result, output, attachments, artifacts, metrics', async () => {
    const task = createTask({
      title: 'briefing-pack-test',
      description: 'A test task for the briefing pack.',
      priority: 'p2',
      tags: ['demo'],
      context: {
        github_issue: {
          owner: 'foo',
          repo: 'bar',
          number: 1,
          url: 'https://github.com/foo/bar/issues/1',
          state: 'open',
        },
      },
    });
    const id = task.id;

    await writeOutputFile(id, 'hello.md', '# Hello\n\nWorld.');
    await writeResult(id, {
      task_id: id,
      status: 'succeeded',
      completed_at: '2026-05-27T05:00:00.000Z',
      summary: 'The task ran.',
      output_files: ['hello.md'],
    });
    await saveAttachment({
      taskId: id,
      filename: 'note.txt',
      data: Buffer.from('Quick note.', 'utf8'),
      contentType: 'text/plain',
    });

    const bundle = await collectOutputs(id);
    const pack = await buildBriefingPack(getTask(id)!, bundle);
    expect(pack.size_bytes).toBeGreaterThan(0);

    const zip = fs.readFileSync(pack.path);
    const entries = readZipEntries(zip);

    // Core entries.
    expect(entries.has('README.md')).toBe(true);
    expect(entries.has('result.json')).toBe(true);
    expect(entries.has('artifacts.json')).toBe(true);
    expect(entries.has('metrics.json')).toBe(true);
    expect(entries.has('output/hello.md')).toBe(true);
    expect(entries.has('attachments/note.txt')).toBe(true);
    // Journal not present — Wave 15A may not be loaded; either way it's optional.
    // We don't assert journal.json's absence (15A may have landed).

    // Content sanity checks.
    expect(entries.get('output/hello.md')?.toString('utf8')).toBe(
      '# Hello\n\nWorld.',
    );
    expect(entries.get('attachments/note.txt')?.toString('utf8')).toBe(
      'Quick note.',
    );
    const readme = entries.get('README.md')?.toString('utf8') ?? '';
    expect(readme).toContain('# briefing-pack-test');
    expect(readme).toContain('GitHub issue #1');
    expect(readme).toContain('A test task for the briefing pack.');

    const artifactsJson = JSON.parse(
      entries.get('artifacts.json')!.toString('utf8'),
    ) as { artifacts: Array<{ kind: string }> };
    expect(artifactsJson.artifacts.some((a) => a.kind === 'github_issue')).toBe(true);

    const metricsJson = JSON.parse(entries.get('metrics.json')!.toString('utf8'));
    expect(typeof metricsJson.total_cost_usd).toBe('number');
  });

  it('still produces a valid zip when sources are empty', async () => {
    const task = createTask({ title: 'empty-task', priority: 'p2' });
    const bundle = await collectOutputs(task.id);
    const pack = await buildBriefingPack(getTask(task.id)!, bundle);
    const zip = fs.readFileSync(pack.path);
    const entries = readZipEntries(zip);
    expect(entries.has('README.md')).toBe(true);
    expect(entries.has('artifacts.json')).toBe(true);
    expect(entries.has('metrics.json')).toBe(true);
    // No result.json (nothing to copy), no output/, no attachments/.
    expect(entries.has('result.json')).toBe(false);
  });
});
