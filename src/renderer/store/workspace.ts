/**
 * Workspace store.
 *
 * Each "workspace" is a saved set of tags representing one of Jack's six
 * businesses (IndexThread, Actually Health, Leal Health, HABA, MultiStateMD,
 * Whitecoat Alliance). Selecting one in the sidebar narrows every task list
 * view to tasks tagged with any of the workspace's tags.
 *
 * The store holds:
 *   - `workspaces` — the configured set (mirrored from the `workspaces`
 *     setting key whenever the Settings → Workspaces editor saves).
 *   - `activeWorkspaceId` — the currently-active workspace, or `null` for
 *     "All workspaces" (no filter).
 *
 * Filtering is intentionally client-side (see `applyWorkspaceFilter`) so we
 * don't need to extend the `/api/tasks` query contract. The filter is cheap
 * (linear scan over the rendered list) and keeps the existing API caching
 * keys stable.
 */

import { create } from 'zustand';

import type { Task, Workspace } from '@/shared/types';

/**
 * Defaults seeded for Jack on first run. Keyed off his six existing
 * businesses; users can rename, edit tags, or drop entries via the Settings
 * → Workspaces editor.
 */
export const DEFAULT_WORKSPACES: Workspace[] = [
  {
    id: 'indexthread',
    name: 'IndexThread',
    tags: ['indexthread'],
    color: '#f97316',
  },
  {
    id: 'actually-health',
    name: 'Actually Health',
    tags: ['actually-health'],
    color: '#10b981',
  },
  {
    id: 'leal-health',
    name: 'Leal Health',
    tags: ['leal-health', 'leal'],
    color: '#3b82f6',
  },
  {
    id: 'haba',
    name: 'HABA',
    tags: ['haba'],
    color: '#a855f7',
  },
  {
    id: 'multistatemd',
    name: 'MultiStateMD',
    tags: ['multistatemd'],
    color: '#ec4899',
  },
  {
    id: 'whitecoat-alliance',
    name: 'Whitecoat Alliance',
    tags: ['whitecoat', 'whitecoat-alliance'],
    color: '#06b6d4',
  },
];

export interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;

  setWorkspaces: (next: Workspace[]) => void;
  setActiveWorkspaceId: (id: string | null) => void;
  upsertWorkspace: (ws: Workspace) => void;
  removeWorkspace: (id: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspaces: DEFAULT_WORKSPACES,
  activeWorkspaceId: null,

  setWorkspaces: (next) =>
    set((state) => {
      // Drop the active id if it points to a workspace that no longer exists.
      const stillExists =
        state.activeWorkspaceId !== null &&
        next.some((w) => w.id === state.activeWorkspaceId);
      return {
        workspaces: next,
        activeWorkspaceId: stillExists ? state.activeWorkspaceId : null,
      };
    }),

  setActiveWorkspaceId: (id) => set({ activeWorkspaceId: id }),

  upsertWorkspace: (ws) =>
    set((state) => {
      const idx = state.workspaces.findIndex((w) => w.id === ws.id);
      if (idx === -1) {
        return { workspaces: [...state.workspaces, ws] };
      }
      const next = state.workspaces.slice();
      next[idx] = ws;
      return { workspaces: next };
    }),

  removeWorkspace: (id) =>
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspaceId:
        state.activeWorkspaceId === id ? null : state.activeWorkspaceId,
    })),
}));

/**
 * React hook returning the currently-active workspace (or null for "All").
 * Re-renders the caller when the selection or the workspace set changes.
 * Use this in views so the workspace lens scopes them consistently.
 */
export function useActiveWorkspace(): Workspace | null {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  if (activeWorkspaceId === null) return null;
  return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
}

/**
 * Find the currently-active workspace, or `null` if none is selected.
 *
 * Exposed as a helper so non-React consumers (Zustand subscribers, query
 * hooks) can read it without re-implementing the lookup.
 */
export function getActiveWorkspace(): Workspace | null {
  const state = useWorkspaceStore.getState();
  if (state.activeWorkspaceId === null) return null;
  return (
    state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null
  );
}

/**
 * Drop any task whose tag list doesn't intersect the workspace's tags.
 *
 * - When `workspace` is null, returns the input untouched.
 * - When the workspace has no tags configured, also returns the input
 *   untouched (an empty tag list means "any" rather than "none" — otherwise
 *   the user would have no way to see anything).
 */
export function applyWorkspaceFilter(
  tasks: Task[],
  workspace: Workspace | null,
): Task[] {
  if (!workspace) return tasks;
  if (workspace.tags.length === 0) return tasks;
  const allowed = new Set(workspace.tags.map((t) => t.toLowerCase()));
  return tasks.filter((t) =>
    t.tags.some((tag) => allowed.has(tag.toLowerCase())),
  );
}
