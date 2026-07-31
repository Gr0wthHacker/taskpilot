/**
 * TaskPilot MCP server.
 *
 * Exposes TaskPilot's task, calendar, and I/O capabilities to MCP clients
 * (Claude in Cowork / Claude Code / claude.ai) through the standard
 * Model Context Protocol.
 *
 * Two entry points:
 *   - `startMcpServer()`         — boots the server on stdio (default) and
 *                                   returns a handle with `.stop()`.
 *   - `src/main/mcp/standalone.ts` — wraps `startMcpServer()` for the
 *                                    `npm run mcp` script.
 *
 * Tool definitions live in `./tools/*` and are aggregated by
 * `./tool-registry`. Adding a new tool means appending to the relevant
 * `*Tools` array — the request handlers below pick it up automatically.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { APP_VERSION } from '@/shared/constants';
import { getDb } from '@/main/db';

import { zodToJsonSchema } from './schema-helpers';
import { findTool, tools } from './tool-registry';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type McpTransportKind = 'stdio' | 'http';

export interface McpServerHandle {
  /** Gracefully shut the server down. Idempotent. */
  stop(): Promise<void>;
}

interface ToolContentBlock {
  type: 'text';
  text: string;
}

interface ToolCallResponse {
  content: ToolContentBlock[];
  isError?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Server construction                                                       */
/* -------------------------------------------------------------------------- */

function buildServer(): Server {
  const server = new Server(
    {
      name: 'taskpilot',
      version: APP_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Tools advertisement — Claude reads this list to know what's available.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
      })),
    };
  });

  // Tool dispatcher — find by name, parse input via Zod, await handler,
  // serialize as a single text content block.
  // Cast through `unknown` because the SDK's ServerResult type drifts between
  // versions; our ToolCallResponse satisfies the protocol at runtime.
  server.setRequestHandler(CallToolRequestSchema, (async (request: {
    params: { name: string; arguments?: Record<string, unknown> };
  }) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = findTool(name);

    if (!tool) {
      return errorResponse(`Unknown tool: ${name}`);
    }

    try {
      const input = tool.inputSchema.parse(rawArgs ?? {});
      const result = await tool.handler(input);
      return successResponse(result);
    } catch (err: unknown) {
      return errorResponse(formatError(err));
    }
  }) as unknown as Parameters<typeof server.setRequestHandler>[1]);

  return server;
}

function successResponse(value: unknown): ToolCallResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResponse(message: string): ToolCallResponse {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    // Surface a structured error code when the calendar module supplies one,
    // so the client can react (`CALENDAR_NOT_CONFIGURED`, `CALENDAR_AUTH`, etc.).
    const code = (err as { code?: string }).code;
    if (code) return `[${code}] ${err.message}`;
    return err.message;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Boot the TaskPilot MCP server.
 *
 * Currently only `stdio` is implemented — that's what every MCP client uses
 * today (Claude Desktop, Claude Code, claude.ai's local MCP clients). The
 * `http` transport is reserved for future work; calling it throws.
 *
 * DB access is initialised eagerly via `getDb()` so the first tool call
 * doesn't pay the migration cost.
 */
export async function startMcpServer(
  transport: McpTransportKind = 'stdio',
): Promise<McpServerHandle> {
  if (transport === 'http') {
    throw new Error(
      'HTTP transport is not implemented yet; use stdio (the default).',
    );
  }

  // Eager DB warm-up — surfaces migration / FS errors at boot rather than
  // on the first task-related tool call.
  getDb();

  const server = buildServer();
  const conn = new StdioServerTransport();
  await server.connect(conn);

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await server.close();
      } catch {
        // best-effort shutdown
      }
    },
  };
}
