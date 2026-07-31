/**
 * Type contract for the publishing pipeline.
 *
 * Mirrored 1:1 in `src/shared/api-contract.ts` so the renderer + tests can
 * import directly without crossing the API boundary. Field names are stable —
 * the storage layer reads and writes these shapes verbatim.
 */

export const CONTENT_STATES = [
  'draft',
  'deai_checked',
  'atomized',
  'scheduled',
  'published',
  'tracked',
  'skipped',
] as const;

export type ContentState = (typeof CONTENT_STATES)[number];

export const CONTENT_CHANNELS = [
  'linkedin',
  'reddit',
  'newsletter',
  'twitter',
  'blog',
] as const;

export type ContentChannel = (typeof CONTENT_CHANNELS)[number];

export interface ContentDerivative {
  channel: ContentChannel;
  markdown: string;
  /** ISO timestamp the user planned for this channel, or null. */
  scheduled_at: string | null;
  /** ISO timestamp the user marked the post live, or null. */
  published_at: string | null;
  /** External URL to the live post, or null. */
  published_url: string | null;
}

export interface ContentPiece {
  id: string;
  title: string;
  /** Tag from `projects.json`, or null when the piece isn't business-scoped. */
  business: string | null;
  state: ContentState;
  /** Long-form draft markdown. Often the source of truth for atomization. */
  draft_markdown: string;
  derivatives: ContentDerivative[];
  /** Optional marketing-experiment hypothesis attached to the piece. */
  hypothesis: string | null;
  /** Free-text working notes. */
  notes: string | null;
  /** Free-form tags. Excludes the business tag (which is its own field). */
  tags: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Allowed forward transitions in the publishing state machine. A piece can
 * always be sent back to `draft` (the "I need to rework this" escape hatch),
 * and any pre-published state can be sent to `skipped` ("I decided not to
 * ship this — file it, don't let it stall in draft forever").
 */
export const FORWARD_TRANSITIONS: Record<ContentState, ContentState[]> = {
  draft: ['deai_checked', 'skipped'],
  deai_checked: ['atomized', 'draft', 'skipped'],
  atomized: ['scheduled', 'draft', 'skipped'],
  scheduled: ['published', 'draft', 'skipped'],
  published: ['tracked'],
  tracked: [],
  skipped: ['draft'],
};

/** Returns true when `to` is a legal next state from `from`. */
export function canTransition(from: ContentState, to: ContentState): boolean {
  if (to === 'draft') return true; // always allowed to rewind
  return FORWARD_TRANSITIONS[from].includes(to);
}
