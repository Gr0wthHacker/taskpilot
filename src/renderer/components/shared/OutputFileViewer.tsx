/**
 * In-app output file viewer.
 *
 * Opens a dialog that renders the full (capped) content of an output or
 * attachment file without leaving TaskPilot:
 *   - markdown  → rendered via {@link MarkdownView}
 *   - csv / tsv → rendered as a real table
 *   - other text → monospace <pre>
 *   - binary    → "open externally" fallback
 *
 * Content is fetched on demand via {@link useOutputFileContent}; the query is
 * gated on `open` so nothing loads until the user actually views a file.
 */

import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/renderer/components/ui/dialog';
import { MarkdownView } from '@/renderer/components/shared/MarkdownView';
import { useOutputFileContent } from '@/renderer/lib/query';
import type { OutputFile } from '@/shared/types';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields containing commas,
 * escaped double-quotes (`""`), and embedded newlines. Good enough for the
 * tabular outputs TaskPilot produces; not a general-purpose CSV engine.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop trailing fully-empty rows (e.g. a final newline).
  return rows.filter(
    (r) => !(r.length === 1 && r[0] === '') && r.length > 0,
  );
}

/* -------------------------------------------------------------------------- */
/*  Body renderers                                                            */
/* -------------------------------------------------------------------------- */

function CsvTable({ text, delimiter }: { text: string; delimiter: string }): JSX.Element {
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">Empty file.</p>;
  }
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto rounded-md border border-border">
      <table
        className="w-full border-collapse text-left text-xs"
        aria-label="output-file-csv-table"
      >
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border-b border-border px-2 py-1.5 font-semibold text-foreground"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="align-top odd:bg-background even:bg-muted/20">
              {header.map((_, ci) => (
                <td
                  key={ci}
                  className="border-b border-border px-2 py-1.5 text-foreground"
                >
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewerBody({
  contentType,
  content,
  truncated,
}: {
  contentType: string;
  content: string;
  truncated: boolean;
}): JSX.Element {
  const isMarkdown = contentType === 'text/markdown';
  const isCsv = contentType === 'text/csv';
  const isTsv = contentType === 'text/tab-separated-values';

  return (
    <div className="flex flex-col gap-2">
      {truncated && (
        <p className="text-[11px] italic text-muted-foreground">
          This file is large — showing the first portion only.
        </p>
      )}
      {isMarkdown ? (
        <div className="text-sm">
          <MarkdownView source={content} />
        </div>
      ) : isCsv || isTsv ? (
        <CsvTable text={content} delimiter={isTsv ? '\t' : ','} />
      ) : (
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-[12px] leading-relaxed text-foreground">
          {content}
        </pre>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Dialog                                                                    */
/* -------------------------------------------------------------------------- */

export interface OutputFileViewerProps {
  taskId: string;
  /** The file to view. When null the dialog renders nothing meaningful. */
  file: OutputFile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OutputFileViewer({
  taskId,
  file,
  open,
  onOpenChange,
}: OutputFileViewerProps): JSX.Element {
  const q = useOutputFileContent(taskId, file?.path, open);
  const name = file ? basename(file.path) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label="output-file-viewer"
        className="max-w-4xl"
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-6" title={name}>
            {name || 'File'}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto">
          {q.isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          )}
          {q.isError && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              Couldn’t load this file.
              {q.error instanceof Error ? ` ${q.error.message}` : ''}
            </div>
          )}
          {q.data && !q.data.is_text && (
            <div className="flex flex-col items-start gap-2 text-xs text-muted-foreground">
              <p>This file type can’t be previewed in-app.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (file) {
                    window.open(`file://${file.path}`, '_blank', 'noopener');
                  }
                }}
              >
                <ExternalLink className="mr-1 h-4 w-4" />
                Open externally
              </Button>
            </div>
          )}
          {q.data && q.data.is_text && (
            <ViewerBody
              contentType={q.data.content_type}
              content={q.data.content}
              truncated={q.data.truncated}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
