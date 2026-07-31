/**
 * Onboarding step 2 — sample data.
 *
 * Lets the user choose between an empty start or seeding the DB with the
 * demo task set from `/api/onboarding/sample-data`. Either choice advances
 * the wizard; the sample-data fetch happens inline before the parent
 * advances so any error is shown right next to the radio.
 */

import { useState } from 'react';

import { api } from '@/renderer/lib/api';
import { useToast } from '@/renderer/components/ui/use-toast';
import { cn } from '@/renderer/lib/utils';

export type SampleDataChoice = 'empty' | 'sample';

export interface Step2SampleDataProps {
  choice: SampleDataChoice;
  onChoiceChange: (choice: SampleDataChoice) => void;
  /** Set to true while the parent waits for the sample-data POST to finish. */
  loading?: boolean;
  /** Bubble the busy state up so the parent can disable the Next button. */
  onLoadingChange?: (loading: boolean) => void;
  /** Called once the sample data is loaded (or skipped). */
  onLoaded?: (created: number) => void;
}

interface SampleDataResponse {
  created: number;
}

export default function Step2SampleData({
  choice,
  onChoiceChange,
  loading = false,
  onLoadingChange,
  onLoaded,
}: Step2SampleDataProps): JSX.Element {
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);

  const loadSampleData = async (): Promise<void> => {
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await api.post<SampleDataResponse>('/api/onboarding/sample-data');
      toast({
        title: 'Sample tasks loaded',
        description: `Created ${res.created} demo task${res.created === 1 ? '' : 's'}.`,
      });
      onLoaded?.(res.created);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sample data.';
      setError(message);
      toast({ title: 'Could not load sample tasks', description: message });
    } finally {
      onLoadingChange?.(false);
    }
  };

  return (
    <section aria-label="onboarding-step-2" className="space-y-6">
      <header className="space-y-2 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Start with sample data?</h2>
        <p className="text-sm text-muted-foreground">
          Five demo tasks give you something to play with on day one. You can
          archive or delete them whenever.
        </p>
      </header>

      <div role="radiogroup" aria-label="sample-data-choice" className="space-y-3">
        <Option
          selected={choice === 'empty'}
          onSelect={() => onChoiceChange('empty')}
          label="Start empty"
          description="A clean slate. Add tasks as they come."
        />
        <Option
          selected={choice === 'sample'}
          onSelect={() => onChoiceChange('sample')}
          label="Load sample tasks"
          description="Drop five recognizable demo tasks into the Inbox so you can explore the workflow."
        />
      </div>

      {choice === 'sample' && (
        <div className="flex items-center justify-center">
          <button
            type="button"
            onClick={loadSampleData}
            disabled={loading}
            className={cn(
              'rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          >
            {loading ? 'Loading…' : 'Load sample tasks now'}
          </button>
        </div>
      )}

      {error && (
        <p className="text-center text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Option — accessible radio-style card                                      */
/* -------------------------------------------------------------------------- */

interface OptionProps {
  selected: boolean;
  onSelect: () => void;
  label: string;
  description: string;
}

function Option({ selected, onSelect, label, description }: OptionProps): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border/60 hover:border-border hover:bg-accent/40',
      )}
    >
      <span
        className={cn(
          'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-primary' : 'border-muted-foreground/40',
        )}
        aria-hidden
      >
        {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
