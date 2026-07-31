/**
 * Permissions editor — owned by the permissions wave.
 *
 * Renders an editable form for a single task's `PermissionSet`, alongside a
 * read-only "Resolved permissions (effective)" panel that mirrors what the
 * server returns after merging the parent chain.
 *
 * Workflow:
 *   - The form starts from `permissions` (the task's own declaration) and
 *     accumulates local edits in `draft`.
 *   - Save persists via PATCH; Reset clears via DELETE so the task falls
 *     back to inheriting from its parent.
 *   - The preset dropdown applies one of the built-in profiles in one click.
 */

import { Eraser, Save, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { Textarea } from '@/renderer/components/ui/textarea';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useApplyPermissionProfile,
  useClearTaskPermissions,
  usePermissionProfiles,
  useTaskPermissions,
  useUpdateTaskPermissions,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type {
  GithubOperation,
  NetworkAccess,
  PermissionProfileName,
  PermissionSet,
} from '@/shared/types';

const NETWORK_OPTIONS: NetworkAccess[] = ['off', 'restricted', 'open'];
const GITHUB_OPS: GithubOperation[] = ['read', 'branch', 'commit', 'pr'];

interface PermissionsEditorProps {
  taskId: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function patternsArrayToText(patterns: string[] | undefined): string {
  return (patterns ?? []).join('\n');
}

function textToPatternsArray(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toolsArrayToText(tools: string[] | undefined): string {
  return (tools ?? []).join(', ');
}

function textToToolsArray(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function emptyPermissionSet(): PermissionSet {
  return {};
}

/**
 * Build the payload to PATCH from the local draft. We strip empty fields so
 * the server stores a minimal block — inheritance fills the rest.
 */
function compactPermissions(draft: PermissionSet): PermissionSet {
  const out: PermissionSet = {};
  if (draft.workspace && draft.workspace.trim().length > 0) {
    out.workspace = draft.workspace.trim();
  }
  if (draft.allowed_tools && draft.allowed_tools.length > 0) {
    out.allowed_tools = draft.allowed_tools;
  }
  if (draft.denied_patterns && draft.denied_patterns.length > 0) {
    out.denied_patterns = draft.denied_patterns;
  }
  if (draft.network_access !== undefined) {
    out.network_access = draft.network_access;
  }
  if (
    draft.max_runtime_minutes !== undefined &&
    Number.isFinite(draft.max_runtime_minutes) &&
    draft.max_runtime_minutes >= 0
  ) {
    out.max_runtime_minutes = draft.max_runtime_minutes;
  }
  if (draft.confirm_destructive !== undefined) {
    out.confirm_destructive = draft.confirm_destructive;
  }
  if (draft.github_repo && draft.github_repo.trim().length > 0) {
    out.github_repo = draft.github_repo.trim();
  }
  if (draft.github_branch_policy && draft.github_branch_policy.trim().length > 0) {
    out.github_branch_policy = draft.github_branch_policy.trim();
  }
  if (draft.github_operations && draft.github_operations.length > 0) {
    out.github_operations = draft.github_operations;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function PermissionsEditor({
  taskId,
  className,
}: PermissionsEditorProps): JSX.Element {
  const { toast } = useToast();
  const permsQ = useTaskPermissions(taskId);
  const profilesQ = usePermissionProfiles();
  const updateMut = useUpdateTaskPermissions();
  const clearMut = useClearTaskPermissions();
  const applyProfileMut = useApplyPermissionProfile();

  const stored = permsQ.data?.permissions ?? null;
  const resolved = permsQ.data?.resolved ?? null;
  const source = permsQ.data?.source ?? 'default';

  const [draft, setDraft] = useState<PermissionSet>(emptyPermissionSet());

  // Re-sync the draft any time the server-side declared permissions change.
  useEffect(() => {
    setDraft(stored ?? emptyPermissionSet());
  }, [stored]);

  const dirty = useMemo(() => {
    return (
      JSON.stringify(compactPermissions(draft)) !==
      JSON.stringify(stored ?? {})
    );
  }, [draft, stored]);

  const handleSave = async (): Promise<void> => {
    try {
      const payload = compactPermissions(draft);
      await updateMut.mutateAsync({ id: taskId, permissions: payload });
      toast({ title: 'Permissions saved' });
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleClear = async (): Promise<void> => {
    try {
      await clearMut.mutateAsync({ id: taskId });
      toast({ title: 'Permissions cleared — now inheriting from parent.' });
    } catch (cause) {
      toast({
        title: 'Clear failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleApplyProfile = async (
    profile: PermissionProfileName,
  ): Promise<void> => {
    try {
      await applyProfileMut.mutateAsync({ task_id: taskId, profile });
      toast({ title: `Applied profile: ${profile}` });
    } catch (cause) {
      toast({
        title: 'Apply failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  if (permsQ.isLoading) {
    return (
      <div
        className={cn('text-xs text-muted-foreground', className)}
        aria-label="permissions-editor-loading"
      >
        Loading permissions…
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col gap-4', className)}
      aria-label="permissions-editor"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Source: {source}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value=""
            onValueChange={(v) => {
              void handleApplyProfile(v as PermissionProfileName);
            }}
          >
            <SelectTrigger
              className="h-8 w-[180px] text-xs"
              aria-label="permissions-apply-preset"
            >
              <SelectValue placeholder="Apply preset…" />
            </SelectTrigger>
            <SelectContent>
              {(profilesQ.data?.profiles ?? []).map((p) => (
                <SelectItem key={p.name} value={p.name}>
                  <Wand2 className="mr-1 inline h-3 w-3" />
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!stored || clearMut.isPending}
            onClick={() => {
              void handleClear();
            }}
            aria-label="permissions-reset-inherit"
          >
            <Eraser className="mr-1 h-3.5 w-3.5" />
            Reset to inherit
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleSave();
            }}
            disabled={!dirty || updateMut.isPending}
            aria-label="permissions-save"
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            {updateMut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Workspace path</Label>
          <Input
            value={draft.workspace ?? ''}
            onChange={(e) =>
              setDraft((s) => ({ ...s, workspace: e.target.value }))
            }
            placeholder="Absolute path. Empty = inherit."
            aria-label="permissions-workspace"
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Reads/writes are confined to this directory.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Allowed tools</Label>
          <Input
            value={toolsArrayToText(draft.allowed_tools)}
            onChange={(e) =>
              setDraft((s) => ({
                ...s,
                allowed_tools: textToToolsArray(e.target.value),
              }))
            }
            placeholder="Read, Write, Edit, Bash(git*,npm*), WebSearch"
            aria-label="permissions-allowed-tools"
            className="h-8 text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Comma-separated. Bash entries support allowlists in parens.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Network access</Label>
          <div
            className="flex items-center gap-3"
            role="radiogroup"
            aria-label="permissions-network"
          >
            {NETWORK_OPTIONS.map((opt) => (
              <label
                key={opt}
                className="inline-flex items-center gap-1 text-xs"
              >
                <input
                  type="radio"
                  name="permissions-network"
                  value={opt}
                  checked={draft.network_access === opt}
                  onChange={() =>
                    setDraft((s) => ({ ...s, network_access: opt }))
                  }
                  aria-label={`permissions-network-${opt}`}
                />
                {opt}
              </label>
            ))}
            <button
              type="button"
              onClick={() =>
                setDraft((s) => {
                  const next = { ...s };
                  delete next.network_access;
                  return next;
                })
              }
              className="text-[11px] text-muted-foreground underline"
              aria-label="permissions-network-clear"
            >
              clear
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Denied patterns</Label>
          <Textarea
            value={patternsArrayToText(draft.denied_patterns)}
            onChange={(e) =>
              setDraft((s) => ({
                ...s,
                denied_patterns: textToPatternsArray(e.target.value),
              }))
            }
            placeholder={'**/.env*\n**/.ssh/**\n**/credentials*'}
            rows={3}
            aria-label="permissions-denied-patterns"
            className="text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            One glob per line. Matched inside the workspace.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Max runtime (minutes)</Label>
          <Input
            type="number"
            min={0}
            value={
              draft.max_runtime_minutes === undefined
                ? ''
                : String(draft.max_runtime_minutes)
            }
            onChange={(e) => {
              const v = e.target.value;
              setDraft((s) => {
                if (v === '') {
                  const next = { ...s };
                  delete next.max_runtime_minutes;
                  return next;
                }
                const n = Number(v);
                return {
                  ...s,
                  max_runtime_minutes: Number.isFinite(n) ? n : undefined,
                };
              });
            }}
            placeholder="e.g. 30"
            aria-label="permissions-max-runtime"
            className="h-8 w-32 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Confirm destructive actions</Label>
          <div className="flex items-center gap-3 text-xs">
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={draft.confirm_destructive === true}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    confirm_destructive: e.target.checked,
                  }))
                }
                aria-label="permissions-confirm-destructive"
              />
              Require confirm for rm / send / publish
            </label>
            <button
              type="button"
              onClick={() =>
                setDraft((s) => {
                  const next = { ...s };
                  delete next.confirm_destructive;
                  return next;
                })
              }
              className="text-[11px] text-muted-foreground underline"
              aria-label="permissions-confirm-clear"
            >
              clear
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">GitHub repo</Label>
          <Input
            value={draft.github_repo ?? ''}
            onChange={(e) =>
              setDraft((s) => ({ ...s, github_repo: e.target.value }))
            }
            placeholder="org/name"
            aria-label="permissions-github-repo"
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">GitHub branch policy</Label>
          <Input
            value={draft.github_branch_policy ?? ''}
            onChange={(e) =>
              setDraft((s) => ({
                ...s,
                github_branch_policy: e.target.value,
              }))
            }
            placeholder="agent/{task_id}"
            aria-label="permissions-github-branch-policy"
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">GitHub operations</Label>
          <div
            className="flex flex-wrap items-center gap-3 text-xs"
            aria-label="permissions-github-operations"
          >
            {GITHUB_OPS.map((op) => {
              const checked = draft.github_operations?.includes(op) ?? false;
              return (
                <label key={op} className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      setDraft((s) => {
                        const current = new Set(s.github_operations ?? []);
                        if (e.target.checked) current.add(op);
                        else current.delete(op);
                        const arr = Array.from(current);
                        const next = { ...s };
                        if (arr.length === 0) {
                          delete next.github_operations;
                        } else {
                          next.github_operations = arr;
                        }
                        return next;
                      })
                    }
                    aria-label={`permissions-github-op-${op}`}
                  />
                  {op}
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div
        className="rounded-md border border-border bg-muted/40 p-3"
        aria-label="permissions-resolved-panel"
      >
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          Resolved permissions (effective)
        </div>
        <pre
          className="max-h-64 overflow-auto text-[11px] leading-relaxed"
          aria-label="permissions-resolved-json"
        >
          {JSON.stringify(resolved ?? {}, null, 2)}
        </pre>
      </div>
    </div>
  );
}
