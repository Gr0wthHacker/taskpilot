/**
 * About view.
 *
 * Two responsibilities:
 *  1. Show TaskPilot's identity (version, runtime, OS, install paths).
 *  2. Hand the user a "Copy diagnostic info" button that bundles everything
 *     above plus a snapshot of the last 50 SSE events from the renderer
 *     ring buffer — exactly what the developer wants pasted into a bug
 *     report.
 *
 * Mounted at `/about` and ALSO reused as a tab inside Settings (the same
 * default export) so the user can find it from either entrypoint.
 *
 * `getRecentApiEvents()` reads a module-level ring buffer kept hot by
 * `useApiEventStream()`. As long as the app booted normally (which mounts
 * the stream at the layout level), the buffer will be populated.
 */

import { ClipboardCopy, ExternalLink, Github } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { api } from '@/renderer/lib/api';
import {
  getRecentApiEvents,
  useConfig,
  useTasksList,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Runtime probes                                                            */
/* -------------------------------------------------------------------------- */

interface RuntimeInfo {
  platform: string;
  arch: string;
  userAgent: string;
  electron: string;
  node: string;
  chrome: string;
}

/**
 * Pull whatever we can from `navigator` and the bridge. Electron's
 * `process.versions` isn't exposed to the sandboxed renderer, so we infer
 * it from the UA string when the bridge doesn't carry the values.
 */
function readRuntimeInfo(): RuntimeInfo {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = nav?.userAgent ?? '';
  // UA format example:
  //   Mozilla/5.0 (...) AppleWebKit/... Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36
  const electronMatch = /Electron\/([\d.]+)/.exec(ua);
  const chromeMatch = /Chrome\/([\d.]+)/.exec(ua);
  const nodeMatch =
    typeof window !== 'undefined' &&
    typeof (window as { process?: { versions?: { node?: string } } }).process
      ?.versions?.node === 'string'
      ? (window as { process?: { versions?: { node?: string } } }).process
          ?.versions?.node ?? null
      : null;

  return {
    platform: nav?.platform ?? 'unknown',
    arch:
      // The renderer can't read `process.arch` directly under sandbox, but
      // it's encoded in the UA on most browsers. Best-effort only.
      /x64|amd64|win64/i.test(ua)
        ? 'x64'
        : /arm64|aarch64/i.test(ua)
          ? 'arm64'
          : 'unknown',
    userAgent: ua,
    electron: electronMatch?.[1] ?? 'unknown',
    node: nodeMatch ?? 'unknown',
    chrome: chromeMatch?.[1] ?? 'unknown',
  };
}

/* -------------------------------------------------------------------------- */
/*  About card                                                                */
/* -------------------------------------------------------------------------- */

const MCP_SNIPPET = `claude mcp add --scope user taskpilot \\
  --command "taskpilot" --args "mcp"`;

interface InfoRowProps {
  label: string;
  value: string;
  stacked?: boolean;
  copyable?: boolean;
}

function InfoRow({ label, value, stacked, copyable }: InfoRowProps): JSX.Element {
  const { toast } = useToast();
  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: 'Copied to clipboard' });
    } catch (cause) {
      toast({
        title: 'Copy failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };
  return (
    <div
      className={cn(
        'flex gap-4 border-b border-border/60 py-3 last:border-b-0',
        stacked
          ? 'flex-col'
          : 'flex-col items-start justify-between sm:flex-row sm:items-center',
      )}
    >
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div
        className={cn(
          'flex items-center gap-2 text-xs',
          stacked ? 'w-full' : 'shrink-0',
        )}
      >
        <code
          className={cn(
            'break-all rounded bg-muted px-2 py-1 text-[11px]',
            stacked && 'block flex-1',
          )}
        >
          {value}
        </code>
        {copyable && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => {
              void onCopy();
            }}
            aria-label={`about-copy-${label.toLowerCase().replace(/\s+/g, '-')}`}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Diagnostic helpers                                                        */
/* -------------------------------------------------------------------------- */

interface DiagnosticBlob {
  version: string;
  electron: string;
  node: string;
  chrome: string;
  platform: string;
  arch: string;
  user_agent: string;
  paths: {
    home: string;
    db: string;
    logs: string;
    io_root: string;
  };
  task_count: number;
  settings_keys: string[];
  recent_events: ReturnType<typeof getRecentApiEvents>;
}

async function fetchSettingsKeys(): Promise<string[]> {
  try {
    const res = await api.get<{ settings: Record<string, unknown> }>(
      '/api/settings',
    );
    return Object.keys(res.settings ?? {}).sort();
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function About(): JSX.Element {
  const { toast } = useToast();
  const configQ = useConfig();
  const tasksQ = useTasksList({});
  const [copying, setCopying] = useState(false);

  const runtime = useMemo(() => readRuntimeInfo(), []);
  const config = configQ.data;
  const taskCount = tasksQ.data?.tasks.length ?? 0;

  const copyDiagnostic = async (): Promise<void> => {
    setCopying(true);
    try {
      const settingsKeys = await fetchSettingsKeys();
      const blob: DiagnosticBlob = {
        version: config?.version ?? 'unknown',
        electron: runtime.electron,
        node: runtime.node,
        chrome: runtime.chrome,
        platform: runtime.platform,
        arch: runtime.arch,
        user_agent: runtime.userAgent,
        paths: {
          home: config?.paths.home ?? '',
          db: config?.paths.db ?? '',
          logs: config?.paths.logs ?? '',
          io_root: config?.paths.io.root ?? '',
        },
        task_count: taskCount,
        settings_keys: settingsKeys,
        recent_events: getRecentApiEvents().slice(0, 50),
      };
      const payload = JSON.stringify(blob, null, 2);
      await navigator.clipboard.writeText(payload);
      toast({
        title: 'Diagnostic info copied',
        description: `${blob.recent_events.length} recent event(s) included.`,
      });
    } catch (cause) {
      toast({
        title: 'Copy failed',
        description:
          cause instanceof Error ? cause.message : 'Clipboard unavailable.',
        variant: 'destructive',
      });
    } finally {
      setCopying(false);
    }
  };

  const copyMcpSnippet = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(MCP_SNIPPET);
      toast({ title: 'MCP command copied' });
    } catch (cause) {
      toast({
        title: 'Copy failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-about">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">About TaskPilot</h1>
          <p className="text-xs text-muted-foreground">
            Local-first task ops with an agent loop. Built by Jack Gierlich.
          </p>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          v{config?.version ?? '…'}
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="max-w-3xl space-y-6">
          <section
            className="rounded-md border border-border bg-card p-4"
            aria-label="about-build-info"
          >
            <h2 className="mb-2 text-sm font-semibold">Build</h2>
            <InfoRow label="Version" value={config?.version ?? 'unknown'} />
            <InfoRow label="Electron" value={runtime.electron} />
            <InfoRow label="Node" value={runtime.node} />
            <InfoRow label="Chromium" value={runtime.chrome} />
            <InfoRow label="Platform" value={runtime.platform} />
            <InfoRow label="Architecture" value={runtime.arch} />
          </section>

          <section
            className="rounded-md border border-border bg-card p-4"
            aria-label="about-paths"
          >
            <h2 className="mb-2 text-sm font-semibold">Install paths</h2>
            <InfoRow
              label="App home"
              value={config?.paths.home ?? '—'}
              stacked
              copyable
            />
            <InfoRow
              label="Database"
              value={config?.paths.db ?? '—'}
              stacked
              copyable
            />
            <InfoRow
              label="I/O root"
              value={config?.paths.io.root ?? '—'}
              stacked
              copyable
            />
            <InfoRow
              label="Logs"
              value={config?.paths.logs ?? '—'}
              stacked
              copyable
            />
          </section>

          <section
            className="rounded-md border border-border bg-card p-4"
            aria-label="about-mcp"
          >
            <h2 className="mb-2 text-sm font-semibold">Hook up Claude (MCP)</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Run this from a terminal to register TaskPilot with the Claude
              CLI as an MCP server.
            </p>
            <div className="relative">
              <pre className="overflow-auto rounded bg-muted p-3 text-[11px] leading-relaxed">
                {MCP_SNIPPET}
              </pre>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => {
                  void copyMcpSnippet();
                }}
                className="absolute right-1 top-1"
                aria-label="about-copy-mcp"
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </section>

          <section
            className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-4"
            aria-label="about-actions"
          >
            <Button
              type="button"
              onClick={() => {
                void copyDiagnostic();
              }}
              disabled={copying}
              aria-label="about-copy-diagnostic"
            >
              <ClipboardCopy className="mr-1 h-4 w-4" />
              {copying ? 'Collecting…' : 'Copy diagnostic info'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Bundles version, paths, settings keys, and the last 50 server
              events as JSON.
            </span>
          </section>

          <section
            className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground"
            aria-label="about-credits"
          >
            <div className="mb-1 flex items-center gap-1">
              <Github className="h-3.5 w-3.5" />
              <span className="font-medium">TaskPilot</span>
            </div>
            <p>
              Tasks live on disk under{' '}
              <code className="rounded bg-muted px-1 py-0.5">~/.taskpilot</code>.
              No cloud sync. No telemetry. Quitting this app stops the loop.
            </p>
            <p className="mt-2 flex items-center gap-1">
              <ExternalLink className="h-3 w-3" />
              <span>Wave 7 power features: auto-launch, export/import, projects.</span>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
