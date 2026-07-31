/**
 * Filesystem layout for the local knowledge base.
 *
 *   ~/.taskpilot/knowledge/
 *     <business-slug>/            ← user drops .pptx/.pdf/.docx/.md/.txt here
 *       .index/                   ← generated, never edited by hand
 *         <file>.txt              ← extracted plain text (the agent reads this)
 *         catalog.json            ← KnowledgeResource[] metadata
 *
 * All joins go through `safeJoin` so a crafted business/file name can't escape
 * the knowledge root.
 */

import path from 'node:path';

import { TASKPILOT_HOME } from '@/shared/constants';
import { safeJoin } from '@/main/io/paths';

/** Root of the knowledge base. */
export const KNOWLEDGE_DIR = path.join(TASKPILOT_HOME, 'knowledge');

/** Hidden per-business index directory name. */
export const INDEX_DIRNAME = '.index';

/** Catalog filename inside each business's `.index/`. */
export const CATALOG_FILENAME = 'catalog.json';

/** Absolute path to a business folder. */
export function businessDir(business: string): string {
  return safeJoin(KNOWLEDGE_DIR, business);
}

/** Absolute path to a business's `.index/` directory. */
export function indexDir(business: string): string {
  return safeJoin(KNOWLEDGE_DIR, business, INDEX_DIRNAME);
}

/** Absolute path to a business's catalog.json. */
export function catalogPath(business: string): string {
  return safeJoin(KNOWLEDGE_DIR, business, INDEX_DIRNAME, CATALOG_FILENAME);
}

/** Absolute path to the extracted-text sidecar for a file. */
export function sidecarPath(business: string, file: string): string {
  return safeJoin(KNOWLEDGE_DIR, business, INDEX_DIRNAME, `${file}.txt`);
}

/** Absolute path to the original dropped file. */
export function sourcePath(business: string, file: string): string {
  return safeJoin(KNOWLEDGE_DIR, business, file);
}
