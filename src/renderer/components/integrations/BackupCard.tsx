/**
 * Backup management card for Settings → Advanced.
 *
 * Surfaces the scheduled-backup status (next run + retention), a "Backup now"
 * button, and a table of recent snapshots with Restore + Delete actions.
 *
 * Restore returns 202 with `requires_restart: true`. Until the user quits and
 * relaunches TaskPilot, the in-process DB handle still points at the OLD file
 * (we renamed it to `.pre-restore`). The card surfaces a clear "Restart
 * TaskPilot" warning toast after a successful restore.
 */

import {
  AlertTriangle,
  Database,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

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
  useBackupsList,
  useBackupsStatus,
  useCreateBackup,
  useDeleteBackup,
  useRestoreBackup,
} from '@/renderer/lib/query';
import type { BackupSummary } from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return iso;
  const deltaMs = target - Date.now();
  const abs = Math.abs(deltaMs);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 1) return deltaMs >= 0 ? 'in <1 min' : 'just now';
  if (minutes < 60) return deltaMs >= 0 ? `in ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return deltaMs >= 0 ? `in ${hours} h` : `${hours} h ago`;
  const days = Math.round(hours / 24);
  return deltaMs >= 0 ? `in ${days} d` : `${days} d ago`;
}

/* -------------------------------------------------------------------------- */
/*  Retention setting (mini-hook, mirrors the pattern in Settings.tsx)        */
/* -------------------------------------------------------------------------- */

interface SettingResponse {
  value: string | null;
}

function useRetentionSetting(): {
  value: number;
  save: (next: number) => Promise<void>;
  saving: boolean;
} {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = 'backup_retention_count';
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
    mutationFn: async (next: number): Promise<void> => {
      await api.patch(`/api/settings/${encodeURIComponent(key)}`, {
        value: next,
      });
    },
    onSuccess: (_res, next) => {
      qc.setQueryData(['settings', key], { value: String(next) });
    },
    onError: (cause) => {
      toast({
        title: 'Couldn’t save retention',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const raw = settingQ.data?.value ?? null;
  const parsed = (() => {
    if (raw === null) return 14;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return 14;
    return Math.floor(n);
  })();

  return {
    value: parsed,
    saving: mutation.isPending,
    save: async (next: number) => {
      await mutation.mutateAsync(next);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

const RETENTION_OPTIONS = [7, 14, 30] as const;

export function BackupCard(): JSX.Element {
  const { toast } = useToast();
  const listQ = useBackupsList();
  const statusQ = useBackupsStatus();
  const createMut = useCreateBackup();
  const deleteMut = useDeleteBackup();
  const restoreMut = useRestoreBackup();
  const retention = useRetentionSetting();

  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const backups: BackupSummary[] = listQ.data?.backups ?? [];

  const nextRunLabel = useMemo(() => {
    const next = statusQ.data?.next_run_at;
    if (!next) return 'scheduled';
    return `${formatRelative(next)} (${formatDateTime(next)})`;
  }, [statusQ.data?.next_run_at]);

  // Periodically refresh the "next run" label so it doesn't go stale.
  // The query already polls every 30s, this just nudges the relative-time
  // formatter to recompute.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleBackupNow = async (): Promise<void> => {
    try {
      const res = await createMut.mutateAsync();
      toast({
        title: 'Backup created',
        description: `${res.backup.filename} (${formatBytes(res.backup.size_bytes)})`,
      });
    } catch (cause) {
      toast({
        title: 'Backup failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (filename: string): Promise<void> => {
    setConfirmDelete(null);
    try {
      await deleteMut.mutateAsync({ filename });
      toast({ title: 'Backup deleted', description: filename });
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleRestore = async (filename: string): Promise<void> => {
    setConfirmRestore(null);
    try {
      const res = await restoreMut.mutateAsync({ filename });
      toast({
        title: 'Restore complete — restart required',
        description: `Restored ${filename}. Your old DB is at ${res.pre_restore_path}. Quit and relaunch TaskPilot to load the restored data.`,
      });
    } catch (cause) {
      toast({
        title: 'Restore failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div
      className="rounded-md border border-border bg-background/40"
      aria-label="settings-backup-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Database className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Database backups</div>
          <div className="text-xs text-muted-foreground">
            Daily snapshot of <code>taskpilot.db</code> with rotation. Next
            backup: <span aria-label="backup-next-run">{nextRunLabel}</span>.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void listQ.refetch();
            void statusQ.refetch();
          }}
          disabled={listQ.isFetching}
          aria-label="settings-backup-refresh"
        >
          <RefreshCw
            className={listQ.isFetching ? 'mr-1 h-4 w-4 animate-spin' : 'mr-1 h-4 w-4'}
          />
          Refresh
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void handleBackupNow();
          }}
          disabled={createMut.isPending}
          aria-label="settings-backup-now"
        >
          {createMut.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-1 h-4 w-4" />
          )}
          Backup now
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <SettingRow
          label="Retention"
          description="Number of recent backups to keep on disk. Older snapshots are rotated out automatically."
        >
          <Select
            value={String(retention.value)}
            onValueChange={(v) => {
              void retention.save(Number(v));
            }}
          >
            <SelectTrigger
              className="w-[140px]"
              aria-label="settings-backup-retention"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETENTION_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <div className="rounded-md border border-border/60">
          <table className="w-full text-xs" aria-label="settings-backup-table">
            <thead>
              <tr className="border-b border-border/60 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Filename</th>
                <th className="px-3 py-2 text-right font-medium">Size</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-4 text-center text-muted-foreground"
                  >
                    No backups yet. The first snapshot runs a few seconds after
                    launch.
                  </td>
                </tr>
              ) : (
                backups.map((b) => (
                  <tr
                    key={b.filename}
                    className="border-b border-border/30 last:border-b-0"
                    aria-label={`settings-backup-row-${b.filename}`}
                  >
                    <td className="px-3 py-2 align-middle">
                      {formatDateTime(b.created_at)}
                    </td>
                    <td className="px-3 py-2 align-middle font-mono">
                      {b.filename}
                    </td>
                    <td className="px-3 py-2 text-right align-middle font-mono">
                      {formatBytes(b.size_bytes)}
                    </td>
                    <td className="px-3 py-2 text-right align-middle">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setConfirmRestore(b.filename)}
                          aria-label={`settings-backup-restore-${b.filename}`}
                        >
                          <Undo2 className="mr-1 h-3.5 w-3.5" />
                          Restore
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(b.filename)}
                          aria-label={`settings-backup-delete-${b.filename}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={confirmRestore !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRestore(null);
        }}
      >
        <DialogContent aria-label="settings-backup-restore-dialog">
          <DialogHeader>
            <DialogTitle>Restore this backup?</DialogTitle>
            <DialogDescription>
              Your current database will be renamed to{' '}
              <code>taskpilot.db.pre-restore</code> (keeping it safe) and the
              backup will be copied into place. You'll need to quit and
              relaunch TaskPilot for the restore to take effect.
            </DialogDescription>
          </DialogHeader>
          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-100"
            aria-label="settings-backup-restart-warning"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              TaskPilot will keep running on the OLD database until you
              restart. Quit and relaunch as soon as restore completes.
            </span>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmRestore(null)}
              aria-label="settings-backup-restore-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (confirmRestore) void handleRestore(confirmRestore);
              }}
              disabled={restoreMut.isPending}
              aria-label="settings-backup-restore-confirm"
            >
              {restoreMut.isPending ? 'Restoring…' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
      >
        <DialogContent aria-label="settings-backup-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete this backup?</DialogTitle>
            <DialogDescription>
              The file will be removed from disk. You cannot recover it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(null)}
              aria-label="settings-backup-delete-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (confirmDelete) void handleDelete(confirmDelete);
              }}
              disabled={deleteMut.isPending}
              aria-label="settings-backup-delete-confirm"
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
