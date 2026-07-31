/**
 * Telemetry opt-in card for Settings → Advanced.
 *
 * The card surfaces:
 *   - A toggle binding `telemetry_enabled` (defaults OFF)
 *   - The destination URL bound to `telemetry_endpoint` (default empty)
 *   - Live counts: total events recorded locally, pending upload
 *   - The exact local log path (`~/.taskpilot/logs/telemetry.jsonl`)
 *   - A "What's sent?" expander listing every field
 *
 * Events ALWAYS log locally — toggling the opt-in only controls whether the
 * uploader ships them to the endpoint. Nothing leaves the machine unless
 * BOTH the toggle is on AND the endpoint is set.
 */

import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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
  useFlushTelemetry,
  useTelemetryStatus,
} from '@/renderer/lib/query';

/* -------------------------------------------------------------------------- */
/*  Mini-hooks for the two settings the card binds to                         */
/* -------------------------------------------------------------------------- */

interface SettingResponse {
  value: string | null;
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
        if (cause instanceof ApiError && cause.status === 0) return null;
        throw cause;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (next: boolean): Promise<void> => {
      // Telemetry flags are stored as JSON booleans (matches settings repo
      // semantics — `value: true` round-trips back as boolean true).
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next,
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], { value: next ? 'true' : 'false' });
      qc.invalidateQueries({ queryKey: ['telemetry', 'status'] });
    },
    onError: (cause) => {
      toast({
        title: 'Couldn’t save telemetry setting',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const raw = settingQ.data?.value ?? null;
  const parsed = (() => {
    if (raw === null) return defaultValue;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return defaultValue;
  })();

  return {
    value: parsed,
    saving: mutation.isPending,
    save: async (next: boolean) => {
      await mutation.mutateAsync(next);
    },
  };
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
        if (cause instanceof ApiError && cause.status === 0) return null;
        throw cause;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: async (next: string): Promise<void> => {
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next.trim().length === 0 ? null : next.trim(),
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], { value: next });
      qc.invalidateQueries({ queryKey: ['telemetry', 'status'] });
    },
    onError: (cause) => {
      toast({
        title: 'Couldn’t save endpoint',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const raw = settingQ.data?.value ?? null;
  return {
    value: raw ?? defaultValue,
    saving: mutation.isPending,
    save: async (next: string) => {
      await mutation.mutateAsync(next);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Toggle (same shape as Settings.tsx)                                        */
/* -------------------------------------------------------------------------- */

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled,
}: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ' +
        (checked ? 'bg-primary' : 'bg-input')
      }
    >
      <span
        aria-hidden="true"
        className={
          'inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition-transform ' +
          (checked ? 'translate-x-5' : 'translate-x-0.5')
        }
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

const SENT_FIELDS = [
  { name: 'app_version', desc: 'TaskPilot version, e.g. 0.1.0' },
  { name: 'platform', desc: 'process.platform — `win32`, `darwin`, or `linux`' },
  { name: 'kind', desc: 'Event type: launch, task_created, task_done, task_failed, derive, execute, error' },
  { name: 'at', desc: 'ISO timestamp the event was recorded' },
  { name: 'payload.counts', desc: 'Aggregate counts only (no titles, descriptions, IDs)' },
  { name: 'payload.error', desc: 'Sanitized stack trace — paths replaced with `~`, env vars stripped' },
];

const NEVER_SENT = [
  'Task titles, descriptions, tags, IDs',
  'Settings values',
  'OAuth tokens or API keys',
  'File contents',
  'Calendar event details',
  'Email contents or addresses',
];

export function TelemetryCard(): JSX.Element {
  const { toast } = useToast();
  const enabled = useBoolSetting('telemetry_enabled', false);
  const endpoint = useStringSetting('telemetry_endpoint', '');
  const statusQ = useTelemetryStatus();
  const flushMut = useFlushTelemetry();

  const [endpointDraft, setEndpointDraft] = useState<string>('');
  const [expanded, setExpanded] = useState(false);

  // Sync the input draft when the persisted value changes (e.g. from another
  // tab or a fresh fetch).
  useEffect(() => {
    setEndpointDraft(endpoint.value);
  }, [endpoint.value]);

  const handleSaveEndpoint = async (): Promise<void> => {
    if (endpointDraft === endpoint.value) return;
    try {
      await endpoint.save(endpointDraft);
      toast({
        title: 'Telemetry endpoint saved',
        description:
          endpointDraft.trim().length > 0
            ? `Events will be shipped to ${endpointDraft.trim()} (only when the toggle is ON).`
            : 'Endpoint cleared. No uploads will happen.',
      });
    } catch {
      // already toasted inside the hook
    }
  };

  const handleFlush = async (): Promise<void> => {
    try {
      const res = await flushMut.mutateAsync();
      toast({
        title: 'Telemetry flushed',
        description: `Uploaded ${res.uploaded} event(s). ${res.errors} error(s).`,
      });
    } catch (cause) {
      toast({
        title: 'Flush failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleOpenLog = (): void => {
    // The renderer can't open arbitrary file paths; the most we can do is
    // show the path in a toast so the user can copy it.
    toast({
      title: 'Telemetry log path',
      description: statusQ.data?.log_path ?? '~/.taskpilot/logs/telemetry.jsonl',
    });
  };

  const pending = statusQ.data?.pending ?? 0;
  const total = statusQ.data?.total_events ?? 0;
  const isUploadingPossible =
    enabled.value && (statusQ.data?.endpoint?.length ?? 0) > 0;

  return (
    <div
      className="rounded-md border border-border bg-background/40"
      aria-label="settings-telemetry-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Anonymous telemetry</div>
          <div className="text-xs text-muted-foreground">
            Off by default. Events always log locally; only uploaded when both
            the toggle is on AND an endpoint is set.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void statusQ.refetch();
          }}
          disabled={statusQ.isFetching}
          aria-label="settings-telemetry-refresh"
        >
          <RefreshCw
            className={
              statusQ.isFetching
                ? 'mr-1 h-4 w-4 animate-spin'
                : 'mr-1 h-4 w-4'
            }
          />
          Refresh
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <SettingRow
          label="Send anonymous usage telemetry"
          description="When ON and an endpoint is set, sanitized events are uploaded periodically."
        >
          <Toggle
            checked={enabled.value}
            onChange={(next) => {
              void enabled.save(next);
            }}
            ariaLabel="settings-telemetry-toggle"
            disabled={enabled.saving}
          />
        </SettingRow>

        <SettingRow
          label="Telemetry endpoint"
          description="HTTPS URL accepting NDJSON POSTs. Leave blank to keep everything local."
          stacked
        >
          <div className="flex items-stretch gap-2">
            <Input
              type="url"
              placeholder="https://your-ingest.example.com/taskpilot"
              value={endpointDraft}
              onChange={(e) => setEndpointDraft(e.target.value)}
              className="h-8 flex-1 font-mono text-xs"
              aria-label="settings-telemetry-endpoint"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void handleSaveEndpoint();
              }}
              disabled={
                endpoint.saving || endpointDraft === endpoint.value
              }
              aria-label="settings-telemetry-endpoint-save"
            >
              Save
            </Button>
          </div>
        </SettingRow>

        <SettingRow
          label="Recent events"
          description="Local log under ~/.taskpilot/logs/telemetry.jsonl. Rotates at 10 MB."
        >
          <div className="flex items-center gap-2 text-xs">
            <code
              className="rounded bg-muted px-2 py-1"
              aria-label="settings-telemetry-counts"
            >
              total {total} · pending {pending}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleOpenLog}
              aria-label="settings-telemetry-open-log"
            >
              Show log path
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void handleFlush();
              }}
              disabled={flushMut.isPending || !isUploadingPossible}
              aria-label="settings-telemetry-flush"
            >
              {flushMut.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-1 h-4 w-4" />
              )}
              Flush now
            </Button>
          </div>
        </SettingRow>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-label="settings-telemetry-expand-fields"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          What's sent?
        </button>

        {expanded && (
          <div
            className="space-y-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
            aria-label="settings-telemetry-fields"
          >
            <div>
              <div className="mb-1 font-medium">Sent (when uploads run):</div>
              <ul className="space-y-1">
                {SENT_FIELDS.map((f) => (
                  <li key={f.name} className="font-mono">
                    <span className="text-primary">{f.name}</span>{' '}
                    <span className="text-muted-foreground">— {f.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium">Never sent:</div>
              <ul className="list-inside list-disc text-muted-foreground">
                {NEVER_SENT.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
