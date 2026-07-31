/**
 * Chip-based tag editor. Backed by a string array. The user types, then
 * presses Enter or comma to commit. Backspace on empty input removes the
 * last chip.
 */

import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import { Input } from '@/renderer/components/ui/input';
import { cn } from '@/renderer/lib/utils';

interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

function normalize(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase();
}

export function TagInput({
  value,
  onChange,
  placeholder = 'Add tag…',
  disabled,
  className,
  ariaLabel,
}: TagInputProps): JSX.Element {
  const [draft, setDraft] = useState('');

  const commit = (raw: string): void => {
    const normalized = normalize(raw);
    if (normalized.length === 0) return;
    if (value.includes(normalized)) {
      setDraft('');
      return;
    }
    onChange([...value, normalized]);
    setDraft('');
  };

  const remove = (tag: string): void => {
    onChange(value.filter((t) => t !== tag));
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (draft.trim().length === 0) return;
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Backspace' && draft.length === 0 && value.length > 0) {
      e.preventDefault();
      remove(value[value.length - 1] as string);
    }
  };

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm focus-within:ring-1 focus-within:ring-ring',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
      aria-label={ariaLabel ?? 'tag-input'}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
          aria-label={`tag-chip-${tag}`}
        >
          #{tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => remove(tag)}
              className="rounded-sm hover:bg-secondary-foreground/10"
              aria-label={`remove-tag-${tag}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          if (draft.trim().length > 0) commit(draft);
        }}
        placeholder={value.length === 0 ? placeholder : ''}
        disabled={disabled}
        className="h-7 min-w-[80px] flex-1 border-0 px-1 shadow-none focus-visible:ring-0"
        aria-label="tag-input-text"
      />
    </div>
  );
}
