/**
 * Gmail integration card for Settings → Integrations.
 *
 * Gmail piggybacks on the same Google OAuth2 client that the calendar
 * subsystem uses. Connecting from this card re-requests consent with the
 * UNION of Calendar + Gmail scopes — the user grants both in one go.
 *
 * UX shape:
 *  - Empty state: "Connect Gmail" button → opens browser → poll status.
 *  - Connected state: account email, Disconnect button, capture-now,
 *    capture-query input, and a send-on-behalf toggle (off by default).
 *  - The send toggle, when flipped on, triggers a reconnect with the
 *    additional `gmail.send` scope. Flipping it off both clears the
 *    setting AND tells the user to re-consent on next on.
 */

import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  PlugZap,
  RefreshCw,
  Send,
  Unplug,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  useCompleteGmailConnect,
  useConnectGmail,
  useDisconnectGmail,
  useGmailCaptureNow,
  useGmailStatus,
} from '@/renderer/lib/query';

/* -------------------------------------------------------------------------- */
/*  Shell-bridge probing (mirrors Settings.tsx)                                */
/* -------------------------------------------------------------------------- */

interface MaybeShellBridge {
  openExternal?: (
    url: string,
  ) => Promise<{ ok: boolean; message?: string } | void> | void;
  shell?: {
    openExternal?: (url: string) => Promise<void> | void;
  };
}

function readShellBridge(): MaybeShellBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { taskpilot?: MaybeShellBridge };
  return w.taskpilot;
}

async function openExternal(url: string): Promise<void> {
  const bridge = readShellBridge();
  if (bridge?.openExternal) {
    const result = await bridge.openExternal(url);
    if (result && typeof result === 'object' && 'ok' in result && result.ok) {
      return;
    }
    if (!result) return;
  }
  if (bridge?.shell?.openExternal) {
    await bridge.shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* -------------------------------------------------------------------------- */
/*  Local settings hook (scoped to keys this card touches)                     */
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
  const value = useMemo(
    () => (raw === null ? defaultValue : raw),
    [raw, defaultValue],
  );

  return {
    value,
    save: async (next: string): Promise<void> => {
      await mutation.mutateAsync(next);
    },
  };
}

function useBoolSetting(
  key: string,
  defaultValue: boolean,
): {
  value: boolean;
  save: (next: boolean) => Promise<void>;
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
    mutationFn: async (next: boolean): Promise<void> => {
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next ? 'true' : 'false',
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], {
        value: next ? 'true' : 'false',
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
  const value = useMemo(() => {
    if (raw === null) return defaultValue;
    return raw === 'true' || raw === '1';
  }, [raw, defaultValue]);

  return {
    value,
    save: async (next: boolean): Promise<void> => {
      await mutation.mutateAsync(next);
    },
    saving: mutation.isPending,
  };
}

/* -------------------------------------------------------------------------- */
/*  Card                                                                      */
/* -------------------------------------------------------------------------- */

export function GmailIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const statusQ = useGmailStatus();
  const connectMut = useConnectGmail();
  const completeMut = useCompleteGmailConnect();
  const disconnectMut = useDisconnectGmail();
  const captureMut = useGmailCaptureNow();

  const captureQuery = useStringSetting(
    'gmail_capture_query',
    'is:starred newer_than:7d',
  );
  const sendEnabled = useBoolSetting('gmail_send_enabled', false);

  const connected = Boolean(statusQ.data?.connected);
  const sendReady = Boolean(statusQ.data?.send_enabled);

  // OAuth flow state — mirrors the calendar card.
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'polling'>('idle');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const stopPolling = useCallback((): void => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (expectSendScope: boolean): void => {
      stopPolling();
      setPhase('polling');

      const POLL_MS = 2_000;
      const MAX_MS = 60_000;
      const tick = async (): Promise<void> => {
        try {
          const res = await statusQ.refetch();
          const data = res.data;
          if (data?.connected) {
            // If the user opted into send, wait for the matching scope to
            // actually land before declaring success.
            if (expectSendScope && !data.send_enabled) {
              return;
            }
            stopPolling();
            if (!mountedRef.current) return;
            setPhase('idle');
            setAuthUrl(null);
            setManualCode('');
            toast({
              title: 'Gmail connected',
              description: data.email
                ? `Authenticated as ${data.email}.`
                : 'You can close the browser tab.',
            });
          }
        } catch {
          // poll blip — keep ticking
        }
      };

      pollIntervalRef.current = setInterval(() => {
        void tick();
      }, POLL_MS);
      pollTimeoutRef.current = setTimeout(() => {
        stopPolling();
        if (!mountedRef.current) return;
        setPhase('idle');
        toast({
          title: 'Polling timed out',
          description:
            'Google didn’t redirect back in time. Paste the authorization code below to finish.',
        });
      }, MAX_MS);
    },
    [stopPolling, statusQ, toast],
  );

  const handleConnect = async (includeSend: boolean): Promise<void> => {
    setPhase('connecting');
    try {
      const res = await connectMut.mutateAsync({ include_send: includeSend });
      if (res.auth_url) {
        setAuthUrl(res.auth_url);
        await openExternal(res.auth_url);
        startPolling(includeSend);
      } else {
        setPhase('idle');
        toast({
          title: 'Auth flow started',
          description: 'No URL returned. Check the server logs.',
        });
      }
    } catch (cause) {
      setPhase('idle');
      toast({
        title: 'Couldn’t start Gmail auth',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleSubmitCode = async (): Promise<void> => {
    const code = manualCode.trim();
    if (code.length === 0) return;
    try {
      await completeMut.mutateAsync({ code });
      stopPolling();
      setPhase('idle');
      setAuthUrl(null);
      setManualCode('');
      toast({ title: 'Gmail connected' });
      await statusQ.refetch();
    } catch (cause) {
      toast({
        title: 'Code rejected',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    try {
      await disconnectMut.mutateAsync();
      toast({ title: 'Gmail disconnected' });
    } catch (cause) {
      toast({
        title: 'Disconnect failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleCaptureNow = async (): Promise<void> => {
    try {
      const res = await captureMut.mutateAsync();
      toast({
        title: 'Gmail capture complete',
        description: `${res.imported} new task(s), ${res.skipped} skipped.`,
      });
    } catch (cause) {
      toast({
        title: 'Capture failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleToggleSend = async (next: boolean): Promise<void> => {
    await sendEnabled.save(next);
    if (next && !sendReady) {
      // Newly opted in — kick off a fresh consent flow that requests the
      // additional `gmail.send` scope so the server can actually send.
      toast({
        title: 'Reconnect to grant send access',
        description: 'Opening Google so you can grant the gmail.send scope.',
      });
      await handleConnect(true);
    }
  };

  const email = statusQ.data?.email;
  const scopes = statusQ.data?.scopes_granted ?? [];

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background/40"
      aria-label="settings-gmail-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Mail className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Gmail</div>
          <div className="text-xs text-muted-foreground">
            {statusQ.isLoading
              ? 'Checking connection…'
              : connected
                ? `Connected${email ? ` as ${email}` : ''}.`
                : 'Not connected.'}
          </div>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {!connected ? (
          <>
            <div className="text-xs text-muted-foreground">
              Gmail uses the same Google OAuth client as Calendar. Connecting
              here re-grants consent with{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                gmail.readonly
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                gmail.compose
              </code>
              , and{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                gmail.labels
              </code>{' '}
              in addition to your existing Calendar scopes. Send-on-behalf
              (
              <code className="rounded bg-muted px-1 text-[10px]">
                gmail.send
              </code>
              ) is off by default — flip the toggle below to opt in.
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleConnect(sendEnabled.value);
                }}
                disabled={phase !== 'idle'}
                aria-label="settings-gmail-connect"
              >
                <PlugZap className="mr-1 h-4 w-4" />
                {phase === 'connecting'
                  ? 'Starting…'
                  : phase === 'polling'
                    ? 'Waiting…'
                    : 'Connect Gmail'}
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
                  void statusQ.refetch();
                }}
                disabled={statusQ.isFetching}
                aria-label="settings-gmail-test"
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
                aria-label="settings-gmail-capture-now"
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
                aria-label="settings-gmail-disconnect"
              >
                <Unplug className="mr-1 h-4 w-4" />
                {disconnectMut.isPending ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>

            {scopes.length > 0 && (
              <div
                className="text-[10px] uppercase tracking-wide text-muted-foreground"
                aria-label="settings-gmail-scopes"
              >
                Scopes granted: {scopes.map((s) => s.split('/').pop()).join(', ')}
              </div>
            )}
          </>
        )}

        {authUrl && (
          <div
            role="region"
            className="my-2 space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
            aria-label="settings-gmail-auth-panel"
          >
            <div
              className="flex items-center gap-2 text-muted-foreground"
              aria-live="polite"
            >
              {phase === 'polling' ? (
                <>
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  <span>Waiting for Google… or paste your code manually.</span>
                </>
              ) : (
                <span>Auth flow ready.</span>
              )}
            </div>
            <div>
              <div className="mb-1 text-muted-foreground">
                If the browser didn’t open, use this URL:
              </div>
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 break-all text-primary underline"
              >
                {authUrl}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            </div>
            <div className="flex items-stretch gap-2 pt-1">
              <Input
                type="text"
                placeholder="Paste authorization code"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                className="h-8 flex-1 text-xs"
                aria-label="settings-gmail-manual-code"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleSubmitCode();
                }}
                disabled={
                  completeMut.isPending || manualCode.trim().length === 0
                }
                aria-label="settings-gmail-submit-code"
              >
                {completeMut.isPending ? 'Submitting…' : 'Submit code'}
              </Button>
            </div>
          </div>
        )}

        <SettingRow
          label="Enable send"
          description="When on, Claude can send emails on your behalf after you click Send."
        >
          <button
            type="button"
            role="switch"
            aria-checked={sendEnabled.value}
            aria-label="settings-gmail-send-toggle"
            disabled={sendEnabled.saving}
            onClick={() => {
              void handleToggleSend(!sendEnabled.value);
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
              sendEnabled.value ? 'bg-primary' : 'bg-input'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition-transform ${
                sendEnabled.value ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SettingRow>

        {sendEnabled.value && !sendReady && connected && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100">
            <Send className="mr-1 inline h-3.5 w-3.5" />
            Send is toggled on but the <code>gmail.send</code> scope isn’t
            granted yet. Click Connect Gmail again to re-consent with the
            wider scope set.
          </div>
        )}

        <SettingRow
          label="Capture query"
          description="Gmail search query for incoming messages. Defaults to is:starred newer_than:7d."
        >
          <Input
            type="text"
            className="h-8 w-[260px] text-xs"
            value={captureQuery.value}
            onChange={(e) => {
              void captureQuery.save(e.target.value);
            }}
            aria-label="settings-gmail-capture-query"
            autoComplete="off"
            spellCheck={false}
          />
        </SettingRow>
      </div>
    </div>
  );
}

export default GmailIntegrationCard;
