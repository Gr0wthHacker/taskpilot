/**
 * Notion integration card for Settings → Integrations.
 *
 * One-way TaskPilot → Notion mirror. UX shape:
 *  - Empty state: internal-integration token input + Connect button,
 *    with a help link to https://www.notion.so/profile/integrations.
 *  - Connected state: workspace name, Database picker, optional
 *    workspace filter, "Sync now" button, Disconnect.
 *
 * The token input is `type="password"` + `autoComplete="off"` so
 * password managers don't store it. The token is only sent to
 * `/api/notion/connect` — it's never echoed back from the server.
 *
 * Mirrors `SlackIntegrationCard` so the cards feel cohesive.
 */

import {
  CheckCircle2,
  Database,
  ExternalLink,
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
  useConnectNotion,
  useDisconnectNotion,
  useNotionDatabases,
  useNotionStatus,
  useNotionSyncNow,
  useSelectNotionDatabase,
} from '@/renderer/lib/query';

/* -------------------------------------------------------------------------- */
/*  Local settings hook                                                       */
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

  const raw =
    settingQ.data && 'value' in settingQ.data ? settingQ.data.value : null;
  const value = useMemo(
    () => (raw === null ? defaultValue : raw),
    [raw, defaultValue],
  );

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

export function NotionIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const statusQ = useNotionStatus();
  const connectMut = useConnectNotion();
  const disconnectMut = useDisconnectNotion();
  const databasesQ = useNotionDatabases(Boolean(statusQ.data?.connected));
  const selectMut = useSelectNotionDatabase();
  const syncMut = useNotionSyncNow();

  const enabled = useStringSetting('notion_sync_enabled', '');
  const workspaceFilter = useStringSetting('notion_sync_workspace', '');

  const [token, setToken] = useState('');

  const connected = Boolean(statusQ.data?.connected);
  const workspaceName = statusQ.data?.workspace_name ?? '';
  const databaseId = statusQ.data?.database_id ?? '';
  const databases = databasesQ.data?.databases ?? [];

  const isEnabled = enabled.value === 'true' || enabled.value === '1';

  const handleConnect = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      toast({
        title: 'Paste your Notion token first',
        description:
          'Create an internal integration at notion.so/profile/integrations and paste the secret token.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await connectMut.mutateAsync({ token: trimmed });
      setToken('');
      toast({
        title: 'Notion connected',
        description: res.workspace_name
          ? `Workspace: ${res.workspace_name}.`
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
      toast({ title: 'Notion disconnected' });
    } catch (cause) {
      toast({
        title: 'Disconnect failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSelectDatabase = async (id: string): Promise<void> => {
    try {
      await selectMut.mutateAsync({ database_id: id });
      // Flip the mirror on by default the first time the user picks a
      // database — they almost certainly want to start syncing.
      if (!isEnabled) {
        await enabled.save('true');
      }
      toast({ title: 'Database selected' });
    } catch (cause) {
      toast({
        title: 'Couldn’t set database',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSyncNow = async (): Promise<void> => {
    try {
      const res = await syncMut.mutateAsync();
      if (res.notConfigured) {
        toast({
          title: 'Not connected',
          description: 'Connect Notion first.',
          variant: 'destructive',
        });
        return;
      }
      if (res.reason === 'database_not_selected') {
        toast({
          title: 'Pick a database',
          description: 'Select a target database before syncing.',
          variant: 'destructive',
        });
        return;
      }
      if (res.reason === 'notion_sync_disabled') {
        toast({
          title: 'Sync is paused',
          description:
            'Toggle "Mirror tasks to Notion" on to push tasks.',
        });
        return;
      }
      toast({
        title: 'Notion sync complete',
        description: `${res.pushed} pushed, ${res.skipped} skipped${
          res.failed > 0 ? `, ${res.failed} failed` : ''
        }.`,
        variant: res.failed > 0 ? 'destructive' : undefined,
      });
    } catch (cause) {
      toast({
        title: 'Sync failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background/40"
      aria-label="settings-notion-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Database className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Notion</div>
          <div className="text-xs text-muted-foreground">
            {statusQ.isLoading
              ? 'Checking connection…'
              : connected
                ? `Connected${workspaceName ? ` to ${workspaceName}` : ''}.`
                : 'Not connected.'}
          </div>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {!connected ? (
          <>
            <div className="text-xs text-muted-foreground">
              Create an internal integration at{' '}
              <a
                href="https://www.notion.so/profile/integrations"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline"
              >
                notion.so/profile/integrations
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
              , give it access to the database you want to mirror into,
              and paste the secret token below
              (<code className="rounded bg-muted px-1 text-[10px]">secret_…</code> or{' '}
              <code className="rounded bg-muted px-1 text-[10px]">ntn_…</code>).
            </div>

            <div className="flex items-stretch gap-2">
              <Input
                type="password"
                placeholder="secret_… or ntn_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-8 flex-1 font-mono text-xs"
                aria-label="settings-notion-token-input"
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
                aria-label="settings-notion-connect"
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
                  void handleSyncNow();
                }}
                disabled={syncMut.isPending}
                aria-label="settings-notion-sync-now"
              >
                <RefreshCw className="mr-1 h-4 w-4" />
                {syncMut.isPending ? 'Syncing…' : 'Sync now'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleDisconnect();
                }}
                disabled={disconnectMut.isPending}
                aria-label="settings-notion-disconnect"
              >
                <Unplug className="mr-1 h-4 w-4" />
                {disconnectMut.isPending ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>

            <SettingRow
              label="Mirror tasks to Notion"
              description="Push recently-changed tasks into the selected database. One-way."
            >
              <Select
                value={isEnabled ? 'true' : 'false'}
                onValueChange={(v) => {
                  void enabled.save(v === 'true' ? 'true' : '');
                }}
              >
                <SelectTrigger
                  className="w-[160px]"
                  aria-label="settings-notion-enabled"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">Off</SelectItem>
                  <SelectItem value="true">On</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Target database"
              description="Which Notion database receives the mirrored tasks."
            >
              <Select
                value={databaseId || 'none'}
                onValueChange={(v) => {
                  if (v === 'none') return;
                  void handleSelectDatabase(v);
                }}
              >
                <SelectTrigger
                  className="w-[260px]"
                  aria-label="settings-notion-database"
                >
                  <SelectValue
                    placeholder={
                      databasesQ.isLoading
                        ? 'Loading databases…'
                        : 'Select a database'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— none —</SelectItem>
                  {databases.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.title || '(untitled)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Workspace filter (optional)"
              description="Only mirror tasks whose context.workspace matches this value. Leave blank for all."
            >
              <Input
                value={workspaceFilter.value}
                onChange={(e) => {
                  void workspaceFilter.save(e.target.value);
                }}
                className="h-8 w-[260px] text-xs"
                placeholder="e.g. IndexThread"
                aria-label="settings-notion-workspace-filter"
              />
            </SettingRow>

            {connected && databaseId && (
              <div className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                <span>Tasks will sync every 5 minutes.</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default NotionIntegrationCard;
