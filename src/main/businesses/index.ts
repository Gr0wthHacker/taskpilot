/**
 * Public facade for the businesses status surface.
 *
 * Exposes the on-demand snapshot, the update-append path, and helpers used
 * by the io watcher + HTTP routes + MCP tool. All on-demand: there's no
 * background scheduler (the user opted for "no background" refresh).
 */

import { ioEvents } from '@/main/io/events';
import { applyProfile } from '@/main/permissions';
import { permissionProfileNameSchema } from '@/shared/io-schemas';
import type { PermissionSet } from '@/shared/types';

import {
  findBusinessByTags,
  getBusiness,
  listBusinesses,
  type BusinessConfig,
} from './loader';
import { renderStatusMarkdown } from './render';
import {
  computeOverview,
  computeSnapshot,
  type BusinessOverviewEntry,
  type BusinessSnapshot,
} from './snapshot';
import {
  appendUpdate,
  readUpdates,
  statusJsonPath,
  statusMdPath,
  updatesFilePath,
  writeSnapshot,
  type StatusUpdate,
} from './storage';

export {
  appendUpdate,
  computeOverview,
  computeSnapshot,
  findBusinessByTags,
  getBusiness,
  listBusinesses,
  readUpdates,
  renderStatusMarkdown,
  statusJsonPath,
  statusMdPath,
  updatesFilePath,
};

export type {
  BusinessOverviewEntry,
  BusinessSnapshot,
  StatusUpdate,
};

/**
 * Compute the snapshot AND persist it to `status.json` + `STATUS.md`.
 * Returns null when the tag isn't configured. Persisting is best-effort —
 * a failed write doesn't break the computation result.
 */
export async function refreshAndPersistSnapshot(
  tag: string,
): Promise<BusinessSnapshot | null> {
  const snap = await computeSnapshot(tag);
  if (!snap) return null;
  const md = renderStatusMarkdown(snap);
  try {
    await writeSnapshot(tag, snap, md);
  } catch {
    /* persistence is a cache, not source of truth — non-fatal */
  }
  return snap;
}

/**
 * Defaults a business carries for newly-derived tasks. Returned as a plain
 * object so the io ingestion layer can splice it into a task's `context`
 * without binding to a specific schema location. Both fields are optional:
 * the caller only applies a field that's present.
 */
export interface BusinessTaskDefaults {
  /** Permission set materialized from `default_permission_profile`. */
  permissions: PermissionSet | null;
  /** Verbatim branch policy string (e.g. `agent/{task_id}`). */
  branch_policy: string | null;
  /** The matched business, when one was found. */
  business: BusinessConfig | null;
}

/**
 * Look up the per-business defaults that should be applied to a freshly
 * derived/inbox task carrying the given tags. Resolves the configured
 * `default_permission_profile` into a concrete {@link PermissionSet} via the
 * existing permissions module. Returns all-nulls when no business matches
 * (caller treats that as a no-op).
 *
 * `taskId` is forwarded to `applyProfile` so the `sandboxed` profile can
 * materialize its per-task workspace path.
 */
export function resolveBusinessDefaults(
  tags: readonly string[],
  taskId?: string,
): BusinessTaskDefaults {
  const business = findBusinessByTags(tags);
  if (!business) {
    return { permissions: null, branch_policy: null, business: null };
  }
  const profileName = business.default_permission_profile;
  let permissions: PermissionSet | null = null;
  if (profileName) {
    const parsed = permissionProfileNameSchema.safeParse(profileName);
    if (parsed.success) {
      permissions = applyProfile(parsed.data, taskId);
    }
  }
  return {
    permissions,
    branch_policy: business.branch_policy ?? null,
    business,
  };
}

/**
 * Append an update for `tag` and immediately re-render the cached snapshot.
 * Used by the io ingestion + the HTTP POST endpoint. Emits an `io_event` on
 * the shared bus so renderer SSE clients refresh.
 */
export async function recordUpdate(
  tag: string,
  update: StatusUpdate,
): Promise<BusinessSnapshot | null> {
  if (!getBusiness(tag)) return null;
  await appendUpdate(tag, update);
  const snap = await refreshAndPersistSnapshot(tag);
  ioEvents.emit('business_status_updated', {
    tag,
    headline: update.headline,
    at: update.at,
  });
  return snap;
}
