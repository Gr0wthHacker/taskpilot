/**
 * Per-output card (Wave 15).
 *
 * Renders one entry from an {@link OutputBundle}. The two shapes the panel
 * passes in are {@link OutputFile} (Claude-authored output / user
 * attachment) and {@link OutputArtifact} (PR, calendar event, Notion page,
 * Slack thread, Gmail draft, GitHub issue).
 *
 * Each card has:
 *   - a kind-specific icon (lucide)
 *   - a clickable title that opens the artifact via `taskpilot.openExternal`
 *     for file:// or http(s):// targets, falling back to `window.open`
 *   - optional metadata row (size, mime, state) and inline text preview
 */

import {
  Calendar as CalendarIcon,
  ExternalLink,
  Eye,
  FileText,
  Github,
  Mail,
  MessageCircle,
  StickyNote,
} from 'lucide-react';

import { cn } from '@/renderer/lib/utils';
import type { OutputArtifact, OutputFile } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAdded(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Open a URL via the Electron bridge when available, otherwise fall back
 * to `window.open`. Mirrors the pattern used by other detail-view sections.
 */
async function openExternal(target: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const bridge = (window as unknown as {
    taskpilot?: {
      openExternal?: (url: string) => Promise<unknown> | unknown;
      shell?: { openExternal?: (url: string) => Promise<void> | void };
    };
  }).taskpilot;
  try {
    if (bridge?.openExternal) {
      await bridge.openExternal(target);
      return;
    }
    if (bridge?.shell?.openExternal) {
      await bridge.shell.openExternal(target);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  } catch {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
}

function basename(p: string): string {
  // Cross-platform basename — split on either separator and take the last
  // non-empty fragment.
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/* -------------------------------------------------------------------------- */
/*  File card                                                                 */
/* -------------------------------------------------------------------------- */

export interface OutputFileCardProps {
  file: OutputFile;
  /** When true, the card describes a user-uploaded attachment instead of an
   *  agent-authored output. Affects the icon and the metadata label. */
  attachment?: boolean;
  /** When provided, renders a "View" button that opens the file in-app. */
  onView?: (file: OutputFile) => void;
  className?: string;
}

export function OutputFileCard({
  file,
  attachment,
  onView,
  className,
}: OutputFileCardProps): JSX.Element {
  const filename = basename(file.path);
  const target = `file://${file.path}`;
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3 text-xs',
        className,
      )}
      aria-label={`output-card-file-${filename}`}
    >
      <div className="flex items-start gap-2">
        <FileText
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => {
              void openExternal(target);
            }}
            className="truncate text-left font-medium text-foreground hover:text-primary"
            title={filename}
            aria-label={`output-card-open-${filename}`}
          >
            {filename}
          </button>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {formatBytes(file.size_bytes)}
            {file.content_type && file.content_type !== 'application/octet-stream'
              ? ` · ${file.content_type}`
              : ''}
            {' · '}
            <span title={file.added_at}>{formatAdded(file.added_at)}</span>
            {attachment ? ' · uploaded' : ''}
          </div>
        </div>
        {onView && (
          <button
            type="button"
            onClick={() => onView(file)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
            aria-label={`output-card-view-${filename}`}
          >
            <Eye className="h-3 w-3" />
            View
          </button>
        )}
      </div>
      {file.preview && (
        <pre
          className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground"
          aria-label={`output-card-preview-${filename}`}
        >
          {file.preview}
        </pre>
      )}
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/*  Artifact card                                                             */
/* -------------------------------------------------------------------------- */

export interface OutputArtifactCardProps {
  artifact: OutputArtifact;
  className?: string;
}

export function OutputArtifactCard({
  artifact,
  className,
}: OutputArtifactCardProps): JSX.Element {
  const view = describeArtifact(artifact);
  return (
    <article
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border bg-card/40 p-3 text-xs',
        className,
      )}
      aria-label={`output-card-artifact-${artifact.kind}`}
    >
      <div className="flex items-start gap-2">
        <view.Icon
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {view.url ? (
            <button
              type="button"
              onClick={() => {
                void openExternal(view.url as string);
              }}
              className="inline-flex items-center gap-1 truncate text-left font-medium text-foreground hover:text-primary"
              aria-label={`output-card-artifact-open-${artifact.kind}`}
            >
              {view.title}
              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <div className="truncate font-medium text-foreground">
              {view.title}
            </div>
          )}
          {view.meta && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {view.meta}
            </div>
          )}
        </div>
        {view.badge && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {view.badge}
          </span>
        )}
      </div>
    </article>
  );
}

interface ArtifactView {
  Icon: typeof Github;
  title: string;
  url: string | null;
  meta: string | null;
  badge: string | null;
}

function describeArtifact(artifact: OutputArtifact): ArtifactView {
  switch (artifact.kind) {
    case 'github_pr':
      return {
        Icon: Github,
        title: `Pull request #${artifact.number}`,
        url: artifact.url,
        meta: null,
        badge: artifact.state,
      };
    case 'github_issue':
      return {
        Icon: Github,
        title: `Issue #${artifact.number}`,
        url: artifact.url,
        meta: null,
        badge: artifact.state,
      };
    case 'calendar_event':
      return {
        Icon: CalendarIcon,
        title: artifact.summary
          ? `Calendar: ${artifact.summary}`
          : 'Calendar event',
        url: null,
        meta: artifact.event_id,
        badge: null,
      };
    case 'notion_page':
      return {
        Icon: StickyNote,
        title: artifact.url
          ? 'Notion page'
          : `Notion page · ${artifact.page_id}`,
        url: artifact.url ?? null,
        meta: artifact.last_synced
          ? `last synced ${formatAdded(artifact.last_synced)}`
          : null,
        badge: null,
      };
    case 'slack_thread':
      return {
        Icon: MessageCircle,
        title: artifact.channel ? `Slack #${artifact.channel}` : 'Slack thread',
        url: artifact.permalink,
        meta: artifact.thread_ts ?? null,
        badge: null,
      };
    case 'gmail_draft':
      return {
        Icon: Mail,
        title: artifact.subject ?? `Gmail message ${artifact.message_id}`,
        url: `https://mail.google.com/mail/u/0/#all/${artifact.message_id}`,
        meta: artifact.thread_id ? `thread ${artifact.thread_id}` : null,
        badge: null,
      };
  }
}
