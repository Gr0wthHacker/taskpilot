/**
 * Knowledge base management view.
 *
 * Shows the drop-zone root, per-business rollups, and the indexed resources.
 * Dropping files happens in the OS file manager (we open the folder); the
 * watcher + reindex keep catalogs current. A banner flags when the Python
 * extraction toolchain is missing so PPTX/PDF/DOCX won't extract.
 */

import { useState } from 'react';
import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  RefreshCw,
  FileText,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { useToast } from '@/renderer/components/ui/use-toast';
import { ViewHeader } from '@/renderer/components/shared/ViewHeader';
import {
  useKnowledgeOverview,
  useKnowledgeResources,
  useReindexKnowledge,
} from '@/renderer/lib/query';
import type { KnowledgeBusinessSummary } from '@/shared/types';

async function openPath(target: string): Promise<void> {
  const bridge = (
    window as unknown as {
      taskpilot?: { openExternal?: (url: string) => Promise<unknown> | unknown };
    }
  ).taskpilot;
  const url = target.startsWith('file://') ? target : `file://${target}`;
  try {
    if (bridge?.openExternal) await bridge.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function BusinessCard({
  summary,
  root,
}: {
  summary: KnowledgeBusinessSummary;
  root: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const resourcesQ = useKnowledgeResources(open ? summary.business : null);
  const reindex = useReindexKnowledge();
  const { toast } = useToast();

  return (
    <div
      className="rounded-md border border-border bg-card/40 p-4"
      aria-label={`knowledge-business-${summary.business}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">
            {summary.business}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {summary.file_count} file{summary.file_count === 1 ? '' : 's'}
            {' · '}
            {summary.extracted_count} extracted
            {summary.unextracted_count > 0
              ? ` · ${summary.unextracted_count} text-pending`
              : ''}
            {summary.last_indexed_at
              ? ` · indexed ${new Date(summary.last_indexed_at).toLocaleString()}`
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`knowledge-open-${summary.business}`}
            onClick={() => {
              void openPath(`${root}/${summary.business}`);
            }}
          >
            <FolderOpen className="mr-1 h-4 w-4" />
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`knowledge-reindex-${summary.business}`}
            disabled={reindex.isPending}
            onClick={() => {
              reindex.mutate(
                { business: summary.business },
                {
                  onSuccess: () =>
                    toast({ title: `Reindexed ${summary.business}` }),
                  onError: (e) =>
                    toast({
                      title: 'Reindex failed',
                      description: e instanceof Error ? e.message : String(e),
                      variant: 'destructive',
                    }),
                },
              );
            }}
          >
            {reindex.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            Reindex
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`knowledge-toggle-${summary.business}`}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide' : 'Files'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-border pt-3">
          {resourcesQ.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          )}
          {resourcesQ.data && resourcesQ.data.resources.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No files yet. Drop decks, PDFs, or docs into this folder.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {resourcesQ.data?.resources.map((r) => (
              <li
                key={r.file}
                className="rounded-md border border-border bg-background/40 p-2"
              >
                <div className="flex items-start gap-2">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className="truncate text-left text-xs font-medium text-foreground hover:text-primary"
                      title={r.file}
                      onClick={() => {
                        void openPath(r.source_path);
                      }}
                    >
                      {r.title}
                    </button>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {r.summary}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      r.extracted
                        ? 'bg-emerald-500/15 text-emerald-600'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {r.extracted ? 'text' : 'name only'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function Knowledge(): JSX.Element {
  const overviewQ = useKnowledgeOverview();
  const reindexAll = useReindexKnowledge();
  const { toast } = useToast();

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Knowledge"
        subtitle="Drop decks, PDFs, and docs into a business folder. Tasks tagged with that business automatically pull in the relevant resources."
        actions={
          <>
          {overviewQ.data && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="knowledge-open-root"
              onClick={() => {
                void openPath(overviewQ.data.root);
              }}
            >
              <FolderOpen className="mr-1 h-4 w-4" />
              Open folder
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="knowledge-reindex-all"
            disabled={reindexAll.isPending}
            onClick={() => {
              reindexAll.mutate(
                {},
                {
                  onSuccess: () => toast({ title: 'Reindexed all knowledge' }),
                  onError: (e) =>
                    toast({
                      title: 'Reindex failed',
                      description: e instanceof Error ? e.message : String(e),
                      variant: 'destructive',
                    }),
                },
              );
            }}
          >
            {reindexAll.isPending ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            Reindex all
          </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-6 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {overviewQ.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          )}

          {overviewQ.data && !overviewQ.data.extractor.python_available && (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
              role="alert"
              aria-label="knowledge-extractor-warning"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Text extraction is limited.</p>
                <p className="mt-0.5">
                  Python wasn’t found, so .pptx/.pdf/.docx files are cataloged by
                  filename only. Markdown and text files still extract fully.
                  Install Python + the parser libs (
                  <code>pip install -r scripts/requirements-knowledge.txt</code>)
                  and Reindex to enable full extraction.
                </p>
              </div>
            </div>
          )}

          {overviewQ.data && overviewQ.data.businesses.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-xs text-muted-foreground">
              <p className="font-medium">No business folders yet.</p>
              <p className="mt-1">
                Open the folder and create a subfolder per business (e.g.{' '}
                <code>leal-health</code>), then drop your decks and docs in.
              </p>
            </div>
          )}

          {overviewQ.data?.businesses.map((b) => (
            <BusinessCard
              key={b.business}
              summary={b}
              root={overviewQ.data.root}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
