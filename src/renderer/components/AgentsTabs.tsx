/**
 * Tab strip for the Agents hub. Renders at the top of the four agent-facing
 * surfaces (Mission Control / Review / Cowork / I/O) so they read as one hub
 * reached from a single sidebar entry, rather than four separate destinations.
 *
 * Each view keeps its own header below this strip; the strip only handles
 * cross-surface navigation and carries the "needs attention" counts.
 */

import { Eye, FolderTree, Gauge, UserSquare } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { useCoworkQueue, useReviewQueue } from '@/renderer/lib/query';
import { cn } from '@/renderer/lib/utils';

type BadgeSource = 'review' | 'cowork' | null;

interface AgentTab {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge: BadgeSource;
}

const TABS: AgentTab[] = [
  { to: '/agents', label: 'Live', icon: Gauge, badge: null },
  { to: '/review', label: 'Review', icon: Eye, badge: 'review' },
  { to: '/cowork', label: 'Cowork', icon: UserSquare, badge: 'cowork' },
  { to: '/io', label: 'I/O', icon: FolderTree, badge: null },
];

export function AgentsTabs(): JSX.Element {
  const { pathname } = useLocation();
  const reviewQ = useReviewQueue();
  const coworkQ = useCoworkQueue();
  const counts: Record<Exclude<BadgeSource, null>, number> = {
    review: reviewQ.data?.items.length ?? 0,
    cowork: coworkQ.count,
  };

  return (
    <div
      className="flex items-center gap-1 border-b border-border bg-background/60 px-4 py-2"
      aria-label="agents-tabs"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = pathname === tab.to;
        const count = tab.badge ? counts[tab.badge] : 0;
        return (
          <Link
            key={tab.to}
            to={tab.to}
            aria-label={`agents-tab-${tab.label.toLowerCase()}`}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" />
            {tab.label}
            {count > 0 && (
              <span className="ml-0.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-yellow-200 px-1 text-[10px] font-semibold text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200">
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
