/**
 * `/api/import/...` routes.
 *
 * Two endpoints power the bulk-import wizard:
 *
 *   - `POST /api/import/preview` — parse the content, evaluate the mapping,
 *     and return the first 10 mapped tasks plus aggregate counts. No DB
 *     writes. The renderer uses this to render the preview table.
 *   - `POST /api/import/commit` — same parsing path, but actually inserts
 *     the tasks. Returns counts + an error list pinned to row numbers.
 *
 * Format support:
 *   - `format: 'csv'` — body.content is a CSV string.
 *   - `format: 'notion'` — body.content is the Notion CSV export; optional
 *     `body.markdowns` lets the renderer pass per-row markdown files
 *     extracted from the export zip.
 *
 * The CRUD endpoints for webhook configs (`/api/webhooks/configs/*`) live
 * in this same file even though their path doesn't match — co-locating
 * them with `import.ts` was tempting but they have nothing to do with
 * imports. They live in `routes/webhooks-configs.ts` instead (mounted
 * separately).
 *
 * Wave 13 — Agent M.
 */

import { Router } from 'express';
import { z } from 'zod';

import { parseCsv } from '@/main/import/csv';
import {
  commitImport,
  previewImport,
  suggestMapping,
  type MappingConfig,
} from '@/main/import/mapper';
import { parseNotionExport } from '@/main/import/notion';

import { ApiHttpError } from '../errors';
import { asyncHandler, validateBody } from '../middleware';

/* -------------------------------------------------------------------------- */
/*  Schemas                                                                   */
/* -------------------------------------------------------------------------- */

const taskPrioritySchema = z.enum(['p0', 'p1', 'p2', 'p3']);
const agentMethodSchema = z.enum(['cowork', 'cli', 'either', 'human_only']);

const mappingSchema = z.object({
  title_column: z.string().min(1).max(200),
  description_column: z.string().min(1).max(200).optional(),
  priority_column: z.string().min(1).max(200).optional(),
  priority_map: z.record(z.string().min(1), taskPrioritySchema).optional(),
  tag_columns: z.array(z.string().min(1).max(200)).max(16).optional(),
  skip_duplicates_by: z.string().min(1).max(200).optional(),
  agent_method: agentMethodSchema.optional(),
  default_priority: taskPrioritySchema.optional(),
});

const formatSchema = z.enum(['csv', 'notion']);

const previewBodySchema = z.object({
  format: formatSchema,
  content: z.string().min(1).max(5_000_000),
  mapping: mappingSchema,
  /** Optional Notion markdowns map: filename → body. */
  markdowns: z.record(z.string(), z.string().max(500_000)).optional(),
});

const commitBodySchema = previewBodySchema.extend({
  options: z
    .object({
      import_tag: z.string().min(1).max(64).optional(),
      source: z.string().min(1).max(64).optional(),
    })
    .optional(),
});

const suggestBodySchema = z.object({
  format: formatSchema,
  content: z.string().min(1).max(5_000_000),
});

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

function parseContent(
  format: 'csv' | 'notion',
  content: string,
  markdowns?: Record<string, string>,
): ParsedSheet {
  if (format === 'csv') {
    return parseCsv(content);
  }
  // notion
  const result = parseNotionExport(content, markdowns);
  // For commit/preview we care about CSV-style rows. Markdowns get
  // attached as a description fallback when the mapping doesn't supply
  // a description column — that wiring lives in the mapper. Here we
  // just hand the flattened rows back.
  return {
    headers: result.headers,
    rows: result.rows.map((r) => {
      if (r.markdown !== null) {
        // Surface the markdown as a synthetic column the user can map
        // to `description_column` in the wizard.
        return { ...r.csv, __notion_markdown: r.markdown };
      }
      return r.csv;
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function importRouter(): Router {
  const router = Router();

  // POST /api/import/suggest -------------------------------------------------
  // Parse the content and return a suggested MappingConfig. Used by the
  // wizard's auto-fill step.
  router.post(
    '/suggest',
    validateBody(suggestBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof suggestBodySchema>;
      let parsed: ParsedSheet;
      try {
        parsed = parseContent(body.format, body.content);
      } catch (err) {
        throw new ApiHttpError(
          400,
          'invalid_content',
          err instanceof Error ? err.message : 'Failed to parse content',
        );
      }
      const suggestion = suggestMapping(parsed.headers);
      res.json({
        headers: parsed.headers,
        row_count: parsed.rows.length,
        suggestion,
      });
    }),
  );

  // POST /api/import/preview ------------------------------------------------
  router.post(
    '/preview',
    validateBody(previewBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof previewBodySchema>;
      let parsed: ParsedSheet;
      try {
        parsed = parseContent(body.format, body.content, body.markdowns);
      } catch (err) {
        throw new ApiHttpError(
          400,
          'invalid_content',
          err instanceof Error ? err.message : 'Failed to parse content',
        );
      }
      if (!parsed.headers.includes(body.mapping.title_column)) {
        throw new ApiHttpError(
          400,
          'invalid_mapping',
          `title_column "${body.mapping.title_column}" not present in headers`,
        );
      }
      const preview = previewImport(parsed.rows, body.mapping as MappingConfig);
      res.json({
        headers: parsed.headers,
        ...preview,
      });
    }),
  );

  // POST /api/import/commit -------------------------------------------------
  router.post(
    '/commit',
    validateBody(commitBodySchema),
    asyncHandler(async (req, res) => {
      const body = req.body as z.infer<typeof commitBodySchema>;
      let parsed: ParsedSheet;
      try {
        parsed = parseContent(body.format, body.content, body.markdowns);
      } catch (err) {
        throw new ApiHttpError(
          400,
          'invalid_content',
          err instanceof Error ? err.message : 'Failed to parse content',
        );
      }
      if (!parsed.headers.includes(body.mapping.title_column)) {
        throw new ApiHttpError(
          400,
          'invalid_mapping',
          `title_column "${body.mapping.title_column}" not present in headers`,
        );
      }
      const result = commitImport(
        parsed.rows,
        body.mapping as MappingConfig,
        {
          ...(body.options ?? {}),
          source: body.options?.source ?? body.format,
        },
      );
      res.json(result);
    }),
  );

  return router;
}
