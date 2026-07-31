/**
 * Settings — tabbed surface: General / Calendar / Agent / Advanced.
 *
 * Settings are read/written via a generic key-value endpoint:
 *  - GET    /api/settings/:key   → { value: string | null }
 *  - PATCH  /api/settings/:key   body { value: string | null }
 *
 * These routes are NOT yet implemented in Wave 2E — Wave 3K is expected to
 * wire them up against the existing settingsRepo. Until then the hooks
 * gracefully degrade: load returns null/default, save surfaces a toast on
 * 404 without crashing the UI.
 *
 * Calendar OAuth path:
 *  - POST /api/calendar/auth/start  → { auth_url: string }
 *  - POST /api/calendar/auth/disconnect
 *  - Calendar-connection status is inferred from a probe call to
 *    /api/calendar/events with from=to=now() — a 'calendar_not_initialized'
 *    error means disconnected.
 *
 * Theme persistence: the Zustand `ui` store carries the current theme; the
 * General tab also toggles a `dark` class on `<html>` to take effect
 * immediately. The persisted theme value is mirrored to the settings store
 * so the main process / future restarts can read it.
 */

import { format } from 'date-fns';
import {
  CalendarCheck2,
  CheckCircle2,
  ClipboardCopy,
  Cog,
  Download,
  ExternalLink,
  FolderOpen,
  Github,
  Info,
  Loader2,
  PauseCircle,
  PlugZap,
  RefreshCw,
  Unplug,
  Upload,
  Wand2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import About from '@/renderer/views/About';
import { WorkspacesEditor } from '@/renderer/components/Workspaces/WorkspacesEditor';
import { PhasesEditor } from '@/renderer/views/Settings/PhasesEditor';
import { SlackIntegrationCard } from '@/renderer/components/integrations/SlackIntegrationCard';
import { WebhooksEditor } from '@/renderer/components/WebhooksEditor';
import { GmailIntegrationCard } from '@/renderer/components/integrations/GmailIntegrationCard';
import { NotionIntegrationCard } from '@/renderer/components/integrations/NotionIntegrationCard';
import { RedditIntegrationCard } from '@/renderer/components/integrations/RedditIntegrationCard';
import { LovableIntegrationCard } from '@/renderer/components/integrations/LovableIntegrationCard';
import { BackupCard } from '@/renderer/components/integrations/BackupCard';
import { TelemetryCard } from '@/renderer/components/integrations/TelemetryCard';
import { SettingRow } from '@/renderer/components/shared/SettingRow';
import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/renderer/components/ui/tabs';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ApiError, api, getErrorCode, resolveApiToken } from '@/renderer/lib/api';
import {
  getRecentApiEvents,
  useAutoLaunch,
  useConnectGitHub,
  useDisconnectGitHub,
  useExportData,
  useGitHubRepos,
  useGitHubStatus,
  useImportData,
  usePermissionProfiles,
  useSetAutoLaunch,
} from '@/renderer/lib/query';
import { useConfig } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import { useUiStore, type ThemePreference } from '@/renderer/store/ui';
import type { DataImportBody } from '@/shared/api-contract';
import type {
  AgentMethod,
  PermissionProfileName,
  TaskPriority,
} from '@/shared/types';

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

/* -------------------------------------------------------------------------- */
/*  Setting hooks (local — Wave 3K will reconcile against real endpoints)     */
/* -------------------------------------------------------------------------- */

interface SettingResponse {
  value: string | null;
}

interface SettingsHookOptions<T> {
  defaultValue: T;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string | null;
}

function useSetting<T>(
  key: string,
  options: SettingsHookOptions<T>,
): {
  value: T;
  isLoading: boolean;
  isMissing: boolean;
  save: (next: T) => Promise<void>;
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
          // Network/server not available — surface null so UI still renders
          // with defaults rather than crashing.
          return null;
        }
        throw cause;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (next: T): Promise<void> => {
      const serialized = options.serialize(next);
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: serialized,
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], {
        value: options.serialize(next),
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
  const value = useMemo(() => options.parse(raw), [raw, options]);

  return {
    value,
    isLoading: settingQ.isLoading,
    isMissing: settingQ.isError,
    save: async (next: T) => {
      await mutation.mutateAsync(next);
    },
    saving: mutation.isPending,
  };
}

const stringSetting = (defaultValue: string): SettingsHookOptions<string> => ({
  defaultValue,
  parse: (raw) => (raw === null ? defaultValue : raw),
  serialize: (value) => value,
});

const boolSetting = (defaultValue: boolean): SettingsHookOptions<boolean> => ({
  defaultValue,
  parse: (raw) => {
    if (raw === null) return defaultValue;
    return raw === 'true' || raw === '1';
  },
  serialize: (value) => (value ? 'true' : 'false'),
});

/**
 * Numeric setting with min/max clamping. The serialized form is a JSON
 * number string so the settings repo round-trips it cleanly.
 */
const numberSetting = (
  defaultValue: number,
  min = 0,
  max = 1,
): SettingsHookOptions<number> => ({
  defaultValue,
  parse: (raw) => {
    if (raw === null) return defaultValue;
    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
    if (!Number.isFinite(parsed)) return defaultValue;
    if (parsed < min) return min;
    if (parsed > max) return max;
    return parsed;
  },
  serialize: (value) => {
    if (!Number.isFinite(value)) return String(defaultValue);
    const clamped = Math.min(max, Math.max(min, value));
    return String(clamped);
  },
});

/* -------------------------------------------------------------------------- */
/*  Calendar status probe                                                     */
/* -------------------------------------------------------------------------- */

interface CalendarStatus {
  connected: boolean;
  email: string | null;
}

function useCalendarStatus(): {
  status: CalendarStatus | null;
  loading: boolean;
  refresh: () => void;
} {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['calendar', 'status'],
    queryFn: async (): Promise<CalendarStatus> => {
      // Prefer a real status endpoint if/when it exists.
      try {
        const res = await api.get<{ connected: boolean; email?: string | null }>(
          '/api/calendar/status',
        );
        return {
          connected: Boolean(res.connected),
          email: res.email ?? null,
        };
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) {
          // Fallback: probe the events endpoint with a tiny range.
          const now = new Date().toISOString();
          try {
            await api.get('/api/calendar/events', { from: now, to: now });
            return { connected: true, email: null };
          } catch (probeCause) {
            if (probeCause instanceof ApiError) {
              if (getErrorCode(probeCause.body) === 'calendar_not_initialized') {
                return { connected: false, email: null };
              }
            }
            return { connected: false, email: null };
          }
        }
        throw cause;
      }
    },
    staleTime: 30_000,
    retry: false,
  });

  return {
    status: q.data ?? null,
    loading: q.isLoading,
    refresh: () => {
      void qc.invalidateQueries({ queryKey: ['calendar', 'status'] });
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const PRIORITIES: TaskPriority[] = ['p0', 'p1', 'p2', 'p3'];
const METHODS: AgentMethod[] = ['cowork', 'cli', 'either', 'human_only'];
const THEMES: ThemePreference[] = ['light', 'dark', 'system'];

function applyThemeToDom(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const wantsDark =
    theme === 'dark' ||
    (theme === 'system' &&
      Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  root.classList.toggle('dark', wantsDark);
}

/**
 * `window.taskpilot` started out exposing only a few APIs. Other waves are
 * still landing top-level methods (`openExternal`) and legacy `shell.openExternal`
 * may also exist depending on what's been merged. We probe both shapes so the
 * Settings view doesn't need to know which one wins.
 */
interface MaybeShellBridge {
  openExternal?: (url: string) => Promise<{ ok: boolean; message?: string } | void> | void;
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
    if (!result) return; // legacy void return
  }
  if (bridge?.shell?.openExternal) {
    await bridge.shell.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function Settings(): JSX.Element {
  const { toast } = useToast();
  const configQ = useConfig();
  const qc = useQueryClient();

  /* --- General tab state --- */
  const storeTheme = useUiStore((s) => s.theme);
  const setStoreTheme = (next: ThemePreference): void => {
    useUiStore.setState((s) => ({ ...s, theme: next }));
  };

  const themeSetting = useSetting<ThemePreference>('theme', {
    defaultValue: storeTheme,
    parse: (raw) =>
      raw === 'light' || raw === 'dark' || raw === 'system' ? raw : storeTheme,
    serialize: (v) => v,
  });

  // Sync persisted theme → store on first load.
  useEffect(() => {
    if (!themeSetting.isLoading) {
      setStoreTheme(themeSetting.value);
      applyThemeToDom(themeSetting.value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeSetting.isLoading]);

  const defaultPriority = useSetting<TaskPriority>('default_priority', {
    defaultValue: 'p2',
    parse: (raw) =>
      raw === 'p0' || raw === 'p1' || raw === 'p2' || raw === 'p3'
        ? raw
        : 'p2',
    serialize: (v) => v,
  });

  const defaultAgentMethod = useSetting<AgentMethod>('default_agent_method', {
    defaultValue: 'human_only',
    parse: (raw) =>
      raw === 'cowork' || raw === 'cli' || raw === 'either' || raw === 'human_only'
        ? raw
        : 'human_only',
    serialize: (v) => v,
  });

  /**
   * Quick-capture hotkey. Read-only in v1 — the Settings → General row shows
   * the current accelerator and points the user at `keybindings.json` to
   * rebind. The main process listens on whichever combo is persisted under
   * `quick_capture_hotkey` (defaulting to `CommandOrControl+Shift+Space`).
   */
  const quickCaptureHotkey = useSetting<string>('quick_capture_hotkey', {
    defaultValue: 'CommandOrControl+Shift+Space',
    parse: (raw) =>
      raw && raw.trim().length > 0
        ? raw.trim()
        : 'CommandOrControl+Shift+Space',
    serialize: (v) => v,
  });

  /* --- Calendar tab state --- */
  const calendar = useCalendarStatus();
  const agentHoursStart = useSetting<string>(
    'agent_hours_start',
    stringSetting('09:00'),
  );
  const agentHoursEnd = useSetting<string>(
    'agent_hours_end',
    stringSetting('17:00'),
  );
  const runOnWeekends = useSetting<boolean>(
    'run_on_weekends',
    boolSetting(false),
  );
  const calendarToTaskImport = useSetting<boolean>(
    'calendar_to_task_import',
    boolSetting(false),
  );

  /**
   * OAuth UI state.
   *
   * Lifecycle:
   *   idle → connecting → polling ⇄ (success | cancelled | timeout)
   *
   * The "polling" phase is what makes the local-callback flow feel automatic:
   * once the user clicks Connect we open the consent URL in their browser and
   * then poll `/api/calendar/status` until either:
   *   - the callback fires (status flips to connected) → success toast +
   *     calendar.refresh
   *   - the user pastes a code manually and submits → success via
   *     `/api/calendar/auth/complete`
   *   - they hit Cancel
   *   - the timeout elapses (we surface a hint about the manual fallback)
   */
  type AuthPhase = 'idle' | 'connecting' | 'polling';

  const [connecting, setConnecting] = useState(false);
  const [authPhase, setAuthPhase] = useState<AuthPhase>('idle');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [submittingCode, setSubmittingCode] = useState(false);

  // Refs so the cleanup helper can clear timers without re-rendering.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
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

  /**
   * Poll the local status endpoint every 2s. Bails on success (which usually
   * means the local /oauth/callback route exchanged the code) or after the
   * 60s budget elapses.
   */
  const startPolling = useCallback((): void => {
    stopPolling();
    setAuthPhase('polling');

    const POLL_MS = 2000;
    const MAX_MS = 60_000;

    const tick = async (): Promise<void> => {
      try {
        const res = await api.get<{ connected: boolean; email?: string | null }>(
          '/api/calendar/status',
        );
        if (res.connected) {
          stopPolling();
          if (!isMountedRef.current) return;
          setAuthPhase('idle');
          setAuthUrl(null);
          setManualCode('');
          toast({
            title: 'Connected to Google Calendar',
            description: res.email
              ? `Authenticated as ${res.email}.`
              : 'You can close the browser tab.',
          });
          calendar.refresh();
        }
      } catch {
        // Network blips during polling are non-fatal — keep ticking.
      }
    };

    pollIntervalRef.current = setInterval(() => {
      void tick();
    }, POLL_MS);

    pollTimeoutRef.current = setTimeout(() => {
      stopPolling();
      if (!isMountedRef.current) return;
      // Move the OAuth state machine back to idle so the Connect button isn't
      // stuck on "Waiting…" forever. The auth panel (and manual code field)
      // stay rendered as long as `authUrl` is set, so the user can still
      // paste their code if they're mid-consent.
      setAuthPhase('idle');
      toast({
        title: 'Polling timed out',
        description:
          'Google didn’t redirect back in time. Paste the authorization code below to finish connecting.',
      });
    }, MAX_MS);
  }, [calendar, stopPolling, toast]);

  const cancelConnect = (): void => {
    stopPolling();
    setAuthPhase('idle');
    setAuthUrl(null);
    setManualCode('');
  };

  const connectCalendar = async (): Promise<void> => {
    setConnecting(true);
    setAuthPhase('connecting');
    try {
      const res = await api.post<{ auth_url: string }>(
        '/api/calendar/auth/start',
      );
      if (res.auth_url) {
        setAuthUrl(res.auth_url);
        await openExternal(res.auth_url);
        startPolling();
      } else {
        setAuthPhase('idle');
        toast({
          title: 'Auth flow started',
          description: 'No URL returned. Check the server logs.',
        });
      }
    } catch (cause) {
      setAuthPhase('idle');
      toast({
        title: 'Couldn’t start auth flow',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setConnecting(false);
    }
  };

  const submitManualCode = async (): Promise<void> => {
    const code = manualCode.trim();
    if (code.length === 0) {
      toast({
        title: 'Paste a code first',
        description: 'Copy the authorization code from Google and paste it here.',
        variant: 'destructive',
      });
      return;
    }
    setSubmittingCode(true);
    try {
      await api.post('/api/calendar/auth/complete', { code });
      stopPolling();
      setAuthPhase('idle');
      setAuthUrl(null);
      setManualCode('');
      toast({ title: 'Connected to Google Calendar' });
      calendar.refresh();
    } catch (cause) {
      // The OAuth module treats "code already used + already authenticated"
      // as success on the server; if we still got an error it's a real one.
      const message = cause instanceof Error ? cause.message : 'Unknown error';
      toast({
        title: 'Code rejected',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSubmittingCode(false);
    }
  };

  const disconnectCalendar = async (): Promise<void> => {
    try {
      await api.post('/api/calendar/auth/disconnect');
      toast({ title: 'Calendar disconnected' });
      calendar.refresh();
    } catch (cause) {
      toast({
        title: 'Disconnect failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  /* --- Agent tab state --- */
  const autoExecuteApproved = useSetting<boolean>(
    'auto_execute_approved',
    boolSetting(false),
  );
  const pauseAllAgents = useSetting<boolean>(
    'pause_all_agents',
    boolSetting(false),
  );
  const coworkPreferred = useSetting<boolean>(
    'cowork_preferred',
    boolSetting(true),
  );
  // Wave 13: confidence gate. Default 0.7 mirrors
  // `@/main/confidence#DEFAULT_CONFIDENCE_THRESHOLD`.
  const confidenceThreshold = useSetting<number>(
    'confidence_threshold',
    numberSetting(0.7, 0, 1),
  );

  // Auto-runner — spawns a configured CLI on an interval to drain the
  // execute queue. See @/main/claude-runner. Default off because spawning
  // a subprocess is an opt-in cost.
  const runnerEnabled = useSetting<boolean>(
    'claude_runner_enabled',
    boolSetting(false),
  );
  // Default command is platform-specific; the server picks the same fallback
  // when this setting is empty (claude / claude.cmd).
  const runnerCommand = useSetting<string>(
    'claude_runner_command',
    stringSetting(''),
  );
  const runnerIntervalMs = useSetting<number>(
    'claude_runner_interval_ms',
    numberSetting(60_000, 5_000, 60 * 60_000),
  );

  /* --- Ambient monitor (v6) ---
   *
   * Master toggle gates the active-window poller; the screenshot toggle is
   * subordinate and reads "disabled when monitor off" in the UI. The
   * interrupt threshold rides on the existing `ambient_context_shift_threshold`
   * key (the monitor reads it on every tick), exposed on a 0–10 scale here
   * for readability and stored as the 0–1 value the monitor expects.
   */
  const ambientMonitorEnabled = useSetting<boolean>(
    'ambient_monitor_enabled',
    boolSetting(false),
  );
  const ambientScreenshotEnabled = useSetting<boolean>(
    'ambient_screenshot_enabled',
    boolSetting(false),
  );
  const ambientInterruptThreshold = useSetting<number>(
    'ambient_context_shift_threshold',
    numberSetting(0.4, 0, 1),
  );

  /* --- Advanced state --- */
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  /* --- Auto-launch (General tab) --- */
  const autoLaunchQ = useAutoLaunch();
  const setAutoLaunchMut = useSetAutoLaunch();
  // Mirror the server-fetched value into local state so the toggle stays
  // responsive while the mutation flies. Reconciles on every successful
  // fetch via the effect below.
  const [autoLaunchEnabled, setAutoLaunchEnabled] = useState(false);
  useEffect(() => {
    if (autoLaunchQ.data?.enabled !== undefined) {
      setAutoLaunchEnabled(autoLaunchQ.data.enabled);
    }
  }, [autoLaunchQ.data?.enabled]);
  const autoLaunchSaving = setAutoLaunchMut.isPending;
  const handleAutoLaunchToggle = async (next: boolean): Promise<void> => {
    setAutoLaunchEnabled(next);
    try {
      const res = await setAutoLaunchMut.mutateAsync({ enabled: next });
      setAutoLaunchEnabled(res.enabled);
    } catch (cause) {
      // Roll back the optimistic flip on failure.
      setAutoLaunchEnabled(!next);
      toast({
        title: 'Couldn’t update auto-launch',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  /* --- Export / import (Advanced tab) --- */
  const exportMut = useExportData();
  const importMut = useImportData();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const handleExportData = async (): Promise<void> => {
    try {
      const { payload, filename } = await exportMut.mutateAsync();
      // Convert to Blob and trigger an in-page download. Doing this here
      // (rather than relying on the server's `Content-Disposition`) means
      // we can show a toast on completion and stay on the Settings page.
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revoke async so the click definitely consumed the URL first.
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      toast({
        title: 'Export ready',
        description: `${payload.tasks.length} task(s) and ${payload.execution_logs.length} log(s) saved to ${filename}.`,
      });
    } catch (cause) {
      toast({
        title: 'Export failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };
  const handleImportFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.target.files?.[0];
    // Reset the input value so picking the same file twice still fires onChange.
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let parsed: DataImportBody;
      try {
        parsed = JSON.parse(text) as DataImportBody;
      } catch {
        toast({
          title: 'Import failed',
          description: 'File is not valid JSON.',
          variant: 'destructive',
        });
        return;
      }
      const summary = await importMut.mutateAsync({ body: parsed });
      const parts = [
        `${summary.tasks_imported} task(s)`,
        `${summary.logs_imported} log(s)`,
        `${summary.settings_imported} setting(s)`,
        ...(summary.templates_imported > 0
          ? [`${summary.templates_imported} template(s)`]
          : []),
      ];
      toast({
        title: 'Import complete',
        description:
          `${parts.join(', ')} imported.` +
          (summary.conflicts > 0
            ? ` ${summary.conflicts} conflict(s) skipped.`
            : ''),
      });
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : 'Unknown error';
      // Surface the specific server error code when possible — the most
      // common one is `unsupported_version`.
      toast({
        title: 'Import failed',
        description: message,
        variant: 'destructive',
      });
    }
  };

  const config = configQ.data;
  const ioRoot = config?.paths.io.root ?? '—';
  const dbPath = config?.paths.db ?? '—';
  const homePath = config?.paths.home ?? '—';

  const runResetIo = async (): Promise<void> => {
    setResetting(true);
    try {
      await api.post('/api/io/ingest');
      toast({
        title: 'I/O pipeline rescanned',
        description: 'Watcher reissued ingest pass.',
      });
      void qc.invalidateQueries({ queryKey: ['io'] });
    } catch (cause) {
      toast({
        title: 'Reset failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setResetting(false);
      setResetOpen(false);
    }
  };

  const openIoFolder = async (): Promise<void> => {
    const folder = config?.paths.io.root;
    if (!folder) {
      toast({
        title: 'No I/O folder yet',
        description: 'Config not loaded.',
        variant: 'destructive',
      });
      return;
    }
    const bridge = window.taskpilot;
    if (bridge?.openIoFolder) {
      const result = await bridge.openIoFolder();
      if (!result.ok) {
        toast({
          title: 'Could not open folder',
          description: result.message ?? 'Bridge call failed.',
          variant: 'destructive',
        });
      }
      return;
    }
    // Fallback for non-Electron contexts.
    await openExternal(`file://${folder}`);
  };

  const handleExportDb = (): void => {
    toast({
      title: 'Database path',
      description: dbPath,
    });
  };

  const copyDiagnosticInfo = async (): Promise<void> => {
    const platform =
      typeof navigator !== 'undefined' && navigator.platform
        ? navigator.platform
        : 'unknown';
    const userAgent =
      typeof navigator !== 'undefined' && navigator.userAgent
        ? navigator.userAgent
        : 'unknown';
    const events = getRecentApiEvents().slice(0, 50);
    const lines: string[] = [
      `TaskPilot ${config?.version ?? 'unknown'}`,
      `Platform: ${platform}`,
      `User agent: ${userAgent}`,
      `Home: ${homePath}`,
      `DB: ${dbPath}`,
      `IO root: ${ioRoot}`,
      '',
      `Recent server events (${events.length}):`,
      ...(events.length === 0
        ? ['  (none captured this session)']
        : events.map(
            (e) =>
              `  ${e.at}  ${e.kind}${e.task_id ? `  task=${e.task_id}` : ''}${
                e.parent_id ? `  parent=${e.parent_id}` : ''
              }`,
          )),
    ];
    const payload = lines.join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      toast({
        title: 'Diagnostic info copied',
        description: `${events.length} event(s) included.`,
      });
    } catch (cause) {
      toast({
        title: 'Copy failed',
        description: cause instanceof Error ? cause.message : 'Clipboard unavailable.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-settings">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-xs text-muted-foreground">
            Configure TaskPilot. Changes save immediately.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          v{config?.version ?? '…'}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <Tabs defaultValue="general" className="max-w-3xl">
          <TabsList aria-label="settings-tabs">
            <TabsTrigger value="general" aria-label="settings-tab-general">
              General
            </TabsTrigger>
            <TabsTrigger value="workspaces" aria-label="settings-tab-workspaces">
              Workspaces
            </TabsTrigger>
            <TabsTrigger value="phases" aria-label="settings-tab-phases">
              Phases
            </TabsTrigger>
            <TabsTrigger value="calendar" aria-label="settings-tab-calendar">
              Calendar
            </TabsTrigger>
            <TabsTrigger value="agent" aria-label="settings-tab-agent">
              Agent
            </TabsTrigger>
            <TabsTrigger value="ambient" aria-label="settings-tab-ambient">
              Ambient
            </TabsTrigger>
            <TabsTrigger
              value="integrations"
              aria-label="settings-tab-integrations"
            >
              Integrations
            </TabsTrigger>
            <TabsTrigger
              value="permissions"
              aria-label="settings-tab-permissions"
            >
              Permissions
            </TabsTrigger>
            <TabsTrigger value="advanced" aria-label="settings-tab-advanced">
              Advanced
            </TabsTrigger>
            <TabsTrigger value="about" aria-label="settings-tab-about">
              About
            </TabsTrigger>
          </TabsList>

          {/* ------------- General ------------- */}
          <TabsContent value="general" className="mt-4">
            <SettingRow
              label="Theme"
              description="Light, dark, or follow your OS."
            >
              <Select
                value={themeSetting.value}
                onValueChange={(v) => {
                  const next = v as ThemePreference;
                  setStoreTheme(next);
                  applyThemeToDom(next);
                  void themeSetting.save(next);
                }}
              >
                <SelectTrigger
                  className="w-[140px]"
                  aria-label="settings-theme"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THEMES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t[0].toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Default priority"
              description="Applied to new tasks when no priority is set."
            >
              <Select
                value={defaultPriority.value}
                onValueChange={(v) => {
                  void defaultPriority.save(v as TaskPriority);
                }}
              >
                <SelectTrigger
                  className="w-[140px]"
                  aria-label="settings-default-priority"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Default agent method"
              description="Initial method assigned to new tasks."
            >
              <Select
                value={defaultAgentMethod.value}
                onValueChange={(v) => {
                  void defaultAgentMethod.save(v as AgentMethod);
                }}
              >
                <SelectTrigger
                  className="w-[160px]"
                  aria-label="settings-default-agent-method"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Launch at login"
              description="Open TaskPilot automatically when you sign in."
            >
              <ToggleSwitch
                checked={autoLaunchEnabled}
                onChange={(next) => {
                  void handleAutoLaunchToggle(next);
                }}
                disabled={autoLaunchSaving}
                ariaLabel="settings-auto-launch"
              />
            </SettingRow>

            <SettingRow
              label="Quick capture"
              description="Press this combo from anywhere to pop up the capture window. To rebind, edit Settings → Advanced → keybindings.json."
            >
              <div className="flex items-center gap-2">
                <code
                  aria-label="settings-quick-capture-hotkey"
                  className="rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs"
                >
                  {quickCaptureHotkey.value || 'CommandOrControl+Shift+Space'}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="settings-quick-capture-rebind"
                  onClick={() => {
                    toast({
                      title: 'Edit keybindings.json',
                      description:
                        'Open the Advanced tab, then "Open IO folder" — keybindings.json sits next to it in ~/.taskpilot.',
                    });
                  }}
                >
                  Change hotkey
                </Button>
              </div>
            </SettingRow>
          </TabsContent>

          {/* ------------- Workspaces ------------- */}
          <TabsContent value="workspaces" className="mt-4">
            <WorkspacesEditor />
          </TabsContent>

          {/* ------------- Phases ------------- */}
          <TabsContent value="phases" className="mt-4">
            <PhasesEditor />
          </TabsContent>

          {/* ------------- Calendar ------------- */}
          <TabsContent value="calendar" className="mt-4">
            <SettingRow
              label="Google Calendar"
              description={
                calendar.loading
                  ? 'Checking connection…'
                  : calendar.status?.connected
                    ? `Connected${
                        calendar.status.email
                          ? ` as ${calendar.status.email}`
                          : ''
                      }.`
                    : 'Not connected.'
              }
            >
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => calendar.refresh()}
                  aria-label="settings-calendar-refresh"
                >
                  <RefreshCw
                    className={cn(
                      'h-4 w-4',
                      calendar.loading && 'animate-spin',
                    )}
                  />
                </Button>
                {calendar.status?.connected ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void disconnectCalendar();
                    }}
                    aria-label="settings-calendar-disconnect"
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      void connectCalendar();
                    }}
                    disabled={connecting || authPhase === 'polling'}
                    aria-label="settings-calendar-connect"
                  >
                    <CalendarCheck2 className="mr-1 h-4 w-4" />
                    {connecting
                      ? 'Starting…'
                      : authPhase === 'polling'
                        ? 'Waiting…'
                        : 'Connect Google Calendar'}
                  </Button>
                )}
              </div>
            </SettingRow>

            {authUrl && (
              <div
                role="region"
                className="my-2 space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                aria-label="settings-calendar-auth-panel"
              >
                <div
                  className="flex items-center gap-2 text-muted-foreground"
                  aria-live="polite"
                >
                  {authPhase === 'polling' ? (
                    <>
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                      <span aria-label="settings-calendar-waiting">
                        Waiting for Google… (or paste your code manually below)
                      </span>
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
                    aria-label="settings-calendar-manual-code"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      void submitManualCode();
                    }}
                    disabled={submittingCode || manualCode.trim().length === 0}
                    aria-label="settings-calendar-submit-code"
                  >
                    {submittingCode ? 'Submitting…' : 'Submit code'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={cancelConnect}
                    aria-label="settings-calendar-cancel"
                  >
                    <XCircle className="mr-1 h-3.5 w-3.5" />
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            <SettingRow
              label="Agent hours"
              description="Default working window for scheduled agent work."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  className="w-[100px]"
                  value={agentHoursStart.value}
                  onChange={(e) => {
                    void agentHoursStart.save(e.target.value);
                  }}
                  aria-label="settings-agent-hours-start"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="time"
                  className="w-[100px]"
                  value={agentHoursEnd.value}
                  onChange={(e) => {
                    void agentHoursEnd.save(e.target.value);
                  }}
                  aria-label="settings-agent-hours-end"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Run on weekends"
              description="Allow scheduling agent work Saturday and Sunday."
            >
              <ToggleSwitch
                checked={runOnWeekends.value}
                onChange={(next) => {
                  void runOnWeekends.save(next);
                }}
                ariaLabel="settings-run-on-weekends"
              />
            </SettingRow>

            <SettingRow
              label="Import untagged calendar events as inbox tasks"
              description="Surface non-TaskPilot events in your inbox for triage."
            >
              <ToggleSwitch
                checked={calendarToTaskImport.value}
                onChange={(next) => {
                  void calendarToTaskImport.save(next);
                }}
                ariaLabel="settings-calendar-to-task-import"
              />
            </SettingRow>
          </TabsContent>

          {/* ------------- Agent ------------- */}
          <TabsContent value="agent" className="mt-4">
            <SettingRow
              label="Auto-execute approved tasks"
              description="When on, queued agent-executable tasks move to execute on their own."
            >
              <ToggleSwitch
                checked={autoExecuteApproved.value}
                onChange={(next) => {
                  void autoExecuteApproved.save(next);
                }}
                ariaLabel="settings-auto-execute"
              />
            </SettingRow>

            <SettingRow
              label="Pause all agent work"
              description="Hard stop. No new derive or execute writes until off."
            >
              <ToggleSwitch
                checked={pauseAllAgents.value}
                onChange={(next) => {
                  void pauseAllAgents.save(next);
                }}
                ariaLabel="settings-pause-agents"
              />
            </SettingRow>

            <SettingRow
              label="Method preference"
              description="Hint for derivation. Both modes still work either way."
            >
              <Select
                value={coworkPreferred.value ? 'cowork' : 'cli'}
                onValueChange={(v) => {
                  void coworkPreferred.save(v === 'cowork');
                }}
              >
                <SelectTrigger
                  className="w-[180px]"
                  aria-label="settings-method-preference"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cowork">Cowork preferred</SelectItem>
                  <SelectItem value="cli">CLI preferred</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>

            <SettingRow
              label="Confidence threshold"
              description="Results below this confidence value auto-route to /review even when review_required is false. 0 disables the gate."
            >
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={confidenceThreshold.value}
                  onChange={(e) => {
                    const next = Number.parseFloat(e.target.value);
                    void confidenceThreshold.save(
                      Number.isFinite(next) ? next : 0.7,
                    );
                  }}
                  aria-label="settings-confidence-threshold"
                  className="h-1 w-32 cursor-pointer accent-primary"
                />
                <Input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  value={confidenceThreshold.value}
                  onChange={(e) => {
                    const next = Number.parseFloat(e.target.value);
                    if (!Number.isFinite(next)) return;
                    void confidenceThreshold.save(
                      Math.max(0, Math.min(1, next)),
                    );
                  }}
                  className="h-8 w-20 text-xs tabular-nums"
                  aria-label="settings-confidence-threshold-input"
                />
              </div>
            </SettingRow>

            {pauseAllAgents.value && (
              <div
                className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
                aria-label="settings-pause-warning"
              >
                <PauseCircle className="h-4 w-4" />
                All agent work is paused.
              </div>
            )}

            <ClaudeRunnerCard
              enabled={runnerEnabled}
              command={runnerCommand}
              intervalMs={runnerIntervalMs}
            />
          </TabsContent>

          {/* ------------- Ambient ------------- */}
          <TabsContent value="ambient" className="mt-4">
            <SettingRow
              label="Monitor active window"
              description="Periodically capture the foreground app and window title. Off by default — flip on to let the deliberation harness see what you're working on."
            >
              <ToggleSwitch
                checked={ambientMonitorEnabled.value}
                onChange={(next) => {
                  void ambientMonitorEnabled.save(next);
                }}
                ariaLabel="settings-ambient-monitor"
              />
            </SettingRow>

            <SettingRow
              label="Capture periodic screenshots"
              description="Subordinate to the master monitor toggle. PNGs land under ~/.taskpilot/captures/ and are pruned by the retention sweep."
            >
              <ToggleSwitch
                checked={ambientScreenshotEnabled.value}
                onChange={(next) => {
                  void ambientScreenshotEnabled.save(next);
                }}
                disabled={!ambientMonitorEnabled.value}
                ariaLabel="settings-ambient-screenshots"
              />
            </SettingRow>

            <SettingRow
              label="Interrupt threshold"
              description="How sharp a context shift must be before the monitor fires a deliberation. Lower = more interruptions."
            >
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={Math.round(ambientInterruptThreshold.value * 10)}
                  onChange={(e) => {
                    const raw = Number.parseInt(e.target.value, 10);
                    if (!Number.isFinite(raw)) return;
                    void ambientInterruptThreshold.save(
                      Math.max(0, Math.min(10, raw)) / 10,
                    );
                  }}
                  aria-label="settings-ambient-interrupt-threshold"
                  className="h-1 w-32 cursor-pointer accent-primary"
                />
                <span className="w-8 text-xs tabular-nums text-muted-foreground">
                  {Math.round(ambientInterruptThreshold.value * 10)}
                </span>
              </div>
            </SettingRow>

            <SettingRow
              label="Chrome extension token"
              description="Per-install bearer token. Paste it into the TaskPilot extension's options page on first install."
              stacked
            >
              <AmbientTokenCopy />
            </SettingRow>
          </TabsContent>

          {/* ------------- Integrations ------------- */}
          <TabsContent value="integrations" className="mt-4">
            <GitHubIntegrationCard />
            <SlackIntegrationCard />
            <GmailIntegrationCard />
            <NotionIntegrationCard />
            <RedditIntegrationCard />
            <LovableIntegrationCard />
            <WebhooksEditor />
          </TabsContent>

          {/* ------------- Permissions ------------- */}
          <TabsContent value="permissions" className="mt-4">
            <PermissionsTab />
          </TabsContent>

          {/* ------------- Advanced ------------- */}
          <TabsContent value="advanced" className="mt-4">
            <SettingRow
              label="TaskPilot home"
              description="Root config + state directory."
              stacked
            >
              <code className="block break-all rounded bg-muted px-2 py-1 text-[11px]">
                {homePath}
              </code>
            </SettingRow>
            <SettingRow
              label="Database path"
              description="SQLite DB used by the local server."
              stacked
            >
              <code className="block break-all rounded bg-muted px-2 py-1 text-[11px]">
                {dbPath}
              </code>
            </SettingRow>
            <SettingRow
              label="I/O root"
              description="File-based agent protocol root."
              stacked
            >
              <div className="flex items-start gap-2">
                <code className="block flex-1 break-all rounded bg-muted px-2 py-1 text-[11px]">
                  {ioRoot}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void openIoFolder();
                  }}
                  aria-label="settings-open-io-folder"
                >
                  <FolderOpen className="mr-1 h-4 w-4" />
                  Open
                </Button>
              </div>
            </SettingRow>

            <SettingRow
              label="Export database"
              description="Shows the DB path so you can copy it manually."
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleExportDb}
                aria-label="settings-export-db"
              >
                <Cog className="mr-1 h-4 w-4" />
                Show DB path
              </Button>
            </SettingRow>

            <SettingRow
              label="Reset I/O pipeline"
              description="Force a rescan of inbox/derived/results folders."
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setResetOpen(true)}
                aria-label="settings-reset-io"
              >
                <Wand2 className="mr-1 h-4 w-4" />
                Reset
              </Button>
            </SettingRow>

            <SettingRow
              label="Diagnostic info"
              description="Copy app version, OS, and recent server events to clipboard."
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void copyDiagnosticInfo();
                }}
                aria-label="settings-copy-diagnostic"
              >
                <ClipboardCopy className="mr-1 h-4 w-4" />
                Copy diagnostic info
              </Button>
            </SettingRow>

            <SettingRow
              label="Export data"
              description="Download a JSON snapshot of every task, log, setting, and template."
            >
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleExportData();
                }}
                disabled={exportMut.isPending}
                aria-label="settings-export-data"
              >
                <Download className="mr-1 h-4 w-4" />
                {exportMut.isPending ? 'Preparing…' : 'Export JSON'}
              </Button>
            </SettingRow>

            <SettingRow
              label="Import data"
              description="Restore tasks, logs, settings, and templates from a previous export. Existing ids are skipped."
            >
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  aria-label="settings-import-file"
                  onChange={(e) => {
                    void handleImportFile(e);
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importMut.isPending}
                  aria-label="settings-import-data"
                >
                  <Upload className="mr-1 h-4 w-4" />
                  {importMut.isPending ? 'Importing…' : 'Import JSON'}
                </Button>
              </div>
            </SettingRow>

            {/* Operational hardening — Wave 12. Backups + opt-in telemetry. */}
            <div className="mt-6 space-y-4">
              <BackupCard />
              <TelemetryCard />
            </div>

            <div className="mt-4 text-[10px] uppercase tracking-wide text-muted-foreground">
              Last config refresh: {format(new Date(), 'h:mm:ss a')}
            </div>
          </TabsContent>

          {/* ------------- About ------------- */}
          <TabsContent value="about" className="mt-4">
            {/* Reuses the standalone /about view so both entry points stay
                in sync. The view manages its own padding/header. */}
            <About />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog
        open={resetOpen}
        onOpenChange={(next) => {
          if (!next) setResetOpen(false);
        }}
      >
        <DialogContent aria-label="settings-reset-dialog">
          <DialogHeader>
            <DialogTitle>Reset I/O pipeline?</DialogTitle>
            <DialogDescription>
              Forces the watcher to rescan all I/O folders and re-ingest any
              pending derived/results JSON. Safe — no data is deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setResetOpen(false)}
              aria-label="settings-reset-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                void runResetIo();
              }}
              disabled={resetting}
              aria-label="settings-reset-confirm"
            >
              {resetting ? 'Rescanning…' : 'Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Toggle switch — no @radix-ui/react-switch in approved deps, so we roll    */
/*  our own minimal accessible variant.                                       */
/* -------------------------------------------------------------------------- */

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: ToggleSwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Ambient — Chrome extension bearer token                                   */
/* -------------------------------------------------------------------------- */

/**
 * Renders the per-install bearer token + a copy-to-clipboard button. The
 * value is resolved through the same IPC bridge the rest of the renderer
 * uses; if the bridge is unavailable (e.g. running in a browser preview)
 * we fall back to a placeholder so the row still renders.
 */
/* -------------------------------------------------------------------------- */
/*  Claude auto-runner card                                                   */
/* -------------------------------------------------------------------------- */

interface RunnerStatusResponse {
  enabled: boolean;
  running: boolean;
  available: boolean;
  command: string;
  program: string;
  interval_ms: number;
  timeout_ms: number;
  workdir: string;
  probe_error: string | null;
  last_run: {
    started_at: string;
    ended_at: string;
    duration_ms: number;
    exit_code: number | null;
    signal: string | null;
    stdout_tail: string;
    stderr_tail: string;
    timed_out: boolean;
  } | null;
}

function ClaudeRunnerCard({
  enabled,
  command,
  intervalMs,
}: {
  enabled: ReturnType<typeof useSetting<boolean>>;
  command: ReturnType<typeof useSetting<string>>;
  intervalMs: ReturnType<typeof useSetting<number>>;
}): JSX.Element {
  const { toast } = useToast();
  const qc = useQueryClient();
  // Poll every 5s while the runner card is mounted so the "last run" panel
  // and the available probe stay current without manual refresh.
  const statusQ = useQuery({
    queryKey: ['claude-runner-status'],
    queryFn: () => api.get<RunnerStatusResponse>('/api/claude-runner/status'),
    refetchInterval: 5_000,
  });
  const [busy, setBusy] = useState(false);

  const runNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.post<{ ok: boolean }>('/api/claude-runner/run-now', {});
      await qc.invalidateQueries({ queryKey: ['claude-runner-status'] });
      toast({ title: 'Runner kicked off', description: 'See last-run panel below.' });
    } catch (err) {
      toast({
        title: 'Run failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const status = statusQ.data;
  const cmdToShow = command.value || status?.command || '';
  const programToShow = status?.program || cmdToShow.split(/\s+/)[0] || '';

  return (
    <div
      className="mt-6 rounded-md border border-border bg-card p-4"
      aria-label="settings-runner-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">Auto-runner</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Spawn a CLI on a schedule to drain the execute queue. The default
            command targets the Claude Code CLI; any drain script works.
          </div>
        </div>
        <ToggleSwitch
          checked={enabled.value}
          onChange={(next) => {
            void enabled.save(next);
            // Re-arm the interval right after toggling so the runner
            // reflects the new state without a restart.
            void api
              .post<{ ok: boolean }>('/api/claude-runner/refresh', {})
              .catch(() => {
                /* non-fatal */
              });
          }}
          ariaLabel="settings-runner-enable"
        />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px]">
        <div className="space-y-1.5">
          <Label htmlFor="runner-command" className="text-xs">
            Command
          </Label>
          <Input
            id="runner-command"
            value={command.value}
            onChange={(e) => {
              void command.save(e.target.value);
            }}
            placeholder={
              status?.command ?? 'claude -p /tp-watch'
            }
            aria-label="settings-runner-command"
          />
          <div className="text-[11px] text-muted-foreground">
            Tokenized strictly — no shell expansion, no piping. Wrap a script
            if you need shell features.
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runner-interval" className="text-xs">
            Interval (s)
          </Label>
          <Input
            id="runner-interval"
            type="number"
            min={5}
            value={Math.round(intervalMs.value / 1000)}
            onChange={(e) => {
              const seconds = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(seconds)) return;
              void intervalMs.save(Math.max(5, seconds) * 1000);
            }}
            aria-label="settings-runner-interval"
          />
        </div>
      </div>

      {status && !status.available && programToShow ? (
        <div
          className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
          aria-label="settings-runner-missing"
        >
          <Info className="h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">
              <code>{programToShow}</code> not found on PATH.
            </div>
            <div className="mt-0.5">
              Install the Claude Code CLI with{' '}
              <code>npm i -g @anthropic-ai/claude-code</code>, or point this
              setting at any script that drains <code>~/.taskpilot/io/execute/</code>.
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="text-[11px] text-muted-foreground">
          {status?.running ? 'Run in progress…' : 'Idle.'}
          {status?.last_run
            ? ` Last run ${new Date(
                status.last_run.started_at,
              ).toLocaleTimeString()} · ${status.last_run.duration_ms} ms · exit ${
                status.last_run.exit_code ?? 'killed'
              }`
            : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void runNow()}
          disabled={busy || (status?.running ?? false)}
          aria-label="settings-runner-runnow"
        >
          Run now
        </Button>
      </div>

      {status?.last_run?.stdout_tail || status?.last_run?.stderr_tail ? (
        <details className="mt-3 rounded-md border border-border bg-muted/30 p-2">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
            Last run output
          </summary>
          {status.last_run.stdout_tail ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[10px] leading-snug">
              {status.last_run.stdout_tail}
            </pre>
          ) : null}
          {status.last_run.stderr_tail ? (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 text-[10px] leading-snug text-destructive">
              {status.last_run.stderr_tail}
            </pre>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

function AmbientTokenCopy(): JSX.Element {
  const { toast } = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      const value = await resolveApiToken();
      if (!cancelled) setToken(value);
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const masked = token
    ? `${token.slice(0, 4)}${'•'.repeat(Math.max(token.length - 8, 4))}${token.slice(-4)}`
    : '—';

  const onCopy = async (): Promise<void> => {
    if (!token) {
      toast({
        title: 'Token unavailable',
        description:
          'The bridge has not returned a token yet. Try again in a moment.',
        variant: 'destructive',
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      toast({
        title: 'Token copied',
        description: 'Paste it into the TaskPilot Chrome extension.',
      });
    } catch (cause) {
      toast({
        title: 'Copy failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <code
        className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs"
        aria-label="settings-ambient-token-value"
      >
        {revealed ? (token ?? '—') : masked}
      </code>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRevealed((r) => !r)}
          aria-label="settings-ambient-token-reveal"
        >
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onCopy()}
          aria-label="settings-ambient-token-copy"
        >
          <ClipboardCopy className="mr-1 h-4 w-4" />
          Copy
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  GitHub integration card                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The card sits inside the Integrations tab and exposes:
 *  - Empty state: PAT input + Connect button, with help text linking to the
 *    GitHub fine-grained PAT settings page and listing required scopes.
 *  - Connected state: avatar + login, Disconnect button, "Test connection"
 *    that re-probes the API, and a "Default repo for new tasks" picker that
 *    writes `default_github_repo` via the existing settings endpoint.
 *
 * The PAT input uses `type="password"` and `autoComplete="off"` so password
 * managers don't store it. The token is only ever sent to `/api/github/connect`
 * — it's never echoed back from the server.
 */
function GitHubIntegrationCard(): JSX.Element {
  const { toast } = useToast();
  const statusQ = useGitHubStatus();
  const connectMut = useConnectGitHub();
  const disconnectMut = useDisconnectGitHub();
  const connected = Boolean(statusQ.data?.connected);
  const reposQ = useGitHubRepos(connected);

  const defaultRepoSetting = useSetting<string>(
    'default_github_repo',
    stringSetting(''),
  );

  const [token, setToken] = useState('');

  const handleConnect = async (): Promise<void> => {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      toast({
        title: 'Paste your PAT first',
        description:
          'Generate a fine-grained Personal Access Token on GitHub and paste it above.',
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await connectMut.mutateAsync({ token: trimmed });
      setToken('');
      toast({
        title: 'GitHub connected',
        description: res.user.login ? `Authenticated as ${res.user.login}.` : '',
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
      toast({ title: 'GitHub disconnected' });
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
          title: 'GitHub connection healthy',
          description: res.data.user?.login
            ? `Authenticated as ${res.data.user.login}.`
            : '',
        });
      } else {
        toast({
          title: 'Not connected',
          description: 'The stored PAT is missing or no longer valid.',
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

  const user = statusQ.data?.user;
  const repos = reposQ.data?.repos ?? [];

  return (
    <div
      className="rounded-md border border-border bg-background/40"
      aria-label="settings-integrations-github"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Github className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">GitHub</div>
          <div className="text-xs text-muted-foreground">
            {statusQ.isLoading
              ? 'Checking connection…'
              : connected
                ? `Connected${user?.login ? ` as ${user.login}` : ''}.`
                : 'Not connected.'}
          </div>
        </div>
        {connected && user?.avatar_url ? (
          <img
            src={user.avatar_url}
            alt={user.login}
            className="h-8 w-8 rounded-full border border-border"
          />
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-3">
        {!connected ? (
          <>
            <div className="text-xs text-muted-foreground">
              Generate a fine-grained PAT at{' '}
              <a
                href="https://github.com/settings/personal-access-tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary underline"
              >
                github.com/settings/personal-access-tokens
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>{' '}
              with{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                Contents: Read &amp; Write
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                Pull requests: Read &amp; Write
              </code>
              , and{' '}
              <code className="rounded bg-muted px-1 text-[10px]">
                Issues: Read &amp; Write
              </code>{' '}
              scopes on the repos you want TaskPilot to operate on.
            </div>

            <div className="flex items-stretch gap-2">
              <Input
                type="password"
                placeholder="github_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="h-8 flex-1 font-mono text-xs"
                aria-label="settings-github-pat-input"
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
                aria-label="settings-github-connect"
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
                aria-label="settings-github-test"
              >
                <CheckCircle2 className="mr-1 h-4 w-4" />
                {statusQ.isFetching ? 'Testing…' : 'Test connection'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void handleDisconnect();
                }}
                disabled={disconnectMut.isPending}
                aria-label="settings-github-disconnect"
              >
                <Unplug className="mr-1 h-4 w-4" />
                {disconnectMut.isPending ? 'Disconnecting…' : 'Disconnect'}
              </Button>
            </div>

            <SettingRow
              label="Default repo for new tasks"
              description="Tasks with a GitHub permission will default to this repo when none is specified."
            >
              <Select
                value={defaultRepoSetting.value || 'none'}
                onValueChange={(v) => {
                  void defaultRepoSetting.save(v === 'none' ? '' : v);
                }}
              >
                <SelectTrigger
                  className="w-[260px]"
                  aria-label="settings-github-default-repo"
                >
                  <SelectValue
                    placeholder={
                      reposQ.isLoading ? 'Loading repos…' : 'Select a repo'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— none —</SelectItem>
                  {repos.map((r) => (
                    <SelectItem key={r.full_name} value={r.full_name}>
                      {r.full_name}
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

/* -------------------------------------------------------------------------- */
/*  Permissions tab                                                            */
/* -------------------------------------------------------------------------- */

const DEFAULT_PROFILE_OPTIONS: {
  value: PermissionProfileName | '';
  label: string;
}[] = [
  { value: '', label: 'No default (start blank)' },
  { value: 'trusted-local', label: 'Trusted local' },
  { value: 'sandboxed', label: 'Sandboxed' },
  { value: 'read-only-research', label: 'Read-only research' },
  { value: 'github-pr', label: 'GitHub PR' },
];

/**
 * Settings → Permissions tab. Lists every built-in profile with its
 * description and lets the user pick a default profile that auto-seeds
 * onto new top-level tasks at creation time.
 *
 * Reads/writes the `default_permission_profile` setting via the generic
 * setting hook the same way other settings do.
 */
function PermissionsTab(): JSX.Element {
  const profilesQ = usePermissionProfiles();
  const defaultProfile = useSetting<PermissionProfileName | ''>(
    'default_permission_profile',
    {
      defaultValue: '',
      parse: (raw) => {
        if (
          raw === 'trusted-local' ||
          raw === 'sandboxed' ||
          raw === 'read-only-research' ||
          raw === 'github-pr'
        ) {
          return raw;
        }
        return '';
      },
      serialize: (value) => (value === '' ? null : value),
    },
  );

  return (
    <div aria-label="settings-permissions">
      <SettingRow
        label="Default profile for new tasks"
        description="Auto-applied to top-level tasks at creation time. Children inherit unless overridden."
      >
        <Select
          value={defaultProfile.value}
          onValueChange={(v) => {
            void defaultProfile.save(v as PermissionProfileName | '');
          }}
        >
          <SelectTrigger
            className="w-[220px]"
            aria-label="settings-default-permission-profile"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_PROFILE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value || 'none'} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>

      <div className="mt-4 space-y-3">
        <h3 className="text-sm font-semibold">Available profiles</h3>
        {profilesQ.isLoading && (
          <div className="text-xs text-muted-foreground">
            Loading profiles…
          </div>
        )}
        {(profilesQ.data?.profiles ?? []).map((p) => (
          <div
            key={p.name}
            className="rounded-md border border-border bg-card/40 p-3"
            aria-label={`settings-profile-${p.name}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">{p.label}</div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  {p.name}
                </div>
              </div>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {p.description}
            </p>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/50 p-2 text-[11px] leading-relaxed">
              {JSON.stringify(p.permissions, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
