/**
 * SearchResult — one row in the search results list (Wave 17).
 *
 * Renders an entity-type badge, the result title, and a `<mark>`-highlighted
 * snippet. The snippet arrives from the server already HTML-escaped (only the
 * `<mark>` wrappers the server inserted are real markup), so it's safe to set
 * via `dangerouslySetInnerHTML`. The whole row is a button that navigates to
 * the owning task.
 *
 * Used by both the dedicated `/search` view and (in a compact form) the
 * command palette's "Search results" group.
 */

import {
  Brain,
  CheckSquare,
  FileText,
  Paperclip,
  Terminal,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/renderer/components/ui/badge';
import { cn } from '@/renderer/lib/utils';
import type { SearchEntityType, SearchResult as SearchResultData } from '@/shared/api-contract';

interface EntityMeta {
  label: string;
  icon: LucideIcon;
}

const ENTITY_META: Record<SearchEntityType, EntityMeta> = {
  task: { label: 'Task', icon: CheckSquare },
  decision: { label: 'Decision', icon: FileText },
  execution: { label: 'Output', icon: Terminal },
  attachment: { label: 'Attachment', icon: Paperclip },
  memory: { label: 'Memory', icon: Brain },
};

interface SearchResultProps {
  result: SearchResultData;
  /** Visually marks the row as keyboard-selected (palette + view share this). */
  selected?: boolean;
  /** Compact layout drops padding + the score; used inside the palette. */
  compact?: boolean;
  onSelect: (result: SearchResultData) => void;
  /** Mouse-enter handler so hovering syncs the keyboard selection. */
  onHover?: () => void;
  /** Forwarded to the row for scroll-into-view targeting. */
  dataIndex?: number;
}

export function SearchResult({
  result,
  selected = false,
  compact = false,
  onSelect,
  onHover,
  dataIndex,
}: SearchResultProps): JSX.Element {
  const meta = ENTITY_META[result.entity_type] ?? ENTITY_META.task;
  const Icon = meta.icon;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-label="search-result"
      data-entity-type={result.entity_type}
      {...(dataIndex !== undefined ? { 'data-index': dataIndex } : {})}
      onClick={() => onSelect(result)}
      onMouseMove={onHover}
      className={cn(
        'flex w-full items-start gap-3 text-left transition-colors',
        compact ? 'px-3 py-2' : 'rounded-md px-3 py-3',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{result.title}</span>
          <Badge
            variant="outline"
            className="shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wider"
          >
            {meta.label}
          </Badge>
        </div>
        {result.snippet.length > 0 && (
          <p
            className="mt-0.5 line-clamp-2 text-xs text-muted-foreground [&_mark]:rounded [&_mark]:bg-yellow-200 [&_mark]:px-0.5 [&_mark]:text-foreground dark:[&_mark]:bg-yellow-500/40"
            // Snippet is server-escaped; only `<mark>` wrappers are real markup.
            dangerouslySetInnerHTML={{ __html: result.snippet }}
          />
        )}
      </div>
    </button>
  );
}
