/**
 * SnoozeButton — drop into a TaskCard `actions` slot (or anywhere) to defer a
 * task until later. Offers quick presets plus a custom date, and flips to a
 * "wake now" action once the task is already snoozed.
 *
 * Writes through {@link useSnoozeTask}, which stores the timestamp under
 * `task.context.snoozed_until`.
 */

import { BellOff, BellRing } from 'lucide-react';
import { useState } from 'react';

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { SmartDueInput } from '@/renderer/components/shared/SmartDueInput';
import { useToast } from '@/renderer/components/ui/use-toast';
import { useSnoozeTask } from '@/renderer/lib/query';
import { SNOOZE_PRESETS, isSnoozed } from '@/renderer/lib/snooze';
import type { Task } from '@/shared/types';

interface SnoozeButtonProps {
  task: Task;
  /** Render as a compact icon button (card actions) vs. a labeled button. */
  iconOnly?: boolean;
}

export function SnoozeButton({
  task,
  iconOnly = true,
}: SnoozeButtonProps): JSX.Element {
  const snooze = useSnoozeTask();
  const { toast } = useToast();
  const [customOpen, setCustomOpen] = useState(false);
  const [customIso, setCustomIso] = useState<string | null>(null);
  const snoozed = isSnoozed(task);

  const apply = async (until: string | null): Promise<void> => {
    try {
      await snooze.mutateAsync({ task, until });
      toast({
        title: until ? 'Snoozed' : 'Back in your lists',
        description: task.title,
      });
    } catch (cause) {
      toast({
        title: 'Snooze failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size={iconOnly ? 'icon' : 'sm'}
            variant="ghost"
            className={iconOnly ? 'h-7 w-7' : 'h-7 px-2 text-xs'}
            disabled={snooze.isPending}
            aria-label={`snooze-${task.id}`}
            data-card-action
          >
            {snoozed ? (
              <BellRing className="h-3.5 w-3.5" />
            ) : (
              <BellOff className="h-3.5 w-3.5" />
            )}
            {!iconOnly && <span className="ml-1">Snooze</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {snoozed && (
            <>
              <DropdownMenuItem
                onClick={() => {
                  void apply(null);
                }}
                aria-label={`snooze-wake-${task.id}`}
              >
                <BellRing className="mr-2 h-4 w-4" />
                Wake now
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {SNOOZE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.key}
              onClick={() => {
                void apply(preset.resolve(new Date()).toISOString());
              }}
              aria-label={`snooze-${preset.key}-${task.id}`}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setCustomIso(null);
              setCustomOpen(true);
            }}
            aria-label={`snooze-custom-${task.id}`}
          >
            Pick a date…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent
          aria-label="snooze-custom-dialog"
          className="sm:max-w-[420px]"
        >
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>
              Hide this task from your lists until the chosen time.
            </DialogDescription>
          </DialogHeader>
          <SmartDueInput
            isoValue={customIso}
            onChange={setCustomIso}
            label="Wake at"
            ariaLabel="snooze-custom-input"
            autoFocus
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCustomOpen(false)}
              aria-label="snooze-custom-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={customIso === null || snooze.isPending}
              onClick={() => {
                setCustomOpen(false);
                void apply(customIso);
              }}
              aria-label="snooze-custom-apply"
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
