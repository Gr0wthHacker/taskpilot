/**
 * Reddit integration card for Settings → Integrations.
 *
 * Reddit's public JSON API doesn't need auth for reads, so there's nothing
 * to "connect". This card surfaces:
 *  - The current User-Agent (editable; default `taskpilot/0.1.0 (by
 *    /u/Gr0wthHacker)`). Reddit cares about who's hitting them; a unique
 *    UA lets them rate-limit politely instead of blanket-blocking.
 *  - The distinct subreddits surfaced by existing tasks
 *    (`task.context.reddit.subreddit`) so the user can see what's wired up.
 *
 * The card never collects or stores OAuth credentials — posting / voting
 * isn't supported by this integration. Content creation runs through the
 * `reddit-content-crafter` skill which drives the browser, not us.
 */

import { ExternalLink, MessageCircle, Save } from 'lucide-react';
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

const DEFAULT_USER_AGENT = 'taskpilot/0.1.0 (by /u/Gr0wthHacker)';

/* -------------------------------------------------------------------------- */
/*  Small settings hook (local copy — see SlackIntegrationCard for rationale) */
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
/*  Distinct subreddits across tasks                                          */
/* -------------------------------------------------------------------------- */

interface ContextRedditShape {
  reddit?: {
    subreddit?: string;
  };
}

function extractSubreddit(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const c = context as ContextRedditShape;
  const sub = c.reddit?.subreddit;
  if (typeof sub !== 'string' || sub.trim().length === 0) return null;
  // Normalize: strip `r/`, `/r/`, lowercase. Same logic as
  // `normalizeSubreddit` in src/main/reddit/index.ts.
  let s = sub.trim();
  if (s.startsWith('/')) s = s.slice(1);
  if (s.toLowerCase().startsWith('r/')) s = s.slice(2);
  return s;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export function RedditIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const userAgentSetting = useStringSetting(
    'reddit_user_agent',
    DEFAULT_USER_AGENT,
  );
  const [draftUserAgent, setDraftUserAgent] = useState(userAgentSetting.value);

  // Reconcile the local draft when the persisted value loads.
  useEffect(() => {
    if (!userAgentSetting.isLoading) {
      setDraftUserAgent(userAgentSetting.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userAgentSetting.isLoading, userAgentSetting.value]);

  const tasksQ = useTasksList({});
  const recentSubreddits = useMemo(() => {
    const seen = new Set<string>();
    for (const task of tasksQ.data?.tasks ?? []) {
      const sub = extractSubreddit(task.context);
      if (sub) seen.add(sub);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [tasksQ.data]);

  const handleSaveUserAgent = async (): Promise<void> => {
    const trimmed = draftUserAgent.trim();
    if (trimmed.length === 0) {
      toast({
        title: 'User-Agent cannot be empty',
        description:
          'Reddit politely demands a unique UA. Use the default if you’re not sure.',
        variant: 'destructive',
      });
      setDraftUserAgent(DEFAULT_USER_AGENT);
      return;
    }
    try {
      await userAgentSetting.save(trimmed);
      toast({ title: 'Reddit User-Agent saved' });
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleResetUserAgent = (): void => {
    setDraftUserAgent(DEFAULT_USER_AGENT);
  };

  return (
    <div
      className="mt-3 rounded-md border border-border bg-background/40"
      aria-label="settings-reddit-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <MessageCircle className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Reddit</div>
          <div className="text-xs text-muted-foreground">
            Read-only access to Reddit's public JSON API. No login needed.
          </div>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="text-xs text-muted-foreground">
          Reddit asks every client for a unique User-Agent so they can rate-limit
          politely. The default is fine for most use cases. Posting and voting
          are handled by the{' '}
          <code className="rounded bg-muted px-1 text-[10px]">
            reddit-content-crafter
          </code>{' '}
          skill — this integration only reads.
        </div>

        <SettingRow
          label="User-Agent"
          description="Sent on every Reddit request. Use the default unless Reddit rate-limits you."
          stacked
        >
          <div className="flex items-stretch gap-2">
            <Input
              type="text"
              value={draftUserAgent}
              onChange={(e) => setDraftUserAgent(e.target.value)}
              className="h-8 flex-1 font-mono text-xs"
              aria-label="settings-reddit-user-agent"
              spellCheck={false}
              autoComplete="off"
              placeholder={DEFAULT_USER_AGENT}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void handleSaveUserAgent();
              }}
              disabled={
                userAgentSetting.saving ||
                draftUserAgent.trim() === userAgentSetting.value
              }
              aria-label="settings-reddit-save-ua"
            >
              <Save className="mr-1 h-4 w-4" />
              {userAgentSetting.saving ? 'Saving…' : 'Save'}
            </Button>
            {draftUserAgent !== DEFAULT_USER_AGENT && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleResetUserAgent}
                aria-label="settings-reddit-reset-ua"
              >
                Reset
              </Button>
            )}
          </div>
        </SettingRow>

        <SettingRow
          label="Recent subreddits"
          description="Subreddits referenced by your current tasks (context.reddit.subreddit)."
          stacked
        >
          {recentSubreddits.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              No tasks reference a subreddit yet. Tag a task with{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                context.reddit.subreddit
              </code>{' '}
              to wire it up.
            </div>
          ) : (
            <ul
              className="flex flex-wrap gap-1.5"
              aria-label="settings-reddit-recent-subreddits"
            >
              {recentSubreddits.map((sub) => (
                <li key={sub}>
                  <a
                    href={`https://reddit.com/r/${sub}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs hover:bg-muted"
                  >
                    r/{sub}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </SettingRow>
      </div>
    </div>
  );
}
