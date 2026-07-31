/**
 * SmartDueInput — natural-language due-date input with inline confirmation.
 *
 * Wraps a plain text input plus the `parseDue` parser. As the user types we
 * show what we interpreted underneath ("parsed as: Friday, Dec 25 at 9am").
 * On blur (or `confirm()` from a parent) the parser's Date is converted to
 * an ISO string and surfaced through `onChange`.
 *
 * Falls back gracefully — when input is empty `onChange(null)` fires;
 * unparseable input is held in the local string state and the preview row
 * surfaces a hint without firing the callback, so the parent's stored value
 * doesn't drift.
 *
 * The component also accepts an `isoValue` prop so the parent can seed it
 * from an existing task; we render the ISO as the friendly preview rather
 * than the raw machine string when no draft input has been typed yet.
 */

import { CalendarClock, CircleAlert, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { formatDuePreview, parseDue } from '@/renderer/lib/parse-due';
import { cn } from '@/renderer/lib/utils';

interface SmartDueInputProps {
  /** ISO string from the parent. Used to seed and re-sync the visible label. */
  isoValue: string | null;
  /**
   * Fires with the new ISO string when parsing succeeds, or `null` when the
   * user clears the field. Unparseable input is held locally — the parent
   * sees nothing until the user types something we recognize.
   */
  onChange: (next: string | null) => void;
  /** Optional label rendered above the input. */
  label?: string;
  /** Optional id wired onto the input. */
  id?: string;
  /** Override the input's aria-label. */
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

export function SmartDueInput({
  isoValue,
  onChange,
  label,
  id,
  ariaLabel = 'smart-due-input',
  placeholder = 'e.g. tomorrow at 3pm, next monday, 12/25',
  className,
  autoFocus,
}: SmartDueInputProps): JSX.Element {
  const [draft, setDraft] = useState<string>('');
  // Tracks whether the user has typed something since mount/last reset, so we
  // know whether to show the seed preview or the live parse.
  const [touched, setTouched] = useState(false);

  // Whenever the parent swaps the ISO out from under us (e.g. dialog reopens)
  // reset our draft so the seed preview shows again.
  useEffect(() => {
    setDraft('');
    setTouched(false);
  }, [isoValue]);

  const parsedFromDraft = useMemo(() => {
    if (!touched) return null;
    return parseDue(draft);
  }, [draft, touched]);

  const seedDate = useMemo(() => {
    if (!isoValue) return null;
    const d = new Date(isoValue);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [isoValue]);

  // Decide what the preview row shows. Three states:
  //  1) user has typed and we successfully parsed → green confirmation
  //  2) user has typed but parser failed (and text is non-empty) → amber hint
  //  3) user hasn't typed yet → render the seed (or "no date set")
  let previewNode: JSX.Element;
  let previewVariant: 'ok' | 'warn' | 'neutral' = 'neutral';
  if (touched && draft.trim().length === 0) {
    previewNode = (
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3" aria-hidden="true" />
        No due date.
      </span>
    );
    previewVariant = 'neutral';
  } else if (parsedFromDraft?.parsed) {
    previewVariant = 'ok';
    previewNode = (
      <span className="inline-flex items-center gap-1">
        <Sparkles className="h-3 w-3" aria-hidden="true" />
        Parsed as <strong>{formatDuePreview(parsedFromDraft.parsed)}</strong>
      </span>
    );
  } else if (parsedFromDraft && draft.trim().length > 0) {
    previewVariant = 'warn';
    previewNode = (
      <span className="inline-flex items-center gap-1">
        <CircleAlert className="h-3 w-3" aria-hidden="true" />
        Didn’t recognize that phrase — try "tomorrow", "next monday", "12/25".
      </span>
    );
  } else if (seedDate) {
    previewVariant = 'ok';
    previewNode = (
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3" aria-hidden="true" />
        {formatDuePreview(seedDate)}
      </span>
    );
  } else {
    previewNode = (
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3" aria-hidden="true" />
        Optional — leave blank for no due date.
      </span>
    );
  }

  const handleChange = (next: string): void => {
    setTouched(true);
    setDraft(next);
  };

  const commit = (): void => {
    if (!touched) return;
    if (draft.trim().length === 0) {
      onChange(null);
      return;
    }
    const result = parseDue(draft);
    if (result.parsed) {
      onChange(result.parsed.toISOString());
    }
    // Otherwise: keep the parent's existing value, just hold the bad draft
    // so the user can fix it. (No onChange fired.)
  };

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        value={touched ? draft : seedDate ? formatDuePreview(seedDate) : ''}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => {
          // When the field hasn't been touched yet, focusing should let the
          // user start typing fresh — clear the seed text.
          if (!touched) {
            setTouched(true);
            setDraft('');
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
      />
      <div
        className={cn(
          'flex items-center gap-1 text-[11px]',
          previewVariant === 'ok' && 'text-emerald-700 dark:text-emerald-300',
          previewVariant === 'warn' && 'text-amber-700 dark:text-amber-300',
          previewVariant === 'neutral' && 'text-muted-foreground',
        )}
        aria-label="smart-due-preview"
        aria-live="polite"
      >
        {previewNode}
      </div>
    </div>
  );
}

export default SmartDueInput;
