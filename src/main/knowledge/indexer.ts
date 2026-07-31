/**
 * Indexing: turn dropped files into `KnowledgeResource` catalog entries +
 * extracted-text sidecars. Single-file upsert, whole-business reindex, and a
 * full sweep. All operations are best-effort and never throw into callers.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  KnowledgeBusinessSummary,
  KnowledgeResource,
} from '@/shared/types';

import {
  extractKeywords,
  readCatalog,
  summarize,
  titleFromFilename,
  writeCatalog,
} from './catalog';
import { extractText } from './extract';
import {
  INDEX_DIRNAME,
  KNOWLEDGE_DIR,
  businessDir,
  indexDir,
  sidecarPath,
  sourcePath,
} from './paths';

/** List business folders (top-level subdirectories of the knowledge root). */
export async function listBusinesses(): Promise<string[]> {
  try {
    const entries = await fs.readdir(KNOWLEDGE_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** List indexable files in a business folder (top-level, skip `.index`/dotfiles). */
async function listFiles(business: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(businessDir(business), {
      withFileTypes: true,
    });
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          e.name !== INDEX_DIRNAME &&
          !e.name.startsWith('.'),
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Build (or rebuild) a single file's resource entry + sidecar. */
export async function indexFile(
  business: string,
  file: string,
): Promise<KnowledgeResource | null> {
  const src = sourcePath(business, file);
  let size = 0;
  try {
    size = (await fs.stat(src)).size;
  } catch {
    return null; // file vanished between scan and index
  }

  const extraction = await extractText(src);
  let sidecar: string | null = null;
  if (extraction.extracted && extraction.text.trim().length > 0) {
    try {
      const dest = sidecarPath(business, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, extraction.text, 'utf8');
      sidecar = dest;
    } catch {
      sidecar = null;
    }
  }

  const title = titleFromFilename(file);
  const resource: KnowledgeResource = {
    business,
    file,
    source_path: src,
    sidecar_path: sidecar,
    title,
    summary: extraction.extracted
      ? summarize(extraction.text)
      : `${title} (text not extracted${
          extraction.reason === 'missing_dep' || extraction.reason === 'no_python'
            ? ' — install extraction deps'
            : ''
        })`,
    keywords: extractKeywords(title, extraction.text),
    size_bytes: size,
    extracted: extraction.extracted,
    indexed_at: new Date().toISOString(),
  };
  return resource;
}

/** Re-index every file in a business and prune catalog entries for files gone. */
export async function reindexBusiness(
  business: string,
): Promise<KnowledgeResource[]> {
  const files = await listFiles(business);
  const resources: KnowledgeResource[] = [];
  for (const file of files) {
    const r = await indexFile(business, file);
    if (r) resources.push(r);
  }
  resources.sort((a, b) => a.file.localeCompare(b.file));
  await writeCatalog(business, resources);
  await pruneSidecars(business, new Set(files));
  return resources;
}

/** Delete sidecars whose source file no longer exists. */
async function pruneSidecars(business: string, keep: Set<string>): Promise<void> {
  try {
    const dir = indexDir(business);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.txt')) continue;
      const origin = e.name.slice(0, -'.txt'.length);
      if (!keep.has(origin)) {
        await fs.rm(path.join(dir, e.name), { force: true });
      }
    }
  } catch {
    /* no index dir yet */
  }
}

/** Re-index every business. Returns the per-business summaries. */
export async function reindexAll(): Promise<KnowledgeBusinessSummary[]> {
  const businesses = await listBusinesses();
  const summaries: KnowledgeBusinessSummary[] = [];
  for (const business of businesses) {
    const resources = await reindexBusiness(business);
    summaries.push(toSummary(business, resources));
  }
  return summaries;
}

/** Incrementally upsert one file into its catalog (used by the watcher). */
export async function upsertFile(business: string, file: string): Promise<void> {
  const resource = await indexFile(business, file);
  if (!resource) return;
  const catalog = await readCatalog(business);
  const next = catalog.filter((r) => r.file !== file);
  next.push(resource);
  next.sort((a, b) => a.file.localeCompare(b.file));
  await writeCatalog(business, next);
}

/** Remove one file from its catalog + drop its sidecar (watcher unlink). */
export async function removeFile(business: string, file: string): Promise<void> {
  const catalog = await readCatalog(business);
  const next = catalog.filter((r) => r.file !== file);
  if (next.length !== catalog.length) await writeCatalog(business, next);
  try {
    await fs.rm(sidecarPath(business, file), { force: true });
  } catch {
    /* already gone */
  }
}

export function toSummary(
  business: string,
  resources: KnowledgeResource[],
): KnowledgeBusinessSummary {
  const extracted = resources.filter((r) => r.extracted).length;
  const last = resources.reduce<string | null>(
    (acc, r) => (acc === null || r.indexed_at > acc ? r.indexed_at : acc),
    null,
  );
  return {
    business,
    file_count: resources.length,
    extracted_count: extracted,
    unextracted_count: resources.length - extracted,
    last_indexed_at: last,
  };
}
