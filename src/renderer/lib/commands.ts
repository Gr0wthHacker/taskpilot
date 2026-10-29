/**
 * Command registry for the command palette (⌘K).
 *
 * Two kinds of commands:
 *   - Static commands — navigation + global actions that always exist. Built
 *     once via `getStaticCommands()` because they don't depend on app data.
 *   - Task commands — one entry per task, surfacing task IDs and titles for
 *     fuzzy jump. Built via `getTaskCommands(tasks)` against the live task
 *     list so the palette filters against the same data the user sees.
 *
 * Each command exposes a `run(ctx)` callback. The palette injects a
 * `CommandContext` (navigate, openNewTaskDialog, toast, etc.) at execution
 * time so commands stay decoupled from the React tree.
 */
import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  BarChart3,
  Brain,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  CalendarDays,
  CheckSquare,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  Gauge,
  Inbox,
  Info,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  Settings,
  Upload as UploadIcon,
  UserSquare,
  Workflow,
  Zap,
} from 'lucide-react';

import { api } from '@/renderer/lib/api';
import type { Task } from '@/shared/types';

/** Categories used for the palette's group badge + ordering. */
export type CommandGroup = 'navigate' | 'create' | 'action' | 'task';

/** Runtime context handed to each command's `run` callback. */
export interface CommandContext {
  /** Navigate to an in-app route. Backed by react-router's `useNavigate`. */
  navigate: (to: string) => void;
  /** Open the global new-task dialog. Wired from the keyboard provider. */
  openNewTaskDialog: () => void;
  /** Toast helper — commands surface their own success/error feedback. */
  toast: (input: { title: string; description?: string; variant?: 'default' | 'destructive' }) => void;
}

export interface PaletteCommand {
  /** Stable identifier used as the React key + for deduping. */
  id: string;
  /** Human-readable label shown in the palette list. */
  label: string;
  /** Group bucket — used for visual grouping and ordering. */
  group: CommandGroup;
  /** Optional substring tokens that count as a match in addition to label. */
  keywords?: string[];
  /** Lucide icon component, rendered at 16px on the left of the row. */
  icon: LucideIcon;
  /** Action to take when the user selects this command. */
  run: (ctx: CommandContext) => void | Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Static commands                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build the canonical list of static commands. Recomputed on every call but
 * cheap — the array is small and pure data, so callers can memoize if needed.
 */
export function getStaticCommands(): PaletteCommand[] {
  return [
    // Navigation -----------------------------------------------------------
    {
      id: 'nav.inbox',
      label: 'Go to Inbox',
      group: 'navigate',
      icon: Inbox,
      keywords: ['inbox', 'capture', 'untriaged'],
      run: (ctx) => ctx.navigate('/inbox'),
    },
    {
      id: 'nav.now',
      label: 'Go to Your Move',
      group: 'navigate',
      icon: ListChecks,
      keywords: ['your move', 'now', 'home', 'overdue', 'blocked', 'review', 'mine'],
      run: (ctx) => ctx.navigate('/'),
    },
    {
      id: 'nav.board',
      label: 'Go to Board',
      group: 'navigate',
      icon: LayoutGrid,
      keywords: ['board', 'kanban', 'status'],
      run: (ctx) => ctx.navigate('/board'),
    },
    {
      id: 'nav.review',
      label: 'Go to Review',
      group: 'navigate',
      icon: Eye,
      keywords: ['review', 'queue', 'needs-review'],
      run: (ctx) => ctx.navigate('/review'),
    },
    {
      id: 'nav.memory',
      label: 'Go to Memory',
      group: 'navigate',
      icon: Brain,
      keywords: ['memory', 'notes', 'dump', 'snippets', 'recall'],
      run: (ctx) => ctx.navigate('/memory'),
    },
    {
      id: 'memory.capture-text',
      label: 'Memory: capture text…',
      group: 'create',
      icon: Brain,
      keywords: ['memory', 'capture', 'paste', 'snippet', 'note', 'dump'],
      // Dispatch a window event the Layout shell listens for. Avoids
      // having to thread the dialog open-handle through CommandContext.
      // The palette closes itself after `run` returns, per its handler.
      run: () => {
        window.dispatchEvent(
          new CustomEvent('taskpilot:open-memory-capture', { detail: { kind: 'text' } }),
        );
      },
    },
    {
      id: 'memory.capture-url',
      label: 'Memory: capture URL…',
      group: 'create',
      icon: Brain,
      keywords: ['memory', 'capture', 'url', 'link', 'page', 'bookmark'],
      run: () => {
        window.dispatchEvent(
          new CustomEvent('taskpilot:open-memory-capture', { detail: { kind: 'url' } }),
        );
      },
    },
    {
      id: 'nav.search',
      label: 'Search everything',
      group: 'navigate',
      icon: SearchIcon,
      keywords: ['search', 'find', 'full-text', 'lookup'],
      run: (ctx) => ctx.navigate('/search'),
    },
    {
      id: 'nav.agents',
      label: 'Go to Mission Control',
      group: 'navigate',
      icon: Gauge,
      keywords: ['agents', 'mission', 'control', 'running', 'live', 'status'],
      run: (ctx) => ctx.navigate('/agents'),
    },
    {
      id: 'nav.cowork',
      label: 'Go to Cowork',
      group: 'navigate',
      icon: UserSquare,
      keywords: ['cowork', 'pair', 'live'],
      run: (ctx) => ctx.navigate('/cowork'),
    },
    {
      id: 'nav.calendar',
      label: 'Go to Calendar',
      group: 'navigate',
      icon: CalendarDays,
      keywords: ['calendar', 'schedule', 'events'],
      run: (ctx) => ctx.navigate('/calendar'),
    },
    {
      id: 'nav.plan',
      label: 'Go to Daily Plan',
      group: 'navigate',
      icon: CalendarCheck,
      keywords: ['daily', 'plan', 'today', 'agenda'],
      run: (ctx) => ctx.navigate('/plan'),
    },
    {
      id: 'nav.schedules',
      label: 'Go to Schedules',
      group: 'navigate',
      icon: CalendarClock,
      keywords: ['schedule', 'schedules', 'recurring', 'cron', 'fan-out', 'sparman'],
      run: (ctx) => ctx.navigate('/schedules'),
    },
    {
      id: 'nav.delivery',
      label: 'Go to Delivery',
      group: 'navigate',
      icon: ClipboardList,
      keywords: ['delivery', 'queue', 'sla', 'contractor', 'offshore', 'client', 'templates'],
      run: (ctx) => ctx.navigate('/delivery'),
    },
    {
      id: 'nav.io',
      label: 'Go to I/O Dashboard',
      group: 'navigate',
      icon: FolderTree,
      keywords: ['io', 'input', 'output', 'ingest', 'dashboard'],
      run: (ctx) => ctx.navigate('/io'),
    },
    {
      id: 'nav.templates',
      label: 'Go to Templates',
      group: 'navigate',
      icon: FileText,
      keywords: ['templates', 'reusable'],
      run: (ctx) => ctx.navigate('/templates'),
    },
    {
      id: 'nav.import',
      label: 'Go to Import',
      group: 'navigate',
      icon: UploadIcon,
      keywords: ['import', 'csv', 'bulk', 'upload'],
      run: (ctx) => ctx.navigate('/import'),
    },
    {
      id: 'nav.reports',
      label: 'Go to Reports',
      group: 'navigate',
      icon: BarChart3,
      keywords: ['reports', 'metrics', 'analytics', 'velocity'],
      run: (ctx) => ctx.navigate('/reports'),
    },
    {
      id: 'nav.archive',
      label: 'Go to Archive',
      group: 'navigate',
      icon: Archive,
      keywords: ['archive', 'completed', 'done'],
      run: (ctx) => ctx.navigate('/archive'),
    },
    {
      id: 'nav.projects',
      label: 'Go to Projects',
      group: 'navigate',
      icon: Folder,
      keywords: ['projects', 'groups'],
      run: (ctx) => ctx.navigate('/projects'),
    },
    {
      id: 'nav.about',
      label: 'Go to About',
      group: 'navigate',
      icon: Info,
      keywords: ['about', 'version', 'info'],
      run: (ctx) => ctx.navigate('/about'),
    },
    {
      id: 'nav.watch',
      label: 'Go to Watch',
      group: 'navigate',
      icon: Eye,
      keywords: ['watch', 'ambient', 'monitor', 'observations', 'deliberation'],
      run: (ctx) => ctx.navigate('/watch'),
    },
    {
      id: 'nav.conversations',
      label: 'Go to Conversations',
      group: 'navigate',
      icon: MessageSquare,
      keywords: ['conversations', 'sessions', 'claude code', 'transcripts', 'history'],
      run: (ctx) => ctx.navigate('/conversations'),
    },
    {
      id: 'nav.settings',
      label: 'Go to Settings',
      group: 'navigate',
      icon: Settings,
      keywords: ['settings', 'preferences', 'config'],
      run: (ctx) => ctx.navigate('/settings'),
    },
    // Creation -------------------------------------------------------------
    {
      id: 'create.new-task',
      label: 'New task',
      group: 'create',
      icon: Plus,
      keywords: ['create', 'add', 'task', 'new'],
      run: (ctx) => ctx.openNewTaskDialog(),
    },
    {
      id: 'action.triage-inbox',
      label: 'Triage inbox',
      group: 'action',
      icon: Zap,
      keywords: ['triage', 'inbox', 'zero', 'review', 'walkthrough', 'clear'],
      run: (ctx) => ctx.navigate('/triage'),
    },
    // Actions --------------------------------------------------------------
    {
      id: 'action.force-ingest',
      label: 'Force ingest',
      group: 'action',
      icon: Workflow,
      keywords: ['ingest', 'rescan', 'io', 'watcher'],
      run: async (ctx) => {
        try {
          await api.post('/api/io/ingest');
          ctx.toast({
            title: 'Ingest triggered',
            description: 'Watcher rescanned the I/O directories.',
          });
        } catch (cause) {
          ctx.toast({
            title: 'Ingest failed',
            description: cause instanceof Error ? cause.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    },
    {
      id: 'action.refresh-context',
      label: 'Refresh context',
      group: 'action',
      icon: RefreshCw,
      keywords: ['refresh', 'context', 'reload', 'ingest'],
      run: async (ctx) => {
        try {
          await api.post('/api/io/ingest', { refresh_context: true });
          ctx.toast({
            title: 'Context refreshed',
            description: 'Watcher reingested with refresh_context=true.',
          });
        } catch (cause) {
          ctx.toast({
            title: 'Refresh failed',
            description: cause instanceof Error ? cause.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    },
    {
      id: 'action.deliberate-now',
      label: 'Run deliberation now',
      group: 'action',
      icon: Zap,
      keywords: ['deliberate', 'ambient', 'monitor', 'flush', 'watch'],
      run: async (ctx) => {
        try {
          await api.post('/api/context/deliberate', { reason: 'manual' });
          ctx.toast({
            title: 'Deliberation requested',
            description: 'Ambient batch queued for scoring.',
          });
        } catch (cause) {
          ctx.toast({
            title: 'Deliberation failed',
            description: cause instanceof Error ? cause.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    },
    {
      id: 'action.open-io-folder',
      label: 'Open I/O folder',
      group: 'action',
      icon: FolderOpen,
      keywords: ['folder', 'finder', 'explorer', 'io', 'open'],
      run: async (ctx) => {
        const bridge = window.taskpilot as
          | (typeof window.taskpilot & {
              openIoFolder?: () => Promise<{ ok: boolean; message?: string }>;
            })
          | undefined;
        if (!bridge?.openIoFolder) {
          ctx.toast({
            title: 'Folder open unavailable',
            description: 'This build does not expose openIoFolder on the bridge.',
            variant: 'destructive',
          });
          return;
        }
        try {
          const result = await bridge.openIoFolder();
          if (!result.ok) {
            ctx.toast({
              title: 'Could not open folder',
              description: result.message ?? 'Bridge call failed.',
              variant: 'destructive',
            });
          }
        } catch (cause) {
          ctx.toast({
            title: 'Could not open folder',
            description: cause instanceof Error ? cause.message : 'Unknown error',
            variant: 'destructive',
          });
        }
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Task commands                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build one palette command per task. Matched against title + id substrings
 * at filter time, so a typed prefix like `abcd-1234` or the start of a task
 * title both jump to the task detail page.
 */
export function getTaskCommands(tasks: Task[]): PaletteCommand[] {
  return tasks.map((task) => ({
    id: `task.${task.id}`,
    label: task.title,
    group: 'task' as const,
    keywords: [task.id, ...(task.tags ?? [])],
    icon: CheckSquare,
    run: (ctx: CommandContext): void => ctx.navigate(`/task/${task.id}`),
  }));
}
