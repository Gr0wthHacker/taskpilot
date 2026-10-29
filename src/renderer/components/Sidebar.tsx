import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Archive as ArchiveIcon,
  BarChart3,
  BookOpen,
  Brain,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Eye,
  Folder,
  Gauge,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  PlayCircle,
  Send,
  Settings as SettingsIcon,
  Share2,
  Target,
  Upload as UploadIcon,
  FileText,
  Workflow,
} from 'lucide-react';
import { cn } from '@/renderer/lib/utils';
import {
  useContextStatus,
  useCoworkQueue,
  useMemoryStats,
  useReviewQueue,
  useTaskStats,
} from '@/renderer/lib/query';
import { dispatchOpenHelp } from './KeyboardShortcutsProvider';
import { isMac } from '@/renderer/lib/hotkeys';
import { WorkspacePicker } from './Workspaces/WorkspacePicker';
import { api } from '@/renderer/lib/api';
import { useQuery } from '@tanstack/react-query';

function usePendingSummariesCount(): number {
  const q = useQuery({
    queryKey: ['conversations', 'pending-summaries-count'],
    queryFn: async (): Promise<number> => {
      const res = await api.get<{ count: number }>(
        '/api/conversations/pending-summarizes',
        { limit: '100' },
      );
      return res.count ?? 0;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return q.data ?? 0;
}

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Exact-match only (used for the index route). */
  end?: boolean;
  /** Extra path prefixes that should also light this item up. */
  alsoActiveOn?: string[];
  badge?: number | null;
  badgeLabel?: string;
  ariaLabel?: string;
}

// WORK section. `Inbox` and `Board` badges are populated at render time from
// `useTaskStats()` — see the Sidebar component below. We keep the base
// definitions here so the section order and labels stay declarative.
const WORK_BASE: NavItem[] = [
  { to: '/', label: 'Your Move', icon: ListChecks, end: true },
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/board', label: 'Board', icon: LayoutGrid },
  { to: '/memory', label: 'Memory', icon: Brain },
];

const PLAN: NavItem[] = [
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/goals', label: 'Goals', icon: Target, alsoActiveOn: ['/goals/'] },
  { to: '/businesses', label: 'Businesses', icon: Briefcase },
  { to: '/delivery', label: 'Delivery', icon: ClipboardList },
  { to: '/content', label: 'Content', icon: Send },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock },
];

// Rarely-used surfaces — tucked behind a collapsible "More" so the daily
// drivers above stay uncluttered. Everything here is still reachable via ⌘K.
const MORE: NavItem[] = [
  { to: '/projects', label: 'Projects', icon: Folder },
  { to: '/graph', label: 'Graph', icon: Share2 },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/import', label: 'Import', icon: UploadIcon },
  { to: '/archive', label: 'Archive', icon: ArchiveIcon },
  { to: '/derive', label: 'Derivation', icon: Workflow },
  { to: '/execute', label: 'Execution', icon: PlayCircle },
  { to: '/watch', label: 'Watch', icon: Eye },
  { to: '/conversations', label: 'Conversations', icon: MessageSquare },
  { to: '/about', label: 'About', icon: Info },
];

const MORE_STORAGE_KEY = 'taskpilot-sidebar-more';

function isActive(pathname: string, item: NavItem): boolean {
  if (item.end) return pathname === item.to;
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return true;
  return (item.alsoActiveOn ?? []).some(
    (p) => pathname === p || pathname.startsWith(p),
  );
}

function NavRow({
  item,
  active,
}: {
  item: NavItem;
  active: boolean;
}): JSX.Element {
  const Icon = item.icon;
  const badge = item.badge ?? null;
  return (
    <Link
      to={item.to}
      aria-label={item.ariaLabel}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">{item.label}</span>
      {badge !== null && badge > 0 && (
        <span
          className={cn(
            'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold',
            badge >= 10
              ? 'bg-red-200 text-red-900 dark:bg-red-900/40 dark:text-red-200'
              : 'bg-yellow-200 text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200',
          )}
          aria-label={item.badgeLabel}
        >
          {badge}
        </span>
      )}
    </Link>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-3 pb-1 pt-4 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

export default function Sidebar(): JSX.Element {
  const { pathname } = useLocation();
  const reviewQ = useReviewQueue();
  const reviewCount = reviewQ.data?.items.length ?? 0;
  const coworkQueue = useCoworkQueue();
  const coworkCount = coworkQueue.count;
  const mac = isMac();

  // Ambient monitor — surface pending deliberations as a Watch badge so the
  // user notices a queued interrupter score even if the More section is
  // collapsed (the moreActive dot still lights up either way).
  const contextStatus = useContextStatus();
  const watchPending = contextStatus.data?.pending_deliberations ?? 0;

  // Pending summarize queue — surfaces under Conversations.
  const pendingSummaries = usePendingSummariesCount();

  // Materialized task counts (singleton row in the DB, refreshed eagerly on
  // every mutation via the write+pre-delete hooks installed by the server).
  // We tolerate the first render returning `undefined` — the badges just show
  // nothing until the first poll succeeds, which is normally well under 100ms.
  const taskStatsQ = useTaskStats();
  const inboxCount = taskStatsQ.data?.stats.inbox ?? 0;
  const activeCount =
    (taskStatsQ.data?.stats.queued ?? 0) +
    (taskStatsQ.data?.stats.in_progress ?? 0);

  // Memory subsystem — `raw` is the "needs enrichment" backlog; that's the
  // signal worth surfacing to nudge the user toward draining the queue. The
  // total count is shown as the view subtitle inside MemoryInbox itself.
  const memoryStatsQ = useMemoryStats();
  const memoryPending = memoryStatsQ.data?.stats.raw ?? 0;

  // Splice the live counts into the WORK nav items. Re-derives on every
  // render but each NavItem is a plain object literal, so React only
  // re-renders the row whose badge prop actually changed.
  const workItems: NavItem[] = WORK_BASE.map((item) => {
    if (item.to === '/inbox') {
      return {
        ...item,
        badge: inboxCount,
        badgeLabel: 'sidebar-inbox-badge',
      };
    }
    if (item.to === '/board') {
      return {
        ...item,
        badge: activeCount,
        badgeLabel: 'sidebar-board-badge',
      };
    }
    if (item.to === '/memory') {
      return {
        ...item,
        badge: memoryPending,
        badgeLabel: 'sidebar-memory-badge',
      };
    }
    return item;
  });

  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MORE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleMore = (): void => {
    setMoreOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MORE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  // The Agents hub stands in for Review/Cowork/I/O/Mission Control; light it
  // up on any of those routes and carry their combined "needs attention" count.
  const agentsItem: NavItem = {
    to: '/agents',
    label: 'Agents',
    icon: Gauge,
    alsoActiveOn: ['/review', '/cowork', '/io'],
    badge: reviewCount + coworkCount,
    badgeLabel: 'sidebar-agents-badge',
  };
  const moreActive = MORE.some((i) => isActive(pathname, i));

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card">
      <div className="space-y-3 px-4 py-5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold tracking-tight">TaskPilot</div>
            <kbd
              className="rounded border bg-muted px-1.5 text-[10px] font-mono text-muted-foreground"
              aria-label="sidebar-palette-hint"
            >
              {mac ? '⌘K' : 'Ctrl+K'}
            </kbd>
          </div>
          <div className="text-xs text-muted-foreground">local-first task ops</div>
        </div>
        <WorkspacePicker />
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        <SectionLabel>Work</SectionLabel>
        {workItems.map((item) => (
          <NavRow key={item.to} item={item} active={isActive(pathname, item)} />
        ))}

        <SectionLabel>Agents</SectionLabel>
        <NavRow item={agentsItem} active={isActive(pathname, agentsItem)} />

        <SectionLabel>Plan</SectionLabel>
        {PLAN.map((item) => (
          <NavRow key={item.to} item={item} active={isActive(pathname, item)} />
        ))}

        <button
          type="button"
          onClick={toggleMore}
          aria-label="sidebar-more-toggle"
          aria-expanded={moreOpen}
          className={cn(
            'mt-3 flex w-full items-center gap-1 rounded-md px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
            moreActive && !moreOpen
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform',
              moreOpen ? '' : '-rotate-90',
            )}
          />
          More
          {moreActive && !moreOpen && (
            <span className="ml-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          )}
        </button>
        {moreOpen &&
          MORE.map((item) => {
            // Inject the live deliberation-pending count into the Watch row.
            // Keeps the static MORE array declarative while still surfacing
            // dynamic data without spawning a second hook tree.
            const enriched: NavItem =
              item.to === '/watch'
                ? {
                    ...item,
                    badge: watchPending,
                    badgeLabel: 'sidebar-watch-badge',
                  }
                : item.to === '/conversations'
                  ? {
                      ...item,
                      badge: pendingSummaries,
                      badgeLabel: 'sidebar-conversations-badge',
                    }
                  : item;
            return (
              <NavRow
                key={item.to}
                item={enriched}
                active={isActive(pathname, item)}
              />
            );
          })}
      </nav>

      <div className="border-t border-border px-2 py-3">
        <NavRow
          item={{ to: '/settings', label: 'Settings', icon: SettingsIcon }}
          active={isActive(pathname, { to: '/settings', label: '', icon: SettingsIcon })}
        />
        <button
          type="button"
          onClick={dispatchOpenHelp}
          aria-label="sidebar-show-shortcuts"
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Keyboard className="h-4 w-4" />
          <span>Show shortcuts</span>
        </button>
      </div>
    </aside>
  );
}
