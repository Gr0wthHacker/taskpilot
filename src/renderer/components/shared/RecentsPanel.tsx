/**
 * "Where was I" resume panel. Renders the recently-viewed tasks from
 * {@link useRecentsStore} so the user can jump straight back into context
 * after an interruption. Renders nothing when there's no history.
 */

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { Clock, History, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import { useRecentsStore } from '@/renderer/store/recents';

function ago(iso: string): string {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

export function RecentsPanel(): JSX.Element | null {
  const navigate = useNavigate();
  const recents = useRecentsStore((s) => s.recents);
  const remove = useRecentsStore((s) => s.remove);
  const clear = useRecentsStore((s) => s.clear);

  if (recents.length === 0) return null;

  const [last, ...rest] = recents;
  if (!last) return null;

  return (
    <section
      className="rounded-md border border-border bg-card/40 p-3"
      aria-label="resume-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <History className="h-3.5 w-3.5" />
          Jump back in
        </div>
        <button
          type="button"
          onClick={clear}
          className="text-[11px] text-muted-foreground hover:underline"
          aria-label="resume-clear"
        >
          Clear
        </button>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={() => navigate(`/task/${last.id}`)}
        className="h-auto w-full justify-start gap-2 px-3 py-2 text-left"
        aria-label={`resume-last-${last.id}`}
      >
        <Clock className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {last.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {ago(last.viewedAt)}
        </span>
      </Button>

      {rest.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="resume-recent">
          {rest.map((r) => (
            <li key={r.id} className="group/recent flex items-center">
              <button
                type="button"
                onClick={() => navigate(`/task/${r.id}`)}
                className="max-w-[220px] truncate rounded-l-md border border-r-0 border-border bg-background px-2 py-1 text-xs hover:bg-accent"
                aria-label={`resume-recent-${r.id}`}
                title={r.title}
              >
                {r.title}
              </button>
              <button
                type="button"
                onClick={() => remove(r.id)}
                className="rounded-r-md border border-border bg-background px-1 py-1 text-muted-foreground hover:bg-accent"
                aria-label={`resume-remove-${r.id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
