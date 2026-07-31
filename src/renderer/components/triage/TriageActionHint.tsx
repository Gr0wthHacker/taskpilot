/**
 * TriageActionHint — the keyboard cheat-sheet footer shown beneath the triage
 * card. Each hint is a clickable chip so the mode is usable without a keyboard
 * too; clicking fires the same handler the key would.
 *
 * Every chip carries `aria-label="triage-action-<key>"` so Cowork (and the
 * test suite) can target individual actions deterministically.
 */

import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CornerDownLeft,
  FileText,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Layers,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/renderer/lib/utils';

/** Stable identifier for each triage key, used for the click callback + aria. */
export type TriageHintKey =
  | '1'
  | '2'
  | '3'
  | '4'
  | 'd'
  | 'a'
  | 't'
  | 'r'
  | 'e'
  | 'w'
  | 'g'
  | '/'
  | 'enter'
  | 'left'
  | 'right';

interface HintDef {
  key: TriageHintKey;
  /** Display glyph shown in the kbd chip. */
  glyph: string;
  label: string;
  icon?: LucideIcon;
  /** Visual emphasis bucket for grouping/coloring. */
  tone?: 'default' | 'danger' | 'nav';
}

const HINTS: HintDef[] = [
  { key: '1', glyph: '1', label: 'P0' },
  { key: '2', glyph: '2', label: 'P1' },
  { key: '3', glyph: '3', label: 'P2' },
  { key: '4', glyph: '4', label: 'P3' },
  { key: 'enter', glyph: '↵', label: 'Keep', icon: CornerDownLeft },
  { key: 'e', glyph: 'E', label: 'Done', icon: CheckCircle2 },
  { key: 'r', glyph: 'R', label: 'Derive', icon: Sparkles },
  { key: 'w', glyph: 'W', label: 'Workspace', icon: Layers },
  { key: 'g', glyph: 'G', label: 'Tag', icon: Tag },
  { key: 't', glyph: 'T', label: 'Template', icon: FileText },
  { key: 'a', glyph: 'A', label: 'Archive', icon: Archive },
  { key: 'd', glyph: 'D', label: 'Delete', icon: Trash2, tone: 'danger' },
  { key: '/', glyph: '/', label: 'Search', icon: Search, tone: 'nav' },
  { key: 'left', glyph: '←', label: 'Prev', icon: ArrowLeft, tone: 'nav' },
  { key: 'right', glyph: '→', label: 'Next', icon: ArrowRight, tone: 'nav' },
];

interface TriageActionHintProps {
  /** Fired when a chip is clicked — same effect as pressing the key. */
  onAction: (key: TriageHintKey) => void;
  /** Disable interaction while an action is mid-flight. */
  disabled?: boolean;
}

export function TriageActionHint({
  onAction,
  disabled,
}: TriageActionHintProps): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-1.5"
      aria-label="triage-action-hint"
    >
      {HINTS.map((hint) => {
        const Icon = hint.icon;
        return (
          <button
            key={hint.key}
            type="button"
            disabled={disabled}
            onClick={() => onAction(hint.key)}
            aria-label={`triage-action-${hint.key}`}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
              'hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50',
              hint.tone === 'danger' &&
                'border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800 dark:border-red-900/40 dark:text-red-300 dark:hover:bg-red-950/30',
              hint.tone === 'nav' && 'text-muted-foreground',
              (!hint.tone || hint.tone === 'default') && 'border-border',
            )}
          >
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px] leading-tight text-muted-foreground">
              {hint.glyph}
            </kbd>
            {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
            <span>{hint.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default TriageActionHint;
