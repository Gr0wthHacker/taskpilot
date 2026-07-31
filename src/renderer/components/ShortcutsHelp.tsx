/**
 * ShortcutsHelp — modal listing every global keyboard shortcut grouped by
 * category. Bound to `?` via the KeyboardShortcutsProvider and surfaced via
 * the "Show shortcuts" link in the sidebar footer.
 *
 * Mac vs. Windows/Linux adaptive: `⌘` glyphs swap to `Ctrl` based on the
 * `isMac()` helper from the hotkey engine. Keys are rendered as small
 * `<kbd>` chips for consistency with the command palette footer hint.
 */
import { useEffect } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { cn } from '@/renderer/lib/utils';
import { isMac } from '@/renderer/lib/hotkeys';

interface ShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutRow {
  /** Pre-formatted keys, e.g. `["⌘", "K"]` — each renders as its own chip. */
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

function buildGroups(mac: boolean): ShortcutGroup[] {
  const mod = mac ? '⌘' : 'Ctrl';
  return [
    {
      title: 'Global',
      rows: [
        { keys: [mod, 'K'], label: 'Open command palette' },
        { keys: ['?'], label: 'Show keyboard shortcuts' },
        { keys: ['N'], label: 'Create new task' },
        { keys: ['T'], label: 'Triage inbox (from Inbox)' },
        { keys: [mod, 'F'], label: 'Focus search on current view' },
        { keys: ['Esc'], label: 'Close any modal' },
      ],
    },
    {
      title: 'Navigation',
      rows: [
        { keys: ['G', 'I'], label: 'Go to Inbox' },
        { keys: ['G', 'B'], label: 'Go to Board' },
        { keys: ['G', 'R'], label: 'Go to Review' },
        { keys: ['G', 'W'], label: 'Go to Cowork' },
        { keys: ['G', 'C'], label: 'Go to Calendar' },
        { keys: ['G', 'P'], label: 'Go to Daily Plan' },
        { keys: ['G', 'D'], label: 'Go to I/O Dashboard' },
        { keys: ['G', 'T'], label: 'Go to Templates' },
        { keys: ['G', 'M'], label: 'Go to Import' },
        { keys: ['G', 'X'], label: 'Go to Reports' },
        { keys: ['G', 'A'], label: 'Go to Archive' },
        { keys: ['G', 'J'], label: 'Go to Projects' },
        { keys: ['G', 'S'], label: 'Go to Settings' },
        { keys: ['G', 'O'], label: 'Go to About' },
      ],
    },
    {
      title: 'Triage (inbox walkthrough)',
      rows: [
        { keys: ['1'], label: 'Set P0 + advance' },
        { keys: ['2'], label: 'Set P1 + advance' },
        { keys: ['3'], label: 'Set P2 + advance' },
        { keys: ['4'], label: 'Set P3 + advance' },
        { keys: ['↵'], label: 'Keep as-is + advance' },
        { keys: ['E'], label: 'Mark done' },
        { keys: ['R'], label: 'Request derivation' },
        { keys: ['W'], label: 'Move to workspace' },
        { keys: ['G'], label: 'Add a tag' },
        { keys: ['T'], label: 'Save as template' },
        { keys: ['A'], label: 'Archive (undo)' },
        { keys: ['D'], label: 'Delete (undo)' },
        { keys: ['/'], label: 'Search / jump in queue' },
        { keys: ['←'], label: 'Previous task' },
        { keys: ['→'], label: 'Next task' },
        { keys: ['Esc'], label: 'Exit triage' },
      ],
    },
    {
      title: 'Palette',
      rows: [
        { keys: ['↑', '↓'], label: 'Navigate results' },
        { keys: ['J', 'K'], label: 'Navigate results (vim)' },
        { keys: ['↵'], label: 'Run selected command' },
      ],
    },
  ];
}

function Kbd({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex items-center rounded border bg-muted px-1.5 text-xs font-mono',
      )}
    >
      {children}
    </kbd>
  );
}

export function ShortcutsHelp({
  open,
  onClose,
}: ShortcutsHelpProps): JSX.Element {
  const mac = isMac();
  const groups = buildGroups(mac);

  // Close on `?` when the dialog is open — Radix doesn't naturally handle
  // this and we want the toggle behavior. Esc is handled by Radix already.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === '?') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent aria-label="shortcuts-help" className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Move around without the mouse. Press <Kbd>Esc</Kbd> or{' '}
            <Kbd>?</Kbd> to close.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.title}>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {group.title}
              </div>
              <ul className="space-y-1.5">
                {group.rows.map((row) => (
                  <li
                    key={row.label}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>{row.label}</span>
                    <span className="flex items-center gap-1">
                      {row.keys.map((key, idx) => (
                        <Kbd key={`${row.label}-${idx}`}>{key}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-2 border-t border-border pt-3 text-xs text-muted-foreground">
          Power user? Try the command palette ({mac ? '⌘K' : 'Ctrl+K'}).
        </div>
      </DialogContent>
    </Dialog>
  );
}
