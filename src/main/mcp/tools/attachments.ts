/**
 * MCP tools for reading attachment content.
 *
 * Today, just one tool: `taskpilot_attachment_read` returns the extracted
 * plain text for an attachment. Supports PDF, DOCX, XLSX, CSV, and a wide set
 * of plain-text / source-code formats. The first call parses + caches; every
 * subsequent call is a single file read.
 */

import { z } from 'zod';

import { listAttachments } from '@/main/attachments';
import { extractAttachmentText } from '@/main/attachments/extract';
import { taskIdSchema } from '@/shared/io-schemas';

import type { McpTool } from '../tool-registry';

/* -------------------------------------------------------------------------- */
/*  Input schema                                                              */
/* -------------------------------------------------------------------------- */

const readInput = z.object({
  task_id: taskIdSchema,
  filename: z.string().min(1).max(200),
});

const listInput = z.object({
  task_id: taskIdSchema,
});

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const readTool: McpTool<typeof readInput> = {
  name: 'taskpilot_attachment_read',
  description:
    "Read the extracted plain-text content of an attachment on a task. Handles PDF, DOCX, XLSX, CSV, and text/source files. Returns `{ ok, format, byte_length, truncated, cached, text }`. When ok=false, `reason` explains why (unsupported type, parse error, too large). The first read parses and caches; subsequent reads are free. Use this to summarize attached documents, pull action items, or feed file content into another step.",
  inputSchema: readInput,
  async handler(input) {
    return await extractAttachmentText(input.task_id, input.filename);
  },
};

const listTool: McpTool<typeof listInput> = {
  name: 'taskpilot_attachment_list',
  description:
    'List every attachment on a task with metadata (filename, size, content type, added_at). Pair with `taskpilot_attachment_read` when you know the task has files but not their names.',
  inputSchema: listInput,
  async handler(input) {
    return { attachments: listAttachments(input.task_id) };
  },
};

export const attachmentTools: McpTool[] = [
  readTool as unknown as McpTool,
  listTool as unknown as McpTool,
];
