/**
 * Schedules view (`/schedules`).
 *
 * Surfaces every recurring schedule: name, cadence, next + last fire, the
 * goal it fans out across, and per-row controls (fire-now, toggle enabled,
 * delete with confirm). Schedules are configured via the API / MCP today;
 * an inline create form is intentionally out of scope for v1.
 *
 * When a schedule fires (manually here or via the minute-tick scheduler in
 * `@/main/schedules/scheduler`), tasks land in the inbox tagged with the
 * schedule lineage on `task.context.schedule_id`.
 */

import {
  CalendarClock,
  Play,
  Power,
  Repeat,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { EmptyState } from '@/renderer/components/shared/EmptyState';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useDeleteSchedule,
  useFireSchedule,
  useGoals,
  useSchedules,
  useUpdateSchedule,
  type RecurringSchedule,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Formatting helpers                                                        */
/* -------------------------------------------------------------------------- */

function formatCadence(s: RecurringSchedule): string {
  const n = s.recurrence_interval;
  const kind = s.recurrence_kind;
  if (n === 1) {
    if (kind === 'weekdays') return 'every weekday';
    return kind; // 'daily' | 'weekly' | 'monthly'
  }
  const plural: Record<string, string> = {
    daily: 'days',
    weekdays: 'weekdays',
    weekly: 'weeks',
    monthly: 'months',
  };
  return `every ${n} ${plural[kind] ?? kind}`;
}

function formatAbs(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRel(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const SEC = 1_000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  let value: number;
  let unit: string;
  if (abs < HOUR) {
    value = Math.round(abs / MIN);
    unit = 'min';
  } else if (abs < DAY) {
    value = Math.round(abs / HOUR);
    unit = 'hr';
  } else {
    value = Math.round(abs / DAY);
    unit = 'day';
  }
  if (value !== 1) unit += 's';
  return diff >= 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

function totalTasksPerFire(s: RecurringSchedule, repoCount: number): number {
  const slots = s.fan_out_goal_id ? Math.max(repoCount, 0) : 1;
  return slots * s.child_templates.length;
}

/* -------------------------------------------------------------------------- */
/*  Goal lookup                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Goal descriptions encode the repo list as Markdown bullets. Mirrors the
 * server-side `extractGoalRepos` so the UI can show "20 repos" without
 * needing a dedicated API call.
 */
function countReposInGoal(description: string | null): number {
  if (!description) return 0;
  let count = 0;
  for (const line of description.split(/\r?\n/)) {
    if (
      /^\s*[-*]\s+[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\s*$/.test(
        line,
      )
    ) {
      count += 1;
    }
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/*  Row component                                                              */
/* -------------------------------------------------------------------------- */

interface RowProps {
  schedule: RecurringSchedule;
  goalName: string | null;
  goalRepoCount: number;
  now: number;
  onFire: (id: string, name: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string, name: string) => void;
  isFiring: boolean;
  isToggling: boolean;
}

function ScheduleRow({
  schedule: s,
  goalName,
  goalRepoCount,
  now,
  onFire,
  onToggle,
  onDelete,
  isFiring,
  isToggling,
}: RowProps): JSX.Element {
  const overdue = Date.parse(s.next_fire_at) < now;
  const fanOutLabel = s.fan_out_goal_id
    ? `${goalRepoCount} repo${goalRepoCount === 1 ? '' : 's'} × ${s.child_templates.length} template${s.child_templates.length === 1 ? '' : 's'}`
    : `${s.child_templates.length} template${s.child_templates.length === 1 ? '' : 's'}`;
  const tasksPerFire = totalTasksPerFire(s, goalRepoCount);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-4',
        s.enabled ? 'border-border' : 'border-border/60 bg-muted/30',
      )}
      aria-label={`schedule-row-${s.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3
              className={cn(
                'text-sm font-semibold tracking-tight',
                !s.enabled && 'text-muted-foreground',
              )}
            >
              {s.name}
            </h3>
            {!s.enabled && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                Paused
              </span>
            )}
          </div>
          {s.description && (
            <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onFire(s.id, s.name)}
            disabled={isFiring}
            aria-label={`fire-${s.id}`}
            title={`Run now — creates ~${tasksPerFire} task${tasksPerFire === 1 ? '' : 's'}`}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {isFiring ? 'Firing…' : 'Fire now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onToggle(s.id, !s.enabled)}
            disabled={isToggling}
            aria-label={`toggle-${s.id}`}
            title={s.enabled ? 'Pause this schedule' : 'Resume this schedule'}
          >
            <Power className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onDelete(s.id, s.name)}
            aria-label={`delete-${s.id}`}
            title="Delete schedule"
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <Cell label="Cadence" value={formatCadence(s)} icon={Repeat} />
        <Cell
          label="Next fire"
          value={formatAbs(s.next_fire_at)}
          hint={formatRel(s.next_fire_at, now)}
          icon={CalendarClock}
          hintTone={overdue ? 'overdue' : 'muted'}
        />
        <Cell
          label="Last fire"
          value={formatAbs(s.last_fired_at)}
          hint={s.last_fired_at ? formatRel(s.last_fired_at, now) : '—'}
        />
        <Cell
          label="Fan-out"
          value={fanOutLabel}
          hint={
            goalName
              ? `→ ${goalName}`
              : s.fan_out_goal_id
                ? '(goal not found)'
                : 'no fan-out'
          }
        />
      </div>
    </div>
  );
}

function Cell({
  label,
  value,
  hint,
  icon: Icon,
  hintTone = 'muted',
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: typeof Repeat;
  hintTone?: 'muted' | 'overdue';
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </div>
      <div className="mt-0.5 truncate font-medium">{value}</div>
      {hint && (
        <div
          className={cn(
            'truncate text-[10px]',
            hintTone === 'overdue'
              ? 'font-medium text-amber-700 dark:text-amber-300'
              : 'text-muted-foreground',
          )}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  View                                                                      */
/* -------------------------------------------------------------------------- */

export default function Schedules(): JSX.Element {
  const schedulesQ = useSchedules();
  const goalsQ = useGoals();
  const fireM = useFireSchedule();
  const updateM = useUpdateSchedule();
  const deleteM = useDeleteSchedule();

  const [confirmDelete, setConfirmDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Refresh relative-time labels each minute so "in 5 days" doesn't go stale.
  useMemo(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const goalIndex = useMemo(() => {
    const m = new Map<string, { name: string; repoCount: number }>();
    for (const g of goalsQ.data?.goals ?? []) {
      m.set(g.id, {
        name: g.name,
        repoCount: countReposInGoal(g.description),
      });
    }
    return m;
  }, [goalsQ.data]);

  const schedules = schedulesQ.data?.schedules ?? [];

  const handleFire = (id: string, name: string): void => {
    fireM.mutate(
      { id },
      {
        onSuccess: (res) => {
          setToast(
            `Fired "${name}" — created ${res.created_task_ids.length}/${res.expected_count} tasks. Next fire ${formatAbs(res.next_fire_at)}.`,
          );
        },
        onError: (err) => {
          setToast(`Fire failed: ${err.message}`);
        },
      },
    );
  };

  const handleToggle = (id: string, enabled: boolean): void => {
    updateM.mutate({ id, patch: { enabled } });
  };

  const handleConfirmDelete = (): void => {
    if (!confirmDelete) return;
    const { id, name } = confirmDelete;
    deleteM.mutate(
      { id },
      {
        onSuccess: () => {
          setToast(`Deleted schedule "${name}".`);
          setConfirmDelete(null);
        },
        onError: (err) => {
          setToast(`Delete failed: ${err.message}`);
        },
      },
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Schedules"
        icon={CalendarClock}
        subtitle="Recurring rules that fan out into tasks on a wall-clock cadence."
        ariaLabel="schedules-view"
      />

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {toast && (
          <div
            className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
            role="status"
          >
            <div className="flex items-center justify-between gap-2">
              <span>{toast}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setToast(null)}
                aria-label="dismiss-toast"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {schedulesQ.isLoading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No schedules yet"
            description={
              <>
                Create one via the MCP tool{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  taskpilot_schedule_create
                </code>{' '}
                or{' '}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  POST /api/schedules
                </code>
                . An inline create form is coming.
              </>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {schedules.map((s) => {
              const goalInfo = s.fan_out_goal_id
                ? (goalIndex.get(s.fan_out_goal_id) ?? null)
                : null;
              return (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  goalName={goalInfo?.name ?? null}
                  goalRepoCount={goalInfo?.repoCount ?? 0}
                  now={now}
                  onFire={handleFire}
                  onToggle={handleToggle}
                  onDelete={(id, name) => setConfirmDelete({ id, name })}
                  isFiring={
                    fireM.isPending && fireM.variables?.id === s.id
                  }
                  isToggling={
                    updateM.isPending && updateM.variables?.id === s.id
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <DialogDescription>
              Deletes <strong>{confirmDelete?.name}</strong>. Tasks already
              created by previous fires stay in your inbox; only the schedule
              itself is removed. Can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmDelete(null)}
              disabled={deleteM.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteM.isPending}
            >
              {deleteM.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
