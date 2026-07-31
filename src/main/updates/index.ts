/**
 * Updates-log writer — pushes a single markdown entry to
 * `Gr0wthHacker/updates@main` via the existing github operations module.
 *
 * Keeps the voice contract in one place: every entry has YAML frontmatter
 * (title/date/category/venture/tags/status/visibility), then the prose body.
 * The repo, branch, and `updates/` path are constants — this surface is
 * deliberately narrow.
 */

import { commitFiles } from '@/main/github/operations';

const REPO_OWNER = 'Gr0wthHacker';
const REPO_NAME = 'updates';
const REPO_BRANCH = 'main';

/**
 * Categories the public updates feed renders into. Includes Jack's reality —
 * growth experiments, pivots, client wins — alongside the generic system /
 * research / launch labels for engineering posts.
 */
export type UpdateCategory =
  | 'launch'
  | 'system'
  | 'research'
  | 'fix'
  | 'note'
  | 'growth-experiment'
  | 'pivot'
  | 'client-win'
  | 'lesson';

export interface UpdateFrontmatter {
  title: string;
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  category: UpdateCategory;
  /** Free-text venture/project tag (`personal`, `leal-health`, etc.). */
  venture: string;
  tags: string[];
  status?: 'shipped' | 'in_flight' | 'planning';
  link?: string;
  visibility?: 'public' | 'private';
}

export interface PublishUpdateInput {
  /**
   * URL-safe slug — `[a-z0-9-]+`. Becomes the filename:
   * `updates/<date>-<slug>.md`. Caller chooses, so a manual edit + republish
   * lands at the same path.
   */
  slug: string;
  frontmatter: UpdateFrontmatter;
  body: string;
  /** Override the commit message; defaults to "add updates entry: <title>". */
  commit_message?: string;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,80}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function renderFrontmatter(fm: UpdateFrontmatter): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${JSON.stringify(fm.title)}`);
  lines.push(`date: ${fm.date}`);
  lines.push(`category: ${fm.category}`);
  lines.push(`venture: ${fm.venture}`);
  lines.push(`tags: [${fm.tags.join(', ')}]`);
  if (fm.status) lines.push(`status: ${fm.status}`);
  if (fm.link) lines.push(`link: ${fm.link}`);
  if (fm.visibility) lines.push(`visibility: ${fm.visibility}`);
  lines.push('---');
  return lines.join('\n');
}

export interface PublishResult {
  path: string;
  sha: string;
  url: string;
}

/**
 * Render the entry, push it, return the per-file sha + a github URL.
 * Throws on slug/date validation, propagates github errors verbatim.
 */
export async function publishUpdate(input: PublishUpdateInput): Promise<PublishResult> {
  if (!SLUG_REGEX.test(input.slug)) {
    throw new Error(
      `Invalid slug: ${JSON.stringify(input.slug)}. Use a-z, 0-9, hyphens.`,
    );
  }
  if (!DATE_REGEX.test(input.frontmatter.date)) {
    throw new Error(
      `Invalid date: ${JSON.stringify(input.frontmatter.date)}. Use YYYY-MM-DD.`,
    );
  }
  const filePath = `updates/${input.frontmatter.date}-${input.slug}.md`;
  const fileBody = `${renderFrontmatter(input.frontmatter)}\n\n${input.body.trimEnd()}\n`;
  const message =
    input.commit_message ?? `add updates entry: ${input.frontmatter.title}`;
  const result = await commitFiles({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: REPO_BRANCH,
    message,
    files: [{ path: filePath, content: fileBody }],
  });
  const sha = result.commits[0]?.sha ?? result.sha;
  return {
    path: filePath,
    sha,
    url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${REPO_BRANCH}/${filePath}`,
  };
}
