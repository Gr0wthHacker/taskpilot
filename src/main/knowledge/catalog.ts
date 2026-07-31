/**
 * Catalog read/write + the heuristics that turn extracted text into a
 * `KnowledgeResource` (title, summary, keywords). Pure-ish helpers; all disk
 * access is defensive (missing/corrupt catalog → empty list).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { KnowledgeResource } from '@/shared/types';

import { catalogPath } from './paths';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her',
  'was', 'one', 'our', 'out', 'his', 'has', 'had', 'how', 'who', 'its', 'they',
  'their', 'this', 'that', 'with', 'from', 'have', 'will', 'your', 'what',
  'when', 'which', 'them', 'then', 'than', 'into', 'more', 'most', 'over',
  'such', 'only', 'also', 'been', 'were', 'about', 'would', 'these', 'there',
  'where', 'while', 'every', 'each', 'some', 'other', 'after', 'before',
]);

function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Human title from a filename: strip ext, normalize separators. */
export function titleFromFilename(file: string): string {
  const base = file.replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Leading non-empty text, capped — used as the candidate-menu summary. */
export function summarize(text: string, max = 360): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

/** Top keywords by frequency across the title + extracted text. */
export function extractKeywords(title: string, text: string, limit = 14): string[] {
  const counts = new Map<string, number>();
  // Title tokens get a head start so filename signal isn't drowned out.
  for (const t of tokenize(title)) counts.set(t, (counts.get(t) ?? 0) + 3);
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, limit)
    .map(([word]) => word);
}

/** Read a business's catalog. Returns `[]` on missing/corrupt file. */
export async function readCatalog(business: string): Promise<KnowledgeResource[]> {
  try {
    const raw = await fs.readFile(catalogPath(business), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is KnowledgeResource =>
        !!r && typeof r === 'object' && typeof (r as KnowledgeResource).file === 'string',
    );
  } catch {
    return [];
  }
}

/** Atomically write a business's catalog. Creates `.index/` if needed. */
export async function writeCatalog(
  business: string,
  resources: KnowledgeResource[],
): Promise<void> {
  const dest = catalogPath(business);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(resources, null, 2), 'utf8');
  await fs.rename(tmp, dest);
}
