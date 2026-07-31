/**
 * Bulk import wizard.
 *
 * Four steps:
 *   1. Drop file / paste CSV / Notion CSV content.
 *   2. Column mapping — auto-filled from `/api/import/suggest` with editable
 *      title/description/priority/tag-column controls.
 *   3. Preview — first 10 rows + aggregate counts, surfaced from
 *      `/api/import/preview`.
 *   4. Commit + summary.
 *
 * The state machine is a single `step` field plus the form values. We
 * don't reach for a wizard library — the linear flow with 4 nodes is
 * legible inline.
 *
 * Wave 13 — Agent M.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Upload,
  Wand2,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useImportCommit,
  useImportPreview,
  useImportSuggest,
} from '@/renderer/lib/query';
import type {
  ImportCommitResponse,
  ImportFormat,
  ImportMappingConfig,
  ImportPreviewResponse,
} from '@/shared/api-contract';

type Step = 'input' | 'mapping' | 'preview' | 'done';

interface FormState {
  format: ImportFormat;
  content: string;
  mapping: ImportMappingConfig;
}

const EMPTY_MAPPING: ImportMappingConfig = {
  title_column: '',
};

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export default function ImportView(): JSX.Element {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>('input');
  const [form, setForm] = useState<FormState>({
    format: 'csv',
    content: '',
    mapping: { ...EMPTY_MAPPING },
  });
  const [headers, setHeaders] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [commit, setCommit] = useState<ImportCommitResponse | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const suggestMut = useImportSuggest();
  const previewMut = useImportPreview();
  const commitMut = useImportCommit();

  /* ------------------------------------------------------------------ step 1 */

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      const text = await file.text();
      setForm((f) => ({ ...f, content: text }));
    },
    [],
  );

  const handleDrop = useCallback(
    async (ev: React.DragEvent<HTMLDivElement>): Promise<void> => {
      ev.preventDefault();
      const file = ev.dataTransfer?.files?.[0];
      if (file) await handleFile(file);
    },
    [handleFile],
  );

  const handleSuggest = async (): Promise<void> => {
    if (form.content.trim().length === 0) {
      toast({
        title: 'Drop a file or paste CSV content first',
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await suggestMut.mutateAsync({
        format: form.format,
        content: form.content,
      });
      setHeaders(res.headers);
      setForm((f) => ({
        ...f,
        mapping: {
          ...EMPTY_MAPPING,
          ...res.suggestion,
          // If the suggester couldn't pick a title column, default to the
          // first header so the user has somewhere to start.
          title_column:
            res.suggestion.title_column ?? res.headers[0] ?? '',
        },
      }));
      setStep('mapping');
    } catch (cause) {
      toast({
        title: 'Couldn’t parse content',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  /* ------------------------------------------------------------------ step 2 */

  const canPreview = useMemo(
    () => form.mapping.title_column.length > 0,
    [form.mapping.title_column],
  );

  const handlePreview = async (): Promise<void> => {
    if (!canPreview) return;
    try {
      const res = await previewMut.mutateAsync({
        format: form.format,
        content: form.content,
        mapping: form.mapping,
      });
      setPreview(res);
      setStep('preview');
    } catch (cause) {
      toast({
        title: 'Preview failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  /* ------------------------------------------------------------------ step 3 */

  const handleCommit = async (): Promise<void> => {
    try {
      const res = await commitMut.mutateAsync({
        format: form.format,
        content: form.content,
        mapping: form.mapping,
        options: { source: form.format },
      });
      setCommit(res);
      setStep('done');
    } catch (cause) {
      toast({
        title: 'Import failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  /* ------------------------------------------------------------------ reset  */

  const reset = (): void => {
    setStep('input');
    setForm({ format: 'csv', content: '', mapping: { ...EMPTY_MAPPING } });
    setHeaders([]);
    setPreview(null);
    setCommit(null);
  };

  /* ------------------------------------------------------------------ render */

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="view-import">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-background/60 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Bulk import</h1>
          <p className="text-xs text-muted-foreground">
            Drop a CSV or Notion export to create tasks in bulk.
          </p>
        </div>
        <StepIndicator step={step} />
      </header>

      <div className="flex-1 overflow-auto px-6 py-4">
        {step === 'input' ? (
          <InputStep
            form={form}
            setForm={setForm}
            fileInputRef={fileInputRef}
            onDrop={handleDrop}
            onPickFile={handleFile}
            onSuggest={handleSuggest}
            loading={suggestMut.isPending}
          />
        ) : null}

        {step === 'mapping' ? (
          <MappingStep
            form={form}
            setForm={setForm}
            headers={headers}
            canPreview={canPreview}
            onBack={() => setStep('input')}
            onPreview={handlePreview}
            loading={previewMut.isPending}
          />
        ) : null}

        {step === 'preview' && preview ? (
          <PreviewStep
            preview={preview}
            onBack={() => setStep('mapping')}
            onCommit={handleCommit}
            loading={commitMut.isPending}
          />
        ) : null}

        {step === 'done' && commit ? (
          <DoneStep commit={commit} onReset={reset} />
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

function StepIndicator({ step }: { step: Step }): JSX.Element {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 'input', label: 'Input' },
    { id: 'mapping', label: 'Mapping' },
    { id: 'preview', label: 'Preview' },
    { id: 'done', label: 'Done' },
  ];
  const idx = steps.findIndex((s) => s.id === step);
  return (
    <div className="flex items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <div
          key={s.id}
          className={`rounded px-2 py-1 ${
            i <= idx
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground'
          }`}
        >
          {i + 1}. {s.label}
        </div>
      ))}
    </div>
  );
}

interface InputStepProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onDrop: (ev: React.DragEvent<HTMLDivElement>) => void;
  onPickFile: (file: File) => void;
  onSuggest: () => void;
  loading: boolean;
}

function InputStep(props: InputStepProps): JSX.Element {
  const { form, setForm, fileInputRef, onDrop, onPickFile, onSuggest, loading } =
    props;
  return (
    <div className="max-w-2xl space-y-4" aria-label="import-step-input">
      <div className="space-y-1">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Format
        </label>
        <Select
          value={form.format}
          onValueChange={(v) =>
            setForm((f) => ({ ...f, format: v as ImportFormat }))
          }
        >
          <SelectTrigger className="w-[200px]" aria-label="import-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="csv">CSV</SelectItem>
            <SelectItem value="notion">Notion export</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div
        className="flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-border bg-card p-8 text-center"
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        aria-label="import-dropzone"
      >
        <Upload className="h-8 w-8 text-muted-foreground" />
        <div className="text-sm">Drop a {form.format === 'notion' ? 'Notion CSV' : 'CSV'} file here</div>
        <div className="text-xs text-muted-foreground">
          or paste the content below
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          Choose file…
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPickFile(file);
          }}
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Or paste CSV content
        </label>
        <textarea
          value={form.content}
          onChange={(e) =>
            setForm((f) => ({ ...f, content: e.target.value }))
          }
          className="h-48 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          placeholder={'title,description,priority\nFoo,Do the thing,p1\n…'}
          aria-label="import-content"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          onClick={onSuggest}
          disabled={loading || form.content.trim().length === 0}
          aria-label="import-next-to-mapping"
        >
          <Wand2 className="mr-1 h-4 w-4" />
          {loading ? 'Parsing…' : 'Next: map columns'}
        </Button>
      </div>
    </div>
  );
}

interface MappingStepProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  headers: string[];
  canPreview: boolean;
  onBack: () => void;
  onPreview: () => void;
  loading: boolean;
}

function MappingStep(props: MappingStepProps): JSX.Element {
  const { form, setForm, headers, canPreview, onBack, onPreview, loading } =
    props;
  const updateMapping = (patch: Partial<ImportMappingConfig>): void => {
    setForm((f) => ({ ...f, mapping: { ...f.mapping, ...patch } }));
  };

  const columnOptions = ['', ...headers];

  return (
    <div className="max-w-2xl space-y-4" aria-label="import-step-mapping">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="text-sm font-medium">Map columns to task fields</div>
        <div className="text-xs text-muted-foreground">
          Detected {headers.length} column{headers.length === 1 ? '' : 's'}.
        </div>
      </div>

      <MappingRow
        label="Title column"
        required
        value={form.mapping.title_column}
        onChange={(v) => updateMapping({ title_column: v })}
        options={columnOptions}
        ariaLabel="import-map-title"
      />
      <MappingRow
        label="Description column"
        value={form.mapping.description_column ?? ''}
        onChange={(v) =>
          updateMapping({ description_column: v.length === 0 ? undefined : v })
        }
        options={columnOptions}
        ariaLabel="import-map-description"
      />
      <MappingRow
        label="Priority column"
        value={form.mapping.priority_column ?? ''}
        onChange={(v) =>
          updateMapping({ priority_column: v.length === 0 ? undefined : v })
        }
        options={columnOptions}
        ariaLabel="import-map-priority"
      />
      <MappingRow
        label="Tag column"
        value={form.mapping.tag_columns?.[0] ?? ''}
        onChange={(v) =>
          updateMapping({ tag_columns: v.length === 0 ? undefined : [v] })
        }
        options={columnOptions}
        ariaLabel="import-map-tags"
      />
      <MappingRow
        label="Dedupe column"
        helper="Skip rows where this value already exists on a task."
        value={form.mapping.skip_duplicates_by ?? ''}
        onChange={(v) =>
          updateMapping({ skip_duplicates_by: v.length === 0 ? undefined : v })
        }
        options={columnOptions}
        ariaLabel="import-map-dedupe"
      />

      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onPreview}
          disabled={!canPreview || loading}
          aria-label="import-next-to-preview"
        >
          {loading ? 'Previewing…' : 'Next: preview'}
        </Button>
      </div>
    </div>
  );
}

function MappingRow(props: {
  label: string;
  helper?: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 items-center gap-3 rounded-md border border-border bg-background/40 px-4 py-3">
      <div>
        <div className="text-sm font-medium">
          {props.label}
          {props.required ? (
            <span className="ml-1 text-destructive">*</span>
          ) : null}
        </div>
        {props.helper ? (
          <div className="text-xs text-muted-foreground">{props.helper}</div>
        ) : null}
      </div>
      <div className="col-span-2">
        <Select value={props.value} onValueChange={props.onChange}>
          <SelectTrigger aria-label={props.ariaLabel}>
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            {props.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt.length === 0 ? '— (none)' : opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

interface PreviewStepProps {
  preview: ImportPreviewResponse;
  onBack: () => void;
  onCommit: () => void;
  loading: boolean;
}

function PreviewStep(props: PreviewStepProps): JSX.Element {
  const { preview, onBack, onCommit, loading } = props;
  return (
    <div className="max-w-4xl space-y-4" aria-label="import-step-preview">
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Valid" value={preview.summary.valid} tone="ok" />
        <SummaryCard
          label="Errors"
          value={preview.summary.errors}
          tone={preview.summary.errors > 0 ? 'warn' : 'ok'}
        />
        <SummaryCard
          label="Duplicates"
          value={preview.summary.duplicates}
          tone={preview.summary.duplicates > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs" aria-label="import-preview-table">
          <thead className="bg-muted/40">
            <tr>
              <th className="px-3 py-2 text-left">Row</th>
              <th className="px-3 py-2 text-left">Title</th>
              <th className="px-3 py-2 text-left">Priority</th>
              <th className="px-3 py-2 text-left">Tags</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {preview.preview.map((row) => (
              <tr key={row.row_number} className="border-t border-border">
                <td className="px-3 py-2 font-mono text-muted-foreground">
                  {row.row_number}
                </td>
                <td className="px-3 py-2">{row.task.title}</td>
                <td className="px-3 py-2 font-mono">{row.task.priority}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {row.task.tags?.join(', ') ?? ''}
                </td>
                <td className="px-3 py-2">
                  {row.duplicate ? (
                    <span className="text-amber-600">duplicate</span>
                  ) : row.errors.length > 0 ? (
                    <span className="text-destructive">
                      <AlertTriangle className="mr-1 inline h-3 w-3" />
                      {row.errors.length} issue
                      {row.errors.length === 1 ? '' : 's'}
                    </span>
                  ) : (
                    <span className="text-emerald-600">ok</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-muted-foreground">
        Showing first {preview.preview.length} of {preview.total_rows}{' '}
        total row{preview.total_rows === 1 ? '' : 's'}.
      </div>

      <div className="flex justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          onClick={onCommit}
          disabled={loading || preview.summary.valid === 0}
          aria-label="import-commit"
        >
          {loading
            ? 'Importing…'
            : `Import ${preview.summary.valid} task${
                preview.summary.valid === 1 ? '' : 's'
              }`}
        </Button>
      </div>
    </div>
  );
}

function SummaryCard(props: {
  label: string;
  value: number;
  tone: 'ok' | 'warn';
}): JSX.Element {
  const toneClass =
    props.tone === 'warn'
      ? 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30'
      : 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30';
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClass}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      <div className="text-2xl font-semibold">{props.value}</div>
    </div>
  );
}

function DoneStep(props: {
  commit: ImportCommitResponse;
  onReset: () => void;
}): JSX.Element {
  const { commit, onReset } = props;
  return (
    <div className="max-w-2xl space-y-4" aria-label="import-step-done">
      <div className="flex items-center gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        <div>
          <div className="text-sm font-medium">Import complete</div>
          <div className="text-xs text-muted-foreground">
            Created {commit.created}, skipped {commit.skipped}, errored{' '}
            {commit.errored}.
          </div>
        </div>
      </div>

      {commit.errors.length > 0 ? (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="text-sm font-medium">Errors</div>
          <ul className="mt-2 space-y-1 text-xs text-destructive">
            {commit.errors.slice(0, 20).map((e) => (
              <li key={e.row_number}>
                Row {e.row_number}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" onClick={onReset}>
          Import more
        </Button>
      </div>
    </div>
  );
}
