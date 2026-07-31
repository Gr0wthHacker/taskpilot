/**
 * Recently-viewed task store — powers the "Where was I" resume affordance.
 *
 * Unlike the other UI stores this one persists (localStorage via zustand's
 * `persist` middleware) so the resume list survives an app restart — the whole
 * point is to get back into context after stepping away. It records only the
 * minimum needed to render a jump-back row (id + a title snapshot + when);
 * the live task is always re-fetched on click, so a stale title is harmless.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RecentEntry {
  id: string;
  title: string;
  viewedAt: string; // ISO
}

const MAX_RECENTS = 8;

export interface RecentsState {
  recents: RecentEntry[];
  recordVisit: (entry: { id: string; title: string }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

export const useRecentsStore = create<RecentsState>()(
  persist(
    (set) => ({
      recents: [],
      recordVisit: ({ id, title }) =>
        set((state) => {
          const entry: RecentEntry = {
            id,
            title,
            viewedAt: new Date().toISOString(),
          };
          // Move-to-front: drop any existing entry for this id, prepend, cap.
          const rest = state.recents.filter((r) => r.id !== id);
          return { recents: [entry, ...rest].slice(0, MAX_RECENTS) };
        }),
      remove: (id) =>
        set((state) => ({
          recents: state.recents.filter((r) => r.id !== id),
        })),
      clear: () => set({ recents: [] }),
    }),
    { name: 'taskpilot-recents' },
  ),
);
