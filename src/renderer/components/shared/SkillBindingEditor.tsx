/**
 * Skill binding editor (Wave 12 intelligence layer).
 *
 * Lists every known Claude skill (built-ins + user-registered customs) and
 * lets the user toggle which ones are bound to the current task. Bound
 * skills are persisted at `task.context.skills`. Derive + execute requests
 * fold these into the instructions block under `---SKILLS---` and into the
 * `available_tools` array.
 *
 * The "Suggest" button calls the keyword-based ranker server-side and
 * auto-checks the top matches.
 */

import { Check, ChevronDown, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useSkills,
  useSuggestSkills,
  useTask,
  useUpdateTask,
} from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';
import type { SkillDescriptor } from '@/shared/types';

interface SkillBindingEditorProps {
  taskId: string;
  className?: string;
}

/**
 * Pull `task.context.skills` off the API response. Returns `[]` when the
 * task hasn't bound anything yet.
 */
function readBound(context: Record<string, unknown> | null): string[] {
  if (!context || typeof context !== 'object') return [];
  const raw = (context as Record<string, unknown>)['skills'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === 'string');
}

export function SkillBindingEditor({
  taskId,
  className,
}: SkillBindingEditorProps): JSX.Element {
  const { toast } = useToast();
  const taskQ = useTask(taskId);
  const skillsQ = useSkills();
  const updateTask = useUpdateTask();
  // Lazy suggest — only fire when the user clicks the button to avoid the
  // round trip on every detail-view load.
  const [suggestEnabled, setSuggestEnabled] = useState(false);
  const suggestQ = useSuggestSkills(taskId, suggestEnabled);

  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const task = taskQ.data?.task;
  const knownSkills: SkillDescriptor[] = skillsQ.data?.skills ?? [];
  const bound = useMemo(() => readBound(task?.context ?? null), [task]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return knownSkills;
    return knownSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [knownSkills, query]);

  // When suggestions come back, auto-merge them into the binding list.
  // The user can untick anything they didn't actually want.
  useEffect(() => {
    if (!suggestEnabled) return;
    if (!suggestQ.data) return;
    if (!task) return;
    const picked = suggestQ.data.skills.map((s) => s.name);
    if (picked.length === 0) return;
    const merged = Array.from(new Set([...bound, ...picked]));
    if (merged.length === bound.length) return;
    void persist(merged);
    // Reset the toggle so further re-mounts don't refetch endlessly.
    setSuggestEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestQ.data, suggestEnabled]);

  const persist = async (next: string[]): Promise<void> => {
    if (!task) return;
    const ctx =
      task.context && typeof task.context === 'object'
        ? (task.context as Record<string, unknown>)
        : {};
    const nextContext: Record<string, unknown> | null = (() => {
      if (next.length === 0) {
        const { skills: _omit, ...rest } = ctx;
        void _omit;
        return Object.keys(rest).length === 0 ? null : rest;
      }
      return { ...ctx, skills: next };
    })();
    try {
      await updateTask.mutateAsync({
        id: taskId,
        patch: { context: nextContext },
      });
    } catch (cause) {
      toast({
        title: 'Skill binding update failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const toggle = (name: string): void => {
    const set = new Set(bound);
    if (set.has(name)) set.delete(name);
    else set.add(name);
    void persist([...set]);
  };

  const handleSuggest = (): void => {
    setSuggestEnabled(true);
  };

  if (taskQ.isLoading || skillsQ.isLoading) {
    return (
      <div
        className={cn('text-xs text-muted-foreground', className)}
        aria-label="skill-binding-editor-loading"
      >
        Loading skills…
      </div>
    );
  }

  // Render bound skills as chips up top, then the picker below.
  const boundDescriptors = bound
    .map((name) => knownSkills.find((s) => s.name === name) ?? null)
    .filter((s): s is SkillDescriptor => s !== null);
  // Bound skills that aren't in the known catalog (e.g. user typoed an id or
  // imported from another machine). Surface them anyway so the user can
  // unbind from the UI.
  const orphanBound = bound.filter(
    (name) => !knownSkills.some((s) => s.name === name),
  );

  return (
    <div
      className={cn('flex flex-col gap-3', className)}
      aria-label="skill-binding-editor"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Bound skills ({bound.length})
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleSuggest}
            disabled={suggestQ.isFetching}
            aria-label="skill-binding-suggest"
          >
            <Wand2 className="mr-1 h-3.5 w-3.5" />
            {suggestQ.isFetching ? 'Suggesting…' : 'Suggest'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((s) => !s)}
            aria-label="skill-binding-toggle"
          >
            <ChevronDown
              className={cn(
                'mr-1 h-3.5 w-3.5 transition-transform',
                expanded && 'rotate-180',
              )}
            />
            {expanded ? 'Hide catalog' : 'Browse catalog'}
          </Button>
        </div>
      </div>

      {/* Bound chips ------------------------------------------------------ */}
      {bound.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] italic text-muted-foreground"
          aria-label="skill-binding-empty"
        >
          No skills bound. Hit "Suggest" or browse the catalog below.
        </div>
      ) : (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label="skill-binding-bound-list"
        >
          {boundDescriptors.map((s) => (
            <li
              key={s.name}
              className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
              aria-label={`skill-binding-bound-${s.name}`}
            >
              <Sparkles className="h-3 w-3" />
              <span>{s.label}</span>
              <button
                type="button"
                onClick={() => toggle(s.name)}
                className="rounded-sm hover:bg-secondary-foreground/10"
                aria-label={`skill-binding-remove-${s.name}`}
              >
                ×
              </button>
            </li>
          ))}
          {orphanBound.map((name) => (
            <li
              key={name}
              className="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2 py-0.5 text-xs"
              aria-label={`skill-binding-orphan-${name}`}
            >
              <span title="Skill not in known catalog">{name}</span>
              <button
                type="button"
                onClick={() => toggle(name)}
                className="rounded-sm hover:bg-amber-500/40"
                aria-label={`skill-binding-remove-${name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Catalog --------------------------------------------------------- */}
      {expanded && (
        <div
          className="rounded-md border border-border bg-muted/30 p-2"
          aria-label="skill-binding-catalog"
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="mb-2 h-8 text-xs"
            aria-label="skill-binding-search"
          />
          <ul
            className="max-h-72 space-y-1 overflow-auto"
            role="listbox"
            aria-label="skill-binding-catalog-list"
          >
            {filtered.map((s) => {
              const checked = bound.includes(s.name);
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    aria-label={`skill-binding-toggle-${s.name}`}
                    onClick={() => toggle(s.name)}
                    className={cn(
                      'flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent/40',
                      checked && 'bg-accent/30',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border',
                      )}
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <span className="flex-1">
                      <span className="font-medium">{s.label}</span>
                      {s.custom && (
                        <span className="ml-1 rounded bg-amber-500/30 px-1 text-[9px] uppercase tracking-wide">
                          custom
                        </span>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {s.name}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {s.description}
                      </div>
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-[11px] italic text-muted-foreground">
                No skills match.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
