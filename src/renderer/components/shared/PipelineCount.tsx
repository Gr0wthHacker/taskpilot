import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/renderer/components/ui/card';
import { cn } from '@/renderer/lib/utils';

export type PipelineCountTone = 'default' | 'warning' | 'danger';

interface PipelineCountProps {
  label: string;
  count: number;
  icon: LucideIcon;
  tone?: PipelineCountTone;
}

const TONE_CLASSES: Record<PipelineCountTone, string> = {
  default: 'border-border',
  warning: 'border-amber-400/60 bg-amber-50/40 dark:bg-amber-950/20',
  danger: 'border-destructive/60 bg-destructive/5',
};

const ICON_CLASSES: Record<PipelineCountTone, string> = {
  default: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive',
};

export default function PipelineCount({
  label,
  count,
  icon: Icon,
  tone = 'default',
}: PipelineCountProps): JSX.Element {
  return (
    <Card
      className={cn('transition-colors', TONE_CLASSES[tone])}
      data-pipeline-count={label}
    >
      <CardContent className="flex items-center gap-3 p-4">
        <div className={cn('rounded-md bg-muted p-2', ICON_CLASSES[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          <div className="text-2xl font-semibold leading-tight">{count}</div>
        </div>
      </CardContent>
    </Card>
  );
}
