/**
 * Lovable.dev integration card for Settings → Integrations.
 *
 * Lovable is browser-automated by the `anthropic-skills:lovable-builder`
 * skill — we don't reach Lovable's API from TaskPilot. The card's job is
 * to:
 *  - Explain the split (TaskPilot tracks; the skill drives)
 *  - Let the user save a default Lovable project URL so newly-tagged tasks
 *    pre-fill that ref
 *  - Surface every task that currently carries `context.lovable.project_id`
 *    so the user can see what's wired up.
 *
 * No credentials, no OAuth, no token storage. The skill handles Lovable
 * authentication via the browser session the user is already signed into.
 */

import { ExternalLink, Save, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { SettingRow } from '@/renderer/components/shared/SettingRow';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ApiError, api } from '@/renderer/lib/api';
import { useTasksList } from '@/renderer/lib/query';

const LOVABLE_URL_RE = /^https:\/\/(?:[a-z0-9-]+\.)?lovable\.dev\//i;

/* -------------------------------------------------------------------------- */
/*  Small settings hook                                                       */
/* -------------------------------------------------------------------------- */

interface SettingResponse {
  value: string | null;
}

function useStringSetting(
  key: string,
  defaultValue: string,
): {
  value: string;
  save: (next: string) => Promise<void>;
  saving: boolean;
  isLoading: boolean;
} {
  const qc = useQueryClient();
  const { toast } = useToast();

  const settingQ = useQuery({
    queryKey: ['settings', key],
    queryFn: async (): Promise<SettingResponse | null> => {
      try {
        return await api.get<SettingResponse>(
          `/api/settings/${encodeURIComponent(key)}`,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) {
          return { value: null };
        }
        if (cause instanceof ApiError && cause.status === 0) {
          return null;
        }
        throw cause;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (next: string): Promise<void> => {
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next.length === 0 ? null : next,
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], {
        value: next.length === 0 ? null : next,
      });
    },
    onError: (cause) => {
      toast({
        title: 'Couldn’t save setting',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const raw = settingQ.data && 'value' in settingQ.data ? settingQ.data.value : null;
  const value = useMemo(() => (raw === null ? defaultValue : raw), [raw, defaultValue]);

  return {
    value,
    save: async (next: string) => {
      await mutation.mutateAsync(next);
    },
    saving: mutation.isPending,
    isLoading: settingQ.isLoading,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface ContextLovableShape {
  lovable?: {
    project_id?: string;
    url?: string;
  };
}

function extractLovable(
  context: unknown,
): { project_id: string; url: string | null } | null {
  if (!context || typeof context !== 'object') return null;
  const c = context as ContextLovableShape;
  const id = c.lovable?.project_id;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  const url = c.lovable?.url;
  return {
    project_id: id.trim(),
    url: typeof url === 'string' && url.trim().length > 0 ? url.trim() : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export function LovableIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const defaultUrlSetting = useStringSetting(
    'default_lovable_project_url',
    '',
  );
  const [draftUrl, setDraftUrl] = useState(defaultUrlSetting.value);

  useEffect(() => {
    if (!defaultUrlSetting.isLoading) {
      setDraftUrl(defaultUrlSetting.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultUrlSetting.isLoading, defaultUrlSetting.value]);

  const tasksQ = useTasksList({});
  const lovableTasks = useMemo(() => {
    const rows: Array<{
      task_id: string;
      title: string;
      project_id: string;
      url: string | null;
    }> = [];
    for (const task of tasksQ.data?.tasks ?? []) {
      const ref = extractLovable(task.context);
      if (!ref) continue;
      rows.push({
        task_id: task.id,
        title: task.title,
        project_id: ref.project_id,
        url: ref.url,
      });
    }
    return rows;
  }, [tasksQ.data]);

  const handleSaveUrl = async (): Promise<void> => {
    const trimmed = draftUrl.trim();
    if (trimmed.length > 0 && !LOVABLE_URL_RE.test(trimmed)) {
      toast({
        title: 'Invalid Lovable URL',
        description: 'URL must start with https://lovable.dev/…',
        variant: 'destructive',
      });
      return;
    }
    try {
      await defaultUrlSetting.save(trimmed);
      toast({
        title: 'Default Lovable URL saved',
        description:
          trimmed.length === 0 ? 'Cleared.' : 'New tasks can prefill this URL.',
      });
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const dirty = draftUrl.trim() !== defaultUrlSetting.value.trim();

  return (
    <div
      className="mt-3 rounded-md border border-border bg-background/40"
      aria-label="settings-lovable-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Sparkles className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Lovable.dev</div>
          <div className="text-xs text-muted-foreground">
            TaskPilot tracks which Lovable project each task targets; the{' '}
            <code className="rounded bg-muted px-1 text-[10px]">
              lovable-builder
            </code>{' '}
            skill drives the browser when Claude executes.
          </div>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="text-xs text-muted-foreground">
          Attach a Lovable project to a task to mark it as Lovable-targeted.
          When Claude picks up the execute request, the skill instructions
          will route through{' '}
          <code className="rounded bg-muted px-1 text-[10px]">
            anthropic-skills:lovable-builder
          </code>{' '}
          — which drives Chrome to type prompts into Lovable's chat surface.
          TaskPilot doesn't open browsers on its own.
        </div>

        <SettingRow
          label="Default project URL"
          description="Pre-fills when attaching Lovable to a new task. Must be on lovable.dev."
          stacked
        >
          <div className="flex items-stretch gap-2">
            <Input
              type="url"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              className="h-8 flex-1 font-mono text-xs"
              aria-label="settings-lovable-default-url"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://lovable.dev/projects/…"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void handleSaveUrl();
              }}
              disabled={defaultUrlSetting.saving || !dirty}
              aria-label="settings-lovable-save-url"
            >
              <Save className="mr-1 h-4 w-4" />
              {defaultUrlSetting.saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Tasks tracking a Lovable project"
          description="Tasks with context.lovable.project_id set."
          stacked
        >
          {lovableTasks.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No tasks reference a Lovable project yet. Attach one from the
              task detail page.
            </div>
          ) : (
            <ul
              className="flex flex-col gap-1.5"
              aria-label="settings-lovable-task-list"
            >
              {lovableTasks.map((row) => (
                <li
                  key={row.task_id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{row.title}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {row.project_id}
                    </div>
                  </div>
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 shrink-0 text-primary underline"
                    >
                      Open
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SettingRow>
      </div>
    </div>
  );
}
