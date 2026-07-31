/**
 * Drag-and-drop attachment uploader (Wave 13).
 *
 * Lets the user drop files onto a task to upload them via
 * `POST /api/tasks/:id/attachments`. Falls back to a hidden file picker
 * triggered by the visible button so keyboard / a11y still works.
 *
 * Validates per-file size client-side before uploading so the user gets
 * immediate feedback rather than waiting for the 413 round trip. The
 * server still enforces the same limits authoritatively.
 *
 * The component is uncontrolled — uploads call `onUploaded(attachments)`
 * with the saved metadata so the parent can refresh its view. We do NOT
 * own React Query invalidation here; the parent (TaskDetail, etc.) does.
 */

import { Loader2, Paperclip, Upload } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';
import { apiUrl, resolveApiToken } from '@/renderer/lib/api';
import { useInvalidateTaskAttachments } from '@/renderer/lib/query';
import type { Attachment } from '@/shared/types';

export interface AttachmentDropProps {
  taskId: string;
  className?: string;
  /** Soft client-side cap per file. Mirrors the server default (50 MB). */
  maxFileBytes?: number;
  /** Fired after every successful upload batch with the saved metadata. */
  onUploaded?: (attachments: Attachment[]) => void;
  /** Optional render override for the dropzone label. */
  label?: string;
  /** Compact mode — used by NewTaskDialog where vertical space is tight. */
  compact?: boolean;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AttachmentDrop({
  taskId,
  className,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  onUploaded,
  label,
  compact,
}: AttachmentDropProps): JSX.Element {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const invalidateAttachments = useInvalidateTaskAttachments();

  const upload = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      // Client-side size guard so the user sees a quick reject. Server
      // still enforces the canonical limit (configurable via settings).
      const oversize = files.find((f) => f.size > maxFileBytes);
      if (oversize) {
        toast({
          title: 'File too large',
          description: `${oversize.name} is ${formatBytes(oversize.size)}; limit is ${formatBytes(maxFileBytes)}.`,
          variant: 'destructive',
        });
        return;
      }

      setUploading(true);
      try {
        const form = new FormData();
        for (const file of files) {
          form.append('file', file, file.name);
        }
        const url = await apiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
        );
        const token = await resolveApiToken();
        const headers: Record<string, string> = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: form,
        });
        if (!response.ok) {
          let detail = `${response.status}`;
          try {
            const body = (await response.json()) as {
              error?: { message?: string };
            };
            detail = body?.error?.message ?? detail;
          } catch {
            /* non-JSON body */
          }
          toast({
            title: 'Upload failed',
            description: detail,
            variant: 'destructive',
          });
          return;
        }
        const body = (await response.json()) as {
          ok: boolean;
          attachments: Attachment[];
        };
        toast({
          title:
            body.attachments.length === 1
              ? `Attached ${body.attachments[0]?.filename ?? 'file'}`
              : `Attached ${body.attachments.length} files`,
        });
        invalidateAttachments(taskId);
        onUploaded?.(body.attachments);
      } catch (err) {
        toast({
          title: 'Upload failed',
          description: err instanceof Error ? err.message : 'Network error',
          variant: 'destructive',
        });
      } finally {
        setUploading(false);
      }
    },
    [taskId, maxFileBytes, onUploaded, toast, invalidateAttachments],
  );

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    void upload(files);
  };

  const handlePickerChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    const files = Array.from(e.target.files ?? []);
    void upload(files);
    // Reset so the same file can be picked twice in a row if desired.
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only clear on a leave that actually exits the drop zone — Drop
        // events bubble up from children and re-trigger dragenter.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={handleDrop}
      aria-label={`attachment-drop-${taskId}`}
      className={cn(
        'group flex flex-col items-center justify-center gap-2 rounded-md border border-dashed text-sm transition-colors',
        compact ? 'px-3 py-3' : 'px-4 py-6',
        dragging
          ? 'border-primary bg-primary/5 text-primary'
          : 'border-border bg-card/50 text-muted-foreground',
        className,
      )}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={handlePickerChange}
        aria-label={`attachment-file-input-${taskId}`}
      />
      <div className="flex items-center gap-2">
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="h-4 w-4" aria-hidden="true" />
        )}
        <span>
          {uploading
            ? 'Uploading…'
            : (label ??
              (compact
                ? 'Drop files here'
                : 'Drag files here, or pick from your computer'))}
        </span>
      </div>
      {!compact && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          aria-label={`attachment-pick-${taskId}`}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          Choose files
        </Button>
      )}
      {!compact && (
        <div className="text-[11px] text-muted-foreground/80">
          Up to {formatBytes(maxFileBytes)} per file.
        </div>
      )}
    </div>
  );
}
