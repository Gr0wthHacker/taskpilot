/**
 * WorkspacePicker — sidebar dropdown for scoping the UI to a single business.
 *
 * Sits at the top of the sidebar below the app title. Renders a button that
 * shows the active workspace name (or "All workspaces"); opening the dropdown
 * lists every configured workspace plus an "All workspaces" reset option and
 * a shortcut to the Settings → Workspaces editor.
 *
 * The picker is purely a view over the `workspace` Zustand store. Selecting
 * an item updates `activeWorkspaceId`, which causes `useTasksList` callers
 * (via the `workspace` store subscription) to re-render their filtered list.
 *
 * Workspace colors are rendered as a small dot so the user can scan the
 * sidebar at a glance. The picker degrades gracefully when no workspaces are
 * configured: it still renders, but the dropdown shows only the "All" option
 * + the "Edit workspaces…" footer pointing the user at Settings.
 */

import { Check, ChevronsUpDown, Layers, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button } from '@/renderer/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu';
import { cn } from '@/renderer/lib/utils';
import { useWorkspaceStore } from '@/renderer/store/workspace';

export function WorkspacePicker(): JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);

  const active = activeId
    ? workspaces.find((w) => w.id === activeId) ?? null
    : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-between gap-2 text-xs"
          aria-label="workspace-picker"
        >
          <span className="flex items-center gap-2 truncate">
            {active ? (
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  backgroundColor: active.color ?? 'var(--muted-foreground)',
                }}
              />
            ) : (
              <Layers className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="truncate">{active ? active.name : 'All workspaces'}</span>
          </span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-56"
        aria-label="workspace-picker-menu"
      >
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Workspace
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => setActive(null)}
          aria-label="workspace-picker-all"
          className="cursor-pointer text-xs"
        >
          <span className="flex flex-1 items-center gap-2">
            <Layers className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            All workspaces
          </span>
          {activeId === null && <Check className="h-3 w-3" />}
        </DropdownMenuItem>
        {workspaces.length > 0 && <DropdownMenuSeparator />}
        {workspaces.map((ws) => (
          <DropdownMenuItem
            key={ws.id}
            onSelect={() => setActive(ws.id)}
            aria-label={`workspace-picker-item-${ws.id}`}
            className="cursor-pointer text-xs"
          >
            <span className="flex flex-1 items-center gap-2 truncate">
              <span
                aria-hidden="true"
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full',
                  !ws.color && 'bg-muted-foreground/40',
                )}
                style={ws.color ? { backgroundColor: ws.color } : undefined}
              />
              <span className="truncate">{ws.name}</span>
            </span>
            {activeId === ws.id && <Check className="h-3 w-3" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          asChild
          className="cursor-pointer text-xs text-muted-foreground"
          aria-label="workspace-picker-edit"
        >
          <Link to="/settings">
            <Settings2 className="mr-2 h-3 w-3" />
            Edit workspaces…
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default WorkspacePicker;
