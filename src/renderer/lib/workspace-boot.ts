/**
 * Workspace hydration / persistence helpers.
 *
 * Workspaces live as a single JSON array under the `workspaces` setting key.
 * On app boot we read that setting and seed the Zustand workspace store; if
 * the setting is missing (first run) we leave the store on its baked-in
 * defaults — `DEFAULT_WORKSPACES`, which covers Jack's six businesses.
 *
 * Persistence is paired: any place in the UI that mutates the workspace list
 * (Settings → Workspaces editor) should call `saveWorkspacesToSettings()` to
 * write the change back. We avoid auto-syncing every store mutation so we
 * don't pay an HTTP round-trip for in-flight edits — the editor batches a
 * single save on each apply.
 */

import { api } from './api';
import {
  DEFAULT_WORKSPACES,
  useWorkspaceStore,
} from '@/renderer/store/workspace';
import type { Workspace } from '@/shared/types';

interface SettingValueResponse {
  value: string | null;
}

/**
 * Coerce arbitrary JSON-ish data into a clean `Workspace[]`. Drops malformed
 * entries silently so a corrupted setting doesn't crash the UI — the editor
 * will show whatever survives.
 */
function coerceWorkspaces(raw: unknown): Workspace[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Workspace[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : null;
    const name = typeof obj.name === 'string' ? obj.name : null;
    const tags = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string')
      : null;
    if (!id || !name || !tags) continue;
    const ws: Workspace = { id, name, tags };
    if (typeof obj.color === 'string') ws.color = obj.color;
    if (typeof obj.icon === 'string') ws.icon = obj.icon;
    out.push(ws);
  }
  return out;
}

export async function hydrateWorkspacesFromSettings(): Promise<void> {
  try {
    const res = await api.get<SettingValueResponse>(
      '/api/settings/workspaces',
    );
    if (!res.value) {
      // First run — keep the seeded defaults already in the store.
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(res.value);
    } catch {
      // Older versions may have stored the value as a raw JSON object
      // (settingsRepo JSON-encodes everything itself); treat un-parseable
      // as "first run" and keep defaults.
      return;
    }
    const next = coerceWorkspaces(parsed);
    if (next && next.length > 0) {
      useWorkspaceStore.getState().setWorkspaces(next);
    }
  } catch {
    // Server not reachable → keep seeded defaults.
  }
}

export async function saveWorkspacesToSettings(
  workspaces: Workspace[],
): Promise<void> {
  await api.patch('/api/settings/workspaces', {
    value: JSON.stringify(workspaces),
  });
}

/**
 * Convenience: reset to baked-in defaults and persist.
 */
export async function resetWorkspacesToDefaults(): Promise<void> {
  useWorkspaceStore.getState().setWorkspaces(DEFAULT_WORKSPACES);
  await saveWorkspacesToSettings(DEFAULT_WORKSPACES);
}
