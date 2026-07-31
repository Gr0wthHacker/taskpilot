/**
 * Central MCP tool registry.
 *
 * Each tool ships a Zod schema (for runtime validation) and a JSON Schema
 * is derived from it via `schema-helpers#zodToJsonSchema` — the JSON Schema
 * is what MCP clients see, the Zod schema is what we actually parse against
 * at handler-call time.
 *
 * `index.ts` walks this list once at server boot to wire up both the
 * `list_tools` and `call_tool` request handlers.
 */

import { z } from 'zod';

import { attachmentTools } from './tools/attachments';
import { briefingTools } from './tools/briefing';
import { browserTools } from './tools/browser';
import { businessTools } from './tools/businesses';
import { calendarTools } from './tools/calendar';
import { contentTools } from './tools/content';
import { conversationTools } from './tools/conversations';
import { desktopTools } from './tools/desktop';
import { ioTools } from './tools/io';
import { outcomeTools } from './tools/outcomes';
import { prDescriptionTools } from './tools/pr-description';
import { recallTools } from './tools/recall';
import { scheduleTools } from './tools/schedules';
import { taskTools } from './tools/tasks';
import { updateTools } from './tools/updates';
import { webTools } from './tools/web';

/**
 * Generic handler shape. Each tool defines a Zod input schema and a handler
 * that takes the schema's inferred input type and returns a JSON-serializable
 * value (object, array, primitive). Errors thrown from the handler are
 * caught by the dispatcher in `index.ts` and converted into MCP error
 * content blocks.
 */
export interface McpTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Tool name as it appears to MCP clients (e.g. `taskpilot_list_tasks`). */
  name: string;
  /** Human/LLM-readable description. This is the only thing Claude sees. */
  description: string;
  /** Zod schema for the tool's input. */
  inputSchema: TSchema;
  /** Async handler. Receives parsed input, returns any JSON-serialisable value. */
  handler: (input: z.infer<TSchema>) => Promise<unknown>;
}

/**
 * Combined registry. Order is preserved when listing tools to the client so
 * the most common tools (tasks) appear first.
 */
export const tools: McpTool[] = [
  ...taskTools,
  ...calendarTools,
  ...ioTools,
  ...attachmentTools,
  ...conversationTools,
  ...businessTools,
  ...briefingTools,
  ...contentTools,
  ...outcomeTools,
  ...prDescriptionTools,
  ...recallTools,
  ...updateTools,
  ...scheduleTools,
  ...webTools,
  ...browserTools,
  ...desktopTools,
];

/**
 * Lookup helper used by the dispatcher.
 */
export function findTool(name: string): McpTool | undefined {
  return tools.find((t) => t.name === name);
}
