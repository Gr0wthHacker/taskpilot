/**
 * Renderer-only UI state. Persistence is intentionally out of scope here —
 * server state lives in React Query, and these slices are ephemeral view
 * preferences (filters, selection, sidebar collapse).
 */

import { create } from 'zustand';

import type { TaskPriority, TaskStatus } from '@/shared/types';

export type ThemePreference = 'light' | 'dark' | 'system';

export interface TaskViewFilters {
  status: TaskStatus | 'all';
  priority: TaskPriority | 'all';
  agentOnly: boolean;
  search: string;
  tag: string | null;
}

export const DEFAULT_FILTERS: TaskViewFilters = {
  status: 'all',
  priority: 'all',
  agentOnly: false,
  search: '',
  tag: null,
};

export interface UiState {
  filters: TaskViewFilters;
  sidebarCollapsed: boolean;
  theme: ThemePreference;
  selectedTaskIds: string[];

  setFilter: <K extends keyof TaskViewFilters>(
    key: K,
    value: TaskViewFilters[K],
  ) => void;
  resetFilters: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;

  setSelectedTaskIds: (ids: string[]) => void;
  toggleTaskSelected: (id: string) => void;
  clearSelection: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  filters: DEFAULT_FILTERS,
  sidebarCollapsed: false,
  theme: 'system',
  selectedTaskIds: [],

  setFilter: (key, value) =>
    set((state) => ({ filters: { ...state.filters, [key]: value } })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS }),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

  setSelectedTaskIds: (ids) => set({ selectedTaskIds: ids }),
  toggleTaskSelected: (id) =>
    set((state) => {
      const has = state.selectedTaskIds.includes(id);
      return {
        selectedTaskIds: has
          ? state.selectedTaskIds.filter((existing) => existing !== id)
          : [...state.selectedTaskIds, id],
      };
    }),
  clearSelection: () => set({ selectedTaskIds: [] }),
}));
