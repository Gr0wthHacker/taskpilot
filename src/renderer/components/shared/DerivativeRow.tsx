import { Trash2 } from 'lucide-react';
import type { AgentMethod, DerivativeProposal } from '@/shared/types';
import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Label } from '@/renderer/components/ui/label';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { cn } from '@/renderer/lib/utils';

/**
 * Classification mirrors the PRD's three buckets. It is derived from
 * `review_required` + `agent_executable`:
 *  - auto       → executable, no review required
 *  - review     → executable, but review_required = true
 *  - human_only → not agent_executable
 */
export type DerivativeClassification = 'auto' | 'review' | 'human_only';

/**
 * Form-local shape. We carry `classification` as an explicit field so the user
 * (or Cowork) can edit it directly via a select. On submit it is projected
 * back into the wire-shape `DerivativeProposal` by the parent.
 */
export interface DerivativeFormValue {
  title: string;
  classification: DerivativeClassification;
  agent_method: AgentMethod;
  agent_instructions: string;
  estimated_minutes: number;
  depends_on: string[];
}

export function classificationFromProposal(
  p: DerivativeProposal,
): DerivativeClassification {
  if (!p.agent_executable) return 'human_only';
  if (p.review_required) return 'review';
  return 'auto';
}

export function proposalFromForm(v: DerivativeFormValue): DerivativeProposal {
  const agent_executable = v.classification !== 'human_only';
  const review_required = v.classification === 'review';
  return {
    title: v.title,
    agent_executable,
    agent_method: v.agent_method,
    agent_instructions: v.agent_instructions.trim() === '' ? null : v.agent_instructions,
    estimated_minutes: Number.isFinite(v.estimated_minutes) ? v.estimated_minutes : 0,
    depends_on: v.depends_on,
    review_required,
  };
}

export function emptyDerivative(): DerivativeFormValue {
  return {
    title: '',
    classification: 'auto',
    agent_method: 'either',
    agent_instructions: '',
    estimated_minutes: 15,
    depends_on: [],
  };
}

const CLASSIFICATION_TONE: Record<DerivativeClassification | 'unclassified', string> = {
  auto: 'border-l-green-500',
  review: 'border-l-blue-500',
  human_only: 'border-l-orange-500',
  unclassified: 'border-l-zinc-400',
};

interface DerivativeRowProps {
  index: number;
  value: DerivativeFormValue;
  onChange: (next: DerivativeFormValue) => void;
  onRemove: () => void;
  availableDeps: string[];
}

export default function DerivativeRow({
  index,
  value,
  onChange,
  onRemove,
  availableDeps,
}: DerivativeRowProps): JSX.Element {
  const tone =
    value.title.trim() === ''
      ? CLASSIFICATION_TONE.unclassified
      : CLASSIFICATION_TONE[value.classification];

  function toggleDep(dep: string): void {
    const set = new Set(value.depends_on);
    if (set.has(dep)) set.delete(dep);
    else set.add(dep);
    onChange({ ...value, depends_on: Array.from(set) });
  }

  return (
    <fieldset
      className={cn(
        'space-y-3 rounded-md border border-l-4 bg-card p-4 shadow-sm',
        tone,
      )}
      data-derivative-index={index}
    >
      <legend className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Derivative {index + 1}
      </legend>

      <div className="space-y-1.5">
        <Label htmlFor={`derivative-${index}-title`}>Title</Label>
        <Input
          id={`derivative-${index}-title`}
          aria-label={`derivative-${index}-title`}
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="What needs to happen?"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`derivative-${index}-classification`}>Classification</Label>
          <Select
            value={value.classification}
            onValueChange={(next) =>
              onChange({
                ...value,
                classification: next as DerivativeClassification,
              })
            }
          >
            <SelectTrigger
              id={`derivative-${index}-classification`}
              aria-label={`derivative-${index}-classification`}
            >
              <SelectValue placeholder="Classification" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto (no review)</SelectItem>
              <SelectItem value="review">Review required</SelectItem>
              <SelectItem value="human_only">Human only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`derivative-${index}-method`}>Method</Label>
          <Select
            value={value.agent_method}
            onValueChange={(next) =>
              onChange({ ...value, agent_method: next as AgentMethod })
            }
          >
            <SelectTrigger
              id={`derivative-${index}-method`}
              aria-label={`derivative-${index}-method`}
            >
              <SelectValue placeholder="Method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cowork">Cowork (browser)</SelectItem>
              <SelectItem value="cli">CLI / Claude Code</SelectItem>
              <SelectItem value="either">Either</SelectItem>
              <SelectItem value="human_only">Human only</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`derivative-${index}-instructions`}>Instructions</Label>
        <Textarea
          id={`derivative-${index}-instructions`}
          aria-label={`derivative-${index}-instructions`}
          value={value.agent_instructions}
          onChange={(e) => onChange({ ...value, agent_instructions: e.target.value })}
          placeholder="Plain-English directions Claude can act on."
          className="min-h-[88px]"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`derivative-${index}-minutes`}>Estimated minutes</Label>
          <Input
            id={`derivative-${index}-minutes`}
            aria-label={`derivative-${index}-minutes`}
            type="number"
            min={0}
            step={5}
            value={Number.isFinite(value.estimated_minutes) ? value.estimated_minutes : 0}
            onChange={(e) =>
              onChange({
                ...value,
                estimated_minutes: e.target.value === '' ? 0 : Number(e.target.value),
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`derivative-${index}-depends_on`}>Depends on</Label>
          <div
            id={`derivative-${index}-depends_on`}
            aria-label={`derivative-${index}-depends_on`}
            role="group"
            className="flex max-h-24 flex-wrap gap-1 overflow-auto rounded-md border border-input bg-transparent p-2"
          >
            {availableDeps.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                No prior derivatives available.
              </span>
            ) : (
              availableDeps.map((dep) => {
                const active = value.depends_on.includes(dep);
                return (
                  <button
                    key={dep}
                    type="button"
                    onClick={() => toggleDep(dep)}
                    aria-pressed={active}
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-xs transition-colors',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {dep || '(untitled)'}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          aria-label={`derivative-${index}-remove`}
        >
          <Trash2 className="h-4 w-4" />
          Remove
        </Button>
      </div>
    </fieldset>
  );
}
