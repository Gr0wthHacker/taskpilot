/**
 * WorkspacesEditor — Settings → Workspaces tab.
 *
 * Lets the user inspect, rename, edit tags, recolor, add, and delete the
 * workspaces seeded in `DEFAULT_WORKSPACES`. Changes flow through the
 * Zustand store first (so the sidebar picker updates immediately) and then
 * persist to the `workspaces` setting key via `saveWorkspacesToSettings`.
 *
 * The editor is intentionally simple: one row per workspace with name + tag
 * input + color swatch, plus an "Add workspace" button that appends a blank
 * entry. There's no per-row save button — every change writes through on
 * blur to keep the editor consistent with the rest of Settings, where edits
 * persist immediately.
 */

import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { useToast } from '@/renderer/components/ui/use-toast';
import { TagInput } from '@/renderer/components/shared/TagInput';
import {
  resetWorkspacesToDefaults,
  saveWorkspacesToSettings,
} from '@/renderer/lib/workspace-boot';
import { useWorkspaceStore } from '@/renderer/store/workspace';
import type { Workspace } from '@/shared/types';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

function makeUniqueId(base: string, existing: Workspace[]): string {
  if (base.length === 0) base = 'workspace';
  let candidate = base;
  let i = 2;
  while (existing.some((w) => w.id === candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

export function WorkspacesEditor(): JSX.Element {
  const { toast } = useToast();
  const storeWorkspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);

  // Local working copy so name edits can be debounced/finalized on blur
  // without flickering the sidebar picker during a keystroke.
  const [draft, setDraft] = useState<Workspace[]>(storeWorkspaces);
  useEffect(() => {
    setDraft(storeWorkspaces);
  }, [storeWorkspaces]);

  const commit = useCallback(
    async (next: Workspace[]): Promise<void> => {
      setWorkspaces(next);
      try {
        await saveWorkspacesToSettings(next);
      } catch (cause) {
        toast({
          title: 'Couldn’t save workspaces',
          description:
            cause instanceof Error ? cause.message : 'Unknown error',
          variant: 'destructive',
        });
      }
    },
    [setWorkspaces, toast],
  );

  const updateAt = (idx: number, patch: Partial<Workspace>): Workspace[] => {
    const next = draft.slice();
    const current = next[idx];
    if (!current) return next;
    next[idx] = { ...current, ...patch };
    return next;
  };

  const handleNameChange = (idx: number, name: string): void => {
    setDraft((s) => {
      const next = s.slice();
      const current = next[idx];
      if (!current) return s;
      next[idx] = { ...current, name };
      return next;
    });
  };

  const handleNameBlur = async (idx: number): Promise<void> => {
    const next = updateAt(idx, { name: draft[idx]?.name ?? '' });
    await commit(next);
  };

  const handleTagsChange = async (
    idx: number,
    tags: string[],
  ): Promise<void> => {
    const next = updateAt(idx, { tags });
    setDraft(next);
    await commit(next);
  };

  const handleColorChange = async (
    idx: number,
    color: string,
  ): Promise<void> => {
    const next = updateAt(idx, { color });
    setDraft(next);
    await commit(next);
  };

  const handleDelete = async (idx: number): Promise<void> => {
    const target = draft[idx];
    if (!target) return;
    const ok = window.confirm(`Delete workspace "${target.name}"?`);
    if (!ok) return;
    const next = draft.filter((_, i) => i !== idx);
    await commit(next);
    toast({ title: 'Workspace deleted', description: target.name });
  };

  const handleAdd = async (): Promise<void> => {
    const id = makeUniqueId('workspace', draft);
    const fresh: Workspace = {
      id,
      name: 'Untitled workspace',
      tags: [],
    };
    const next = [...draft, fresh];
    await commit(next);
  };

  const handleResetDefaults = async (): Promise<void> => {
    const ok = window.confirm(
      'Reset to default workspaces? Your custom workspaces will be replaced.',
    );
    if (!ok) return;
    await resetWorkspacesToDefaults();
    toast({ title: 'Workspaces reset to defaults' });
  };

  // Whenever a name's slug doesn't match its current id (e.g. the user
  // renamed it), regenerate the id on next commit. We don't surface this in
  // the UI — ids are only meaningful to remember the active selection — but
  // a stable, descriptive slug helps when inspecting the DB.
  const reslug = async (idx: number): Promise<void> => {
    const target = draft[idx];
    if (!target) return;
    const slug = slugify(target.name);
    if (slug.length === 0 || slug === target.id) return;
    const existing = draft.filter((_, i) => i !== idx);
    const nextId = makeUniqueId(slug, existing);
    if (nextId === target.id) return;
    const next = draft.slice();
    next[idx] = { ...target, id: nextId };
    setDraft(next);
    await commit(next);
  };

  return (
    <div aria-label="settings-workspaces" className="space-y-3">
      <div className="text-xs text-muted-foreground">
        Workspaces scope every list view to a set of tags. Use them to switch
        between businesses (IndexThread, Actually Health, Leal Health…) in
        the sidebar.
      </div>

      <ul className="space-y-2" aria-label="workspaces-list">
        {draft.map((ws, idx) => (
          <li
            key={ws.id}
            className="rounded-md border border-border bg-card/40 p-3"
            aria-label={`workspace-row-${ws.id}`}
          >
            <div className="flex items-start gap-2">
              <input
                type="color"
                value={ws.color ?? '#888888'}
                onChange={(e) => {
                  void handleColorChange(idx, e.target.value);
                }}
                aria-label={`workspace-color-${ws.id}`}
                className="mt-6 h-7 w-7 shrink-0 cursor-pointer rounded border border-border"
              />
              <div className="flex-1 space-y-2">
                <div className="space-y-1">
                  <Label
                    htmlFor={`workspace-name-${ws.id}`}
                    className="text-xs"
                  >
                    Name
                  </Label>
                  <Input
                    id={`workspace-name-${ws.id}`}
                    value={ws.name}
                    onChange={(e) => handleNameChange(idx, e.target.value)}
                    onBlur={() => {
                      void handleNameBlur(idx).then(() => void reslug(idx));
                    }}
                    aria-label={`workspace-name-input-${ws.id}`}
                    className="h-8 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tags (match any)</Label>
                  <TagInput
                    value={ws.tags}
                    onChange={(next) => {
                      void handleTagsChange(idx, next);
                    }}
                    ariaLabel={`workspace-tags-${ws.id}`}
                  />
                  {ws.tags.length === 0 && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300">
                      No tags — this workspace will match every task. Add at
                      least one tag to scope it.
                    </div>
                  )}
                </div>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-6 h-7 w-7"
                onClick={() => {
                  void handleDelete(idx);
                }}
                aria-label={`workspace-delete-${ws.id}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void handleAdd();
          }}
          aria-label="workspaces-add"
        >
          <Plus className="mr-1 h-4 w-4" />
          Add workspace
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            void handleResetDefaults();
          }}
          aria-label="workspaces-reset"
        >
          <RotateCcw className="mr-1 h-4 w-4" />
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

export default WorkspacesEditor;
