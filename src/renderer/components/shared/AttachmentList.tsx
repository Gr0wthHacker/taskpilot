/**
 * Attachment list (Wave 13).
 *
 * Renders the files a task has uploaded, with a download link and a delete
 * button per row. Designed to slot into TaskDetail alongside the
 * `AttachmentDrop` zone — they share React Query state via the
 * `useTaskAttachments` hook, so a successful upload triggers a re-render
 * without manual wiring.
 */

import { Download, FileText, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';
import {
  useDeleteAttachment,
  useTaskAttachments,
} from '@/renderer/lib/query';
import { apiUrl, resolveApiToken } from '@/renderer/lib/api';
import type { Attachment } from '@/shared/types';

export interface AttachmentListProps {
  taskId: string;
  className?: string;
  /** When true, the delete control is hidden — used in read-only contexts. */
  readOnly?: boolean;
}

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

async function downloadAttachment(
  taskId: string,
  attachment: Attachment,
): Promise<void> {
  const url = await apiUrl(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.filename)}`,
  );
  const token = await resolveApiToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status})`);
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = attachment.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Defer revocation so the click has time to start the download in
  // every renderer (Chromium needs the URL alive for a tick).
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function AttachmentList({
  taskId,
  className,
  readOnly,
}: AttachmentListProps): JSX.Element {
  const { toast } = useToast();
  const listQ = useTaskAttachments(taskId);
  const deleteAttachment = useDeleteAttachment();

  if (listQ.isLoading) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 text-xs text-muted-foreground',
          className,
        )}
        aria-label={`attachment-list-${taskId}`}
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading attachments…
      </div>
    );
  }

  const attachments = listQ.data?.attachments ?? [];
  if (attachments.length === 0) {
    return (
      <div
        className={cn(
          'rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground',
          className,
        )}
        aria-label={`attachment-list-${taskId}`}
      >
        No attachments yet.
      </div>
    );
  }

  const handleDownload = async (att: Attachment): Promise<void> => {
    try {
      await downloadAttachment(taskId, att);
    } catch (err) {
      toast({
        title: 'Download failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (att: Attachment): Promise<void> => {
    try {
      await deleteAttachment.mutateAsync({
        task_id: taskId,
        filename: att.filename,
      });
      toast({ title: 'Attachment removed', description: att.filename });
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  };

  return (
    <ul
      className={cn('flex flex-col divide-y divide-border rounded-md border', className)}
      aria-label={`attachment-list-${taskId}`}
    >
      {attachments.map((att) => (
        <li
          key={att.filename}
          aria-label={`attachment-row-${att.filename}`}
          className="flex items-center justify-between gap-3 px-3 py-2"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileText
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <div className="truncate text-sm" title={att.filename}>
                {att.filename}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {formatBytes(att.size_bytes)} ·{' '}
                <span title={att.added_at}>{formatAdded(att.added_at)}</span>
                {att.content_type && att.content_type !== 'application/octet-stream'
                  ? ` · ${att.content_type}`
                  : ''}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void handleDownload(att);
              }}
              aria-label={`attachment-download-${att.filename}`}
              title="Download"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            {!readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void handleDelete(att);
                }}
                disabled={deleteAttachment.isPending}
                aria-label={`attachment-delete-${att.filename}`}
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
