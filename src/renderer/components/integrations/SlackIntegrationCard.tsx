/**
 * Slack integration card for Settings → Integrations.
 *
 * Same UX shape as `GitHubIntegrationCard`:
 *  - Empty state: bot-token input + Connect button, with help text and the
 *    link to the Slack app creation page.
 *  - Connected state: workspace name + bot id, Disconnect button, "Capture
 *    now" button, and a "Default channel" picker that writes
 *    `default_slack_channel` via the existing settings endpoint.
 *
 * The bot-token input uses `type="password"` and `autoComplete="off"` so
 * password managers don't store it. The token is only ever sent to
 * `/api/slack/connect` — it's never echoed back from the server.
 */

import {
  CheckCircle2,
  ExternalLink,
  MessageSquare,
  PlugZap,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { SettingRow } from '@/renderer/components/shared/SettingRow';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ApiError, api } from '@/renderer/lib/api';
import {
  useConnectSlack,
  useDisconnectSlack,
  useSlackCaptureNow,
  useSlackChannels,
  useSlackStatus,
} from '@/renderer/lib/query';

/* -------------------------------------------------------------------------- */
/*  Small settings hook                                                       */
/* -------------------------------------------------------------------------- */

interface SettingResponse {
  value: string | null;
}

/**
 * Minimal copy of the `useSetting` hook from Settings.tsx, scoped to the
 * keys this card touches. Kept local so the card is a single-file drop-in
 * for Settings.tsx without forcing a refactor of the shared helper.
 */
function useStringSetting(
  key: string,
  defaultValue: string,
): {
  value: string;
  save: (next: string) => Promise<void>;
  saving: boolean;
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
    save: async (next: string): Promise<void> => {
      await mutation.mutateAsync(next);
    },
    saving: mutation.isPending,
  };
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

export function SlackIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const statusQ = useSlackStatus();
  const connectMut = useConnectSlack();
  const disconnectMut = useDisconnectSlack();
  const captureMut = useSlackCaptureNow();
  const connected = Boolean(statusQ.data?.connected);
  const channelsQ = useSlackChannels(connected);

  const defaultChannel = useStringSetting('default_slack_channel', '');

  const [token, setToken] = useState('');

  const handleConnect = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      toast({
        title: 'Paste your bot token first',
        description:
          'Create a Slack app at api.slack.com/apps and paste the bot token (xoxb-…).',
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await connectMut.mutateAsync({ token: trimmed });
      setToken('');
      toast({
        title: 'Slack connected',
        description: res.team.name
          ? `Workspace: ${res.team.name}.`
          : 'Workspace connected.',
      });
    } catch (cause) {
      toast({
        title: 'Connection failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    try {
      await disconnectMut.mutateAsync();
      toast({ title: 'Slack disconnected' });
    } catch (cause) {
      toast({
        title: 'Disconnect failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleTest = async (): Promise<void> => {
    try {
      const res = await statusQ.refetch();
      if (res.data?.connected) {
        toast({
          title: 'Slack connection healthy',
          description: res.data.team?.name
            ? `Workspace: ${res.data.team.name}.`
            : '',
        });
      } else {
        toast({
          title: 'Not connected',
          description: 'The stored token is missing or no longer valid.',
          variant: 'destructive',
        });
      }
    } catch (cause) {
      toast({
        title: 'Connection check failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleCaptureNow = async (): Promise<void> => {
    try {
      const res = await captureMut.mutateAsync();
      if (res.paused) {
        toast({
          title: 'Capture skipped',
          description: 'Agent work is paused. Toggle off "Pause all agent work" first.',
        });
        return;
      }
      if (res.notConfigured) {
        toast({
          title: 'Not connected',
          description: 'Connect Slack first.',
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Slack capture complete',
        description: `${res.created} new task(s), ${res.skipped} skipped.`,
      });
    } catch (cause) {
      toast({
        title: 'Capture failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const team = statusQ.data?.team;
  const channels = channelsQ.data?.channels ?? [];

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background/40"
      aria-label="settings-slack-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <MessageSquare className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Slack</div>
          <div className="text-xs text-muted-foreground">
            {statusQ.isLoading
              ? 'Checking connection…'
              : connected
                ? `Connected${team?.name ? ` to ${team.name}` : ''}.`
                : 'Not connected.'}
          </div>
        </div>
        {connected && team?.domain ? (
          <span className="text-xs text-muted-foreground">
            {team.domain}.slack.com
          </span>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-3">
        {!connected ? (
          <>
            <div className="text-xs text-muted-foreground">
              Create a Slack app at{' '}
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline"
              >
                api.slack.com/apps
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>{' '}
              with these bot scopes:{' '}
              <code className="rounded bg-muted px-1 text-[10px]">stars:read</code>,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">chat:write</code>,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">users:read</code>,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                channels:history
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">groups:history</code>
              , and{' '}
              <code className="rounded bg-muted px-1 text-[10px]">im:history</code>.
              Install the app to your workspace and paste the bot token
              (<code className="rounded bg-muted px-1 text-[10px]">xoxb-…</code>) below.
            </div>

            <div className="flex items-stretch gap-2">
              <Input
                type="password"
                placeholder="xoxb-…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-8 flex-1 font-mono text-xs"
                aria-label="settings-slack-token-input"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleConnect();
                }}
                disabled={connectMut.isPending || token.trim().length === 0}
                aria-label="settings-slack-connect"
              >
                <PlugZap className="mr-1 h-4 w-4" />
                {connectMut.isPending ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleTest();
                }}
                disabled={statusQ.isFetching}
                aria-label="settings-slack-test"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" />
                {statusQ.isFetching ? 'Testing…' : 'Test connection'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleCaptureNow();
                }}
                disabled={captureMut.isPending}
                aria-label="settings-slack-capture-now"
              >
                <RefreshCw className="mr-1 h-4 w-4" />
                {captureMut.isPending ? 'Capturing…' : 'Capture now'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleDisconnect();
                }}
                disabled={disconnectMut.isPending}
                aria-label="settings-slack-disconnect"
              >
                <Unplug className="mr-1 h-4 w-4" />
                {disconnectMut.isPending ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>

            <SettingRow
              label="Default channel for posts"
              description="Used as the default when posting task updates from TaskPilot."
            >
              <Select
                value={defaultChannel.value || 'none'}
                onValueChange={(v) => {
                  void defaultChannel.save(v === 'none' ? '' : v);
                }}
              >
                <SelectTrigger
                  className="w-[260px]"
                  aria-label="settings-slack-default-channel"
                >
                  <SelectValue
                    placeholder={
                      channelsQ.isLoading
                        ? 'Loading channels…'
                        : 'Select a channel'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— none —</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      #{c.name}
                      {c.is_private ? ' (private)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
          </>
        )}
      </div>
    </div>
  );
}

export default SlackIntegrationCard;
