/**
 * File attachments (Wave 13) — save/read/list/delete roundtrip, filename
 * sanitization, size-limit enforcement, and path-traversal refusal.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, beforeEach } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

const PATHS = mockTaskpilotPaths();

// Imports must come *after* mockTaskpilotPaths so the vi.mock factory wins
// over the real `@/shared/constants` resolution.
import {
  AttachmentError,
  attachmentPath,
  attachmentsDirForTask,
  deleteAttachment,
  deleteAttachmentsForTask,
  listAttachments,
  readAttachmentBytes,
  readAttachmentLimits,
  readTaskAttachments,
  sanitizeAttachmentFilename,
  saveAttachment,
} from '@/main/attachments';
import { createTask, getTask, deleteTask } from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';

function makeTask(): { id: string } {
  const task = createTask({ title: 'attachment-test', priority: 'p2' });
  return { id: task.id };
}

describe('attachments — sanitizeAttachmentFilename', () => {
  it('strips path separators', () => {
    expect(sanitizeAttachmentFilename('../../etc/passwd')).not.toContain('/');
    expect(sanitizeAttachmentFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitizeAttachmentFilename('..\\..\\etc\\passwd')).not.toContain(
      '\\',
    );
  });

  it('replaces disallowed characters with underscores', () => {
    expect(sanitizeAttachmentFilename('hello world.png')).toBe('hello_world.png');
    expect(sanitizeAttachmentFilename('a$b#c.txt')).toBe('a_b_c.txt');
  });

  it('keeps allowed characters intact', () => {
    expect(sanitizeAttachmentFilename('file-1_v2.tar.gz')).toBe(
      'file-1_v2.tar.gz',
    );
  });

  it('truncates to 200 chars max', () => {
    const long = 'a'.repeat(300) + '.txt';
    const out = sanitizeAttachmentFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.txt')).toBe(true);
  });

  it('handles empty / pathological input safely', () => {
    expect(sanitizeAttachmentFilename('')).toBe('file');
    expect(sanitizeAttachmentFilename('.')).toBe('file');
    expect(sanitizeAttachmentFilename('....')).toBe('file');
  });
});

describe('attachments — path safety', () => {
  it('refuses `../` in attachmentPath', () => {
    expect(() => attachmentPath('valid-id', '../escape')).toThrow(
      AttachmentError,
    );
  });

  it('refuses path separators in filenames', () => {
    expect(() => attachmentPath('valid-id', 'sub/dir/file.png')).toThrow(
      AttachmentError,
    );
  });

  it('refuses bogus task ids', () => {
    expect(() => attachmentsDirForTask('../etc')).toThrow(AttachmentError);
    expect(() => attachmentsDirForTask('a/b')).toThrow(AttachmentError);
  });
});

describe('attachments — save/list/read/delete roundtrip', () => {
  useMockedDb();

  beforeEach(() => {
    // Make sure each test starts with a clean attachments dir. mockTaskpilotPaths
    // builds a fresh tmp home, so the global dir starts empty — but the in-
    // memory DB also starts empty per useMockedDb, so attachments-by-task is
    // naturally isolated.
    if (fs.existsSync(PATHS.ATTACHMENTS_DIR)) {
      fs.rmSync(PATHS.ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it('saves a file and reads it back', async () => {
    const { id } = makeTask();
    const data = Buffer.from('hello world', 'utf8');
    const saved = await saveAttachment({
      taskId: id,
      filename: 'hello.txt',
      data,
      contentType: 'text/plain',
    });
    expect(saved.filename).toBe('hello.txt');
    expect(saved.size_bytes).toBe(data.byteLength);
    expect(fs.existsSync(saved.path)).toBe(true);

    const list = listAttachments(id);
    expect(list).toHaveLength(1);
    expect(list[0]?.filename).toBe('hello.txt');

    const { data: readData, meta } = await readAttachmentBytes(id, 'hello.txt');
    expect(readData.toString('utf8')).toBe('hello world');
    expect(meta.content_type).toBe('text/plain');
  });

  it('reflects metadata on task.context.attachments', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'spec.md',
      data: Buffer.from('spec', 'utf8'),
    });
    const task = getTask(id);
    expect(task).not.toBeNull();
    const attachments = readTaskAttachments(task);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe('spec.md');
  });

  it('replaces an existing file with the same sanitized name', async () => {
    const { id } = makeTask();
    await saveAttachment({
      taskId: id,
      filename: 'note.txt',
      data: Buffer.from('first', 'utf8'),
    });
    await saveAttachment({
      taskId: id,
      filename: 'note.txt',
      data: Buffer.from('second', 'utf8'),
    });
    const list = listAttachments(id);
    expect(list).toHaveLength(1);
    const { data } = await readAttachmentBytes(id, 'note.txt');
    expect(data.toString('utf8')).toBe('second');
  });

  it('deletes an attachment from disk + metadata', async () => {
    const { id } = makeTask();
    const saved = await saveAttachment({
      taskId: id,
      filename: 'doomed.txt',
      data: Buffer.from('delete me', 'utf8'),
    });
    expect(fs.existsSync(saved.path)).toBe(true);

    await deleteAttachment(id, 'doomed.txt');
    expect(fs.existsSync(saved.path)).toBe(false);
    const list = listAttachments(id);
    expect(list).toHaveLength(0);
  });

  it('removes the task directory when the task is deleted', async () => {
    const { id } = makeTask();
    const saved = await saveAttachment({
      taskId: id,
      filename: 'leftover.txt',
      data: Buffer.from('temp', 'utf8'),
    });
    expect(fs.existsSync(saved.path)).toBe(true);

    deleteTask(id);
    // The hook fires synchronously but the rm is fire-and-forget — give it
    // a microtask to land.
    await new Promise((r) => setTimeout(r, 50));
    const dir = path.dirname(saved.path);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses uploads over the per-file size limit', async () => {
    const { id } = makeTask();
    // Squeeze the limit way down for the test.
    settingsRepository.set('attachment_max_file_bytes', 16);
    const limits = readAttachmentLimits();
    expect(limits.maxFileBytes).toBe(16);

    await expect(
      saveAttachment({
        taskId: id,
        filename: 'big.bin',
        data: Buffer.alloc(64, 0),
      }),
    ).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('refuses uploads that would exceed the per-task quota', async () => {
    const { id } = makeTask();
    settingsRepository.set('attachment_max_task_bytes', 32);
    settingsRepository.set('attachment_max_file_bytes', 64);

    await saveAttachment({
      taskId: id,
      filename: 'first.bin',
      data: Buffer.alloc(20, 0),
    });
    await expect(
      saveAttachment({
        taskId: id,
        filename: 'second.bin',
        data: Buffer.alloc(20, 0),
      }),
    ).rejects.toMatchObject({ code: 'task_quota_exceeded' });
  });

  it('readAttachmentBytes throws when the file does not exist', async () => {
    const { id } = makeTask();
    await expect(readAttachmentBytes(id, 'nope.txt')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('listAttachments throws for a missing task', () => {
    expect(() => listAttachments('xnotexist1234')).toThrow(AttachmentError);
  });

  it('deleteAttachmentsForTask is idempotent on a missing directory', async () => {
    await expect(
      deleteAttachmentsForTask('nonexistent1'),
    ).resolves.not.toThrow();
  });
});
