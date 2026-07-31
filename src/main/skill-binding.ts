/**
 * Skill registry + per-task skill bindings (Wave 12 intelligence layer).
 *
 * Each task can declare which Claude skills are most relevant for executing
 * it (stored at `task.context.skills`). On derivation + execution the bound
 * skills ride along in the request so Claude can route to the right
 * specialized prompts.
 *
 * This module exposes:
 *
 *   - `listKnownSkills()` — built-in catalog + user-registered customs.
 *   - `suggestSkillsForTask(task, limit?)` — keyword-based ranker that
 *     returns up to N best-match descriptors for a task.
 *   - `readTaskSkills(task)` — pull `context.skills` off a row.
 *   - `setTaskSkills(taskId, skills)` — persist a binding list.
 *   - `registerCustomSkill(desc)` / `unregisterCustomSkill(name)` —
 *     user-extensible registry persisted via the settings repo.
 *
 * Matching is intentionally simple — keyword overlap. Tasks usually have
 * short titles + a handful of tags, so a TF-IDF style approach would buy
 * very little. The keyword set per skill is hand-curated to make the
 * common routing decisions ("write me a deck" → pptx) trivially correct.
 */

import { taskSkillsSchema, skillIdSchema } from '@/shared/io-schemas';
import type { SkillDescriptor, Task, TaskSkillBindings } from '@/shared/types';

import {
  getTask,
  updateTask,
} from '@/main/db/repositories/tasks';
import { settingsRepository } from '@/main/db/repositories/settings';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const SKILLS_CONTEXT_KEY = 'skills';
const CUSTOM_SKILLS_SETTING_KEY = 'custom_skills_v1';

/* -------------------------------------------------------------------------- */
/*  Built-in skill catalog                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Curated list of Jack's installed skills as of Wave 12. Mirrors what shows
 * up in `~/.claude/skills/*` and the plugin manifests he runs. Order here
 * doesn't matter — the ranker scores against keywords + descriptions.
 *
 * To add a built-in skill: append a new entry below. To add a user-specific
 * skill at runtime: call {@link registerCustomSkill} (persisted to settings).
 */
const BUILT_IN_SKILLS: readonly SkillDescriptor[] = [
  {
    name: 'anthropic-skills:pptx',
    label: 'PowerPoint / slide decks',
    description:
      'Read, edit, or create .pptx slide decks. Use whenever a deck, pitch, or presentation is involved.',
    keywords: [
      'pptx',
      'powerpoint',
      'slides',
      'deck',
      'presentation',
      'pitch',
      'slideshow',
    ],
  },
  {
    name: 'anthropic-skills:docx',
    label: 'Word documents',
    description:
      'Create or manipulate .docx Word documents — reports, memos, letters, proposals with letterheads.',
    keywords: ['docx', 'word', 'doc', 'document', 'memo', 'letter', 'report'],
  },
  {
    name: 'anthropic-skills:pdf',
    label: 'PDF documents',
    description:
      'Read, merge, split, OCR, or generate PDFs. Includes form-filling and encryption.',
    keywords: ['pdf', 'merge', 'split', 'ocr', 'scan'],
  },
  {
    name: 'anthropic-skills:xlsx',
    label: 'Excel spreadsheets',
    description:
      'Read or produce Excel .xlsx workbooks. Use for tabular reports and dashboards.',
    keywords: ['xlsx', 'excel', 'spreadsheet', 'workbook', 'csv'],
  },
  {
    name: 'anthropic-skills:leal-slide-designer',
    label: 'Leal Health slide redesigner',
    description:
      'Rebrand any uploaded slide or deck to the Leal Health visual system. Outputs HTML 16:9 slides.',
    keywords: ['leal', 'leal-health', 'slide', 'rebrand', 'redesign', 'health'],
  },
  {
    name: 'anthropic-skills:lovable-builder',
    label: 'Lovable.dev driver',
    description:
      'Drive lovable.dev via Chrome automation — create, iterate, deploy Lovable apps.',
    keywords: ['lovable', 'app', 'build', 'iterate', 'deploy', 'chrome'],
  },
  {
    name: 'anthropic-skills:web-artifacts-builder',
    label: 'Web artifacts (React/Tailwind)',
    description:
      'Build elaborate claude.ai HTML artifacts using React, Tailwind, shadcn/ui.',
    keywords: ['artifact', 'react', 'tailwind', 'shadcn', 'html', 'frontend'],
  },
  {
    name: 'anthropic-skills:project-manager',
    label: 'Claude project manager',
    description:
      'Create / update Claude Projects via browser automation — instructions, knowledge files.',
    keywords: ['project', 'claude', 'projects', 'manager', 'instructions'],
  },
  {
    name: 'anthropic-skills:fb-content-calendar',
    label: 'Facebook content calendar',
    description:
      'Generate a full Facebook content calendar — interview, copy, image prompts, CSV.',
    keywords: ['facebook', 'fb', 'meta', 'content', 'calendar', 'posts', 'social'],
  },
  {
    name: 'anthropic-skills:nppes-referral-scraper',
    label: 'NPPES referral scraper',
    description:
      'Pull non-physician chronic-care referral sources from CMS NPI Registry by state.',
    keywords: ['nppes', 'npi', 'referral', 'provider', 'cms', 'physical-therapist'],
  },
  {
    name: 'anthropic-skills:subreddit-analyzer',
    label: 'Subreddit analyzer',
    description:
      'Analyze any public subreddit via the JSON API. Posts/comments CSV + markdown report.',
    keywords: ['subreddit', 'reddit', 'analyzer', 'audit', 'community'],
  },
  {
    name: 'reddit-content-crafter',
    label: 'Reddit content crafter',
    description:
      "Write Reddit posts and comments that match a target subreddit's culture and tone.",
    keywords: ['reddit', 'post', 'comment', 'subreddit', 'native', 'tone'],
  },
  {
    name: 'thread-necromancer',
    label: 'Reddit thread necromancer',
    description:
      'Find dormant high-ranking Reddit threads worth reviving for GEO/AI citation visibility.',
    keywords: ['reddit', 'thread', 'dormant', 'geo', 'revive', 'necro'],
  },
  {
    name: 'subreddit-analyzing',
    label: 'Subreddit analyzer (PRAW)',
    description:
      'PRAW-based subreddit analysis — content patterns, engagement, top posts.',
    keywords: ['subreddit', 'reddit', 'praw', 'engagement', 'analysis'],
  },
  {
    name: 'healthcare-compliance-checker',
    label: 'Healthcare compliance checker',
    description:
      'Review healthcare marketing copy for FDA, FTC, HIPAA compliance issues.',
    keywords: [
      'fda',
      'ftc',
      'hipaa',
      'compliance',
      'healthcare',
      'medical',
      'leal',
      'actually-health',
      'regulatory',
    ],
  },
  {
    name: 'content-writing',
    label: 'Content writing (Jack voice)',
    description:
      "Write articles, posts, papers in Jack Gierlich's voice. Sharp, direct, no AI tells.",
    keywords: [
      'write',
      'article',
      'blog',
      'newsletter',
      'linkedin',
      'paper',
      'copy',
      'voice',
    ],
  },
  {
    name: 'deai-checking',
    label: 'DEAI red-flag checker',
    description:
      'Check text for AI writing red flags — em-dashes, hedging, filler transitions.',
    keywords: ['deai', 'ai-detection', 'ai-red-flags', 'check', 'editing'],
  },
  {
    name: 'content-atomizing',
    label: 'Content atomizer',
    description:
      'Break a long-form piece into platform-specific derivative posts (LI, Reddit, ads).',
    keywords: ['atomize', 'repurpose', 'derivative', 'distribution', 'split'],
  },
  {
    name: 'ad-batch-generating',
    label: 'Ad batch generator',
    description:
      'Generate batches of social ad copy as CSV. Meta / Facebook / Instagram ready.',
    keywords: ['ad', 'ads', 'meta', 'facebook', 'instagram', 'csv', 'batch'],
  },
  {
    name: 'email-sequence-writer',
    label: 'Email sequence writer',
    description:
      'Write multi-email drip sequences and nurture campaigns. Subject + preview + body + timing.',
    keywords: ['email', 'drip', 'sequence', 'nurture', 'campaign', 'mailchimp'],
  },
  {
    name: 'landing-page-builder',
    label: 'Landing page builder',
    description:
      'Scaffold conversion landing pages in Next.js + Tailwind + TS. Hero/social/features/CTA/FAQ.',
    keywords: ['landing', 'page', 'conversion', 'next', 'tailwind', 'waitlist'],
  },
  {
    name: 'tsx-component-builder',
    label: 'TSX component builder',
    description:
      'Generate production-ready TSX components/pages for Next.js App Router.',
    keywords: ['tsx', 'react', 'component', 'next', 'page', 'ui', 'frontend'],
  },
  {
    name: 'stack-scaffolder',
    label: 'Stack scaffolder',
    description:
      "Scaffold a new project in Jack's default stack — Next.js + Supabase + Vercel.",
    keywords: ['scaffold', 'init', 'new', 'project', 'supabase', 'next', 'vercel'],
  },
  {
    name: 'seo-auditing',
    label: 'SEO auditor',
    description:
      'Run a technical SEO audit on any website — indexing, meta, sitemap, redirects.',
    keywords: ['seo', 'audit', 'sitemap', 'meta', 'google', 'indexing'],
  },
  {
    name: 'domain-indexer',
    label: 'Domain indexer',
    description:
      'Crawl sitemaps and index page health across a portfolio of domains.',
    keywords: ['domain', 'sitemap', 'index', 'crawl', 'portfolio', 'health'],
  },
  {
    name: 'competitor-teardown',
    label: 'Competitor teardown',
    description:
      'Quick competitive teardown of a website — tech stack, SEO, content, social.',
    keywords: ['competitor', 'teardown', 'compare', 'analysis', 'competitive'],
  },
  {
    name: 'research-brief',
    label: 'Research brief',
    description:
      'Pull data and synthesize a structured brief for client work, content, market analysis.',
    keywords: ['research', 'brief', 'data', 'market', 'analysis', 'background'],
  },
  {
    name: 'meeting-prep',
    label: 'Meeting prep',
    description:
      'Generate meeting prep docs — pull calendar, research attendees, surface context.',
    keywords: ['meeting', 'prep', 'calendar', 'attendees', 'agenda'],
  },
  {
    name: 'one-pager-generator',
    label: 'One-pager generator',
    description:
      'Generate a polished one-page leave-behind / capability sheet as PDF or HTML.',
    keywords: ['one-pager', 'leave-behind', 'capability', 'sell-sheet', 'fact-sheet'],
  },
  {
    name: 'client-proposal-generator',
    label: 'Client proposal generator',
    description:
      'Generate IndexThread Reddit proposals from subreddit data + client context.',
    keywords: ['proposal', 'client', 'indexthread', 'reddit', 'sow', 'pitch'],
  },
  {
    name: 'prd-generating',
    label: 'PRD generator',
    description:
      'Generate a structured Product Requirements Document from a conversation or brief.',
    keywords: ['prd', 'product', 'requirements', 'spec', 'requirements-doc'],
  },
  {
    name: 'biotech-scanner',
    label: 'Biotech investment scanner',
    description:
      'Monitor clinical trials, FDA decisions, small-cap biotech catalysts.',
    keywords: ['biotech', 'oncology', 'fda', 'clinical-trial', 'pdufa', 'investment'],
  },
  {
    name: 'engineering:debug',
    label: 'Structured debug session',
    description:
      'Reproduce, isolate, diagnose, fix bugs methodically. Trigger on error traces.',
    keywords: ['debug', 'bug', 'fix', 'error', 'crash', 'stacktrace'],
  },
  {
    name: 'engineering:code-review',
    label: 'Code review',
    description: 'Review pull requests and code changes for correctness bugs.',
    keywords: ['review', 'code-review', 'pr', 'pull-request'],
  },
  {
    name: 'taskpilot',
    label: 'TaskPilot operator',
    description:
      "Operate TaskPilot — Jack's local-first task & calendar manager via MCP / HTTP.",
    keywords: ['taskpilot', 'task', 'inbox', 'calendar', 'derive', 'execute'],
  },
];

/* -------------------------------------------------------------------------- */
/*  Custom skill persistence                                                  */
/* -------------------------------------------------------------------------- */

interface CustomSkillsBlob {
  v: 1;
  skills: SkillDescriptor[];
}

function readCustomSkills(): SkillDescriptor[] {
  try {
    const raw = settingsRepository.get(CUSTOM_SKILLS_SETTING_KEY);
    if (!raw || typeof raw !== 'string') return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const blob = parsed as { v?: number; skills?: unknown };
    if (blob.v !== 1 || !Array.isArray(blob.skills)) return [];
    const out: SkillDescriptor[] = [];
    for (const entry of blob.skills) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<SkillDescriptor>;
      if (typeof e.name !== 'string' || e.name.length === 0) continue;
      if (typeof e.label !== 'string') continue;
      if (typeof e.description !== 'string') continue;
      const idParsed = skillIdSchema.safeParse(e.name);
      if (!idParsed.success) continue;
      out.push({
        name: e.name,
        label: e.label,
        description: e.description,
        keywords: Array.isArray(e.keywords)
          ? e.keywords.filter((k): k is string => typeof k === 'string')
          : [],
        custom: true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeCustomSkills(skills: SkillDescriptor[]): void {
  const blob: CustomSkillsBlob = { v: 1, skills };
  settingsRepository.set(CUSTOM_SKILLS_SETTING_KEY, JSON.stringify(blob));
}

/* -------------------------------------------------------------------------- */
/*  Public registry API                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Full catalog — built-ins followed by user-registered customs. Customs win
 * on name collisions (so a user can shadow a built-in with their own
 * description / keywords).
 */
export function listKnownSkills(): SkillDescriptor[] {
  const customs = readCustomSkills();
  const customNames = new Set(customs.map((s) => s.name));
  const builtins = BUILT_IN_SKILLS.filter((s) => !customNames.has(s.name));
  return [...builtins, ...customs];
}

export function getSkillByName(name: string): SkillDescriptor | null {
  return listKnownSkills().find((s) => s.name === name) ?? null;
}

/**
 * Register (or update) a custom skill. Validates the name against the strict
 * id alphabet. Returns the materialized descriptor.
 */
export function registerCustomSkill(
  desc: Omit<SkillDescriptor, 'custom'>,
): SkillDescriptor {
  const id = skillIdSchema.parse(desc.name);
  const current = readCustomSkills().filter((s) => s.name !== id);
  const next: SkillDescriptor = {
    name: id,
    label: desc.label.slice(0, 128),
    description: desc.description.slice(0, 2_000),
    keywords: (desc.keywords ?? []).map((k) => k.toLowerCase()).slice(0, 32),
    custom: true,
  };
  writeCustomSkills([...current, next]);
  return next;
}

export function unregisterCustomSkill(name: string): boolean {
  const before = readCustomSkills();
  const after = before.filter((s) => s.name !== name);
  if (after.length === before.length) return false;
  writeCustomSkills(after);
  return true;
}

/* -------------------------------------------------------------------------- */
/*  Per-task skill bindings                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pull `context.skills` off a task. Returns `[]` when missing or invalid.
 */
export function readTaskSkills(task: Task | null): TaskSkillBindings {
  if (!task || !task.context || typeof task.context !== 'object') return [];
  const raw = (task.context as Record<string, unknown>)[SKILLS_CONTEXT_KEY];
  if (!Array.isArray(raw)) return [];
  const parsed = taskSkillsSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data;
}

/**
 * Persist a binding list. Pass `[]` to clear. Returns the stored list (after
 * dedup + validation) or `null` when the task doesn't exist.
 */
export function setTaskSkills(
  taskId: string,
  skills: TaskSkillBindings,
): TaskSkillBindings | null {
  const task = getTask(taskId);
  if (!task) return null;
  const validated = taskSkillsSchema.parse(skills);
  const deduped = Array.from(new Set(validated));

  const ctx =
    task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};
  let nextCtx: Record<string, unknown> | null;
  if (deduped.length === 0) {
    const { [SKILLS_CONTEXT_KEY]: _omit, ...rest } = ctx;
    void _omit;
    nextCtx = Object.keys(rest).length === 0 ? null : rest;
  } else {
    nextCtx = { ...ctx, [SKILLS_CONTEXT_KEY]: deduped };
  }
  updateTask(taskId, { context: nextCtx });
  return deduped;
}

/* -------------------------------------------------------------------------- */
/*  Suggestion ranker                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Tokenize text for keyword matching — lowercase, strip punctuation, drop
 * single-character noise. We don't bother with stemming; the keyword lists
 * already include common forms.
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreSkill(
  descriptor: SkillDescriptor,
  taskTokens: ReadonlySet<string>,
): number {
  const descTokens = new Set(tokenize(descriptor.description));
  const keywordTokens = new Set(
    (descriptor.keywords ?? []).map((k) => k.toLowerCase()),
  );

  let score = 0;
  for (const t of taskTokens) {
    if (keywordTokens.has(t)) score += 5;
    if (descTokens.has(t)) score += 1;
    // Also match keywords that contain the task token as a substring (e.g.
    // task token "facebook" matches keyword "facebook-ad"). Cheap and helps
    // a lot on compound terms.
    for (const k of keywordTokens) {
      if (k !== t && k.includes(t)) score += 2;
    }
  }
  return score;
}

/**
 * Suggest up to `limit` skills for the task based on keyword overlap with
 * its title, tags, description, and agent_instructions. Returns an empty
 * array when nothing meaningful matches — callers should treat that as "no
 * automatic binding" rather than picking the first arbitrary skill.
 */
export function suggestSkillsForTask(
  task: Task,
  limit = 3,
): SkillDescriptor[] {
  const corpus = [
    task.title,
    task.description ?? '',
    task.agent_instructions ?? '',
    task.tags.join(' '),
  ].join(' ');
  const tokens = new Set(tokenize(corpus));
  if (tokens.size === 0) return [];

  const skills = listKnownSkills();
  const scored = skills
    .map((s) => ({ skill: s, score: scoreSkill(s, tokens) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.skill.name.localeCompare(b.skill.name);
    });

  return scored.slice(0, Math.max(0, limit)).map((row) => row.skill);
}

/* -------------------------------------------------------------------------- */
/*  Derive / execute context helpers                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build the markdown SKILLS block to inject into a derive/execute
 * `instructions` payload. Includes both the explicit bindings (if any) and
 * the auto-suggestions so Claude can pick the right hammer.
 *
 * Returns `''` when there are no skills worth mentioning — callers should
 * skip appending an empty block.
 */
export function buildSkillsInstructionsBlock(task: Task): string {
  const bound = readTaskSkills(task);
  const suggestions = suggestSkillsForTask(task, 3).filter(
    (s) => !bound.includes(s.name),
  );
  if (bound.length === 0 && suggestions.length === 0) return '';

  const lines: string[] = ['---SKILLS---'];
  if (bound.length > 0) {
    lines.push('Bound skills (use these — the user picked them):');
    for (const name of bound) {
      const desc = getSkillByName(name);
      lines.push(
        desc ? `- ${desc.name} — ${desc.label}` : `- ${name}`,
      );
    }
  }
  if (suggestions.length > 0) {
    lines.push(
      bound.length > 0
        ? 'Additional candidates (auto-suggested):'
        : 'Suggested skills (auto-matched against title/tags/instructions):',
    );
    for (const s of suggestions) {
      lines.push(`- ${s.name} — ${s.label}`);
    }
  }
  lines.push(
    'Route through the bound skill first when applicable. Skills are invoked via the Skill tool by name.',
  );
  return lines.join('\n');
}

/**
 * Names-only convenience for callers that want to populate the
 * `available_tools` array of a DerivationRequest. Returns bound first
 * (preserved order), then up to 3 auto-suggestions.
 */
export function skillHintsForTask(task: Task): string[] {
  const bound = readTaskSkills(task);
  const suggestions = suggestSkillsForTask(task, 3)
    .map((s) => s.name)
    .filter((n) => !bound.includes(n));
  return [...bound, ...suggestions];
}
