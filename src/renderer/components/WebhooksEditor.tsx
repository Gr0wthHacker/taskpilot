/**
 * Settings → Integrations → Generic Webhooks.
 *
 * Lists every configured webhook plus a "+ Add" button that opens an
 * editor for a single config. The editor is a controlled form with a
 * JSON textarea for the mapping rules — keeping mapping editing out of
 * a fancier UI tree means the user can copy-paste rule sets between
 * configs and version-control them externally.
 *
 * The shared secret is write-only from the renderer's perspective:
 * the API returns `has_secret: true/false` (never the secret itself).
 * The editor's secret input is blank on open even when one is stored;
 * leaving it blank during save keeps the existing secret.
 *
 * Wave 13 — Agent M.
 */

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Plus,
  TestTube2,
  Trash2,
  Webhook,
} from 'lucide-react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/renderer/components/ui/select';
import { useToast } from '@/renderer/components/ui/use-toast';
import {
  useCreateWebhookConfig,
  useDeleteWebhookConfig,
  useTestWebhookConfig,
  useUpdateWebhookConfig,
  useWebhookConfigs,
} from '@/renderer/lib/query';
import type {
  WebhookConfigPublic,
  WebhookMappingRule,
} from '@/shared/api-contract';

/* -------------------------------------------------------------------------- */
/*  Top-level                                                                 */
/* -------------------------------------------------------------------------- */

export function WebhooksEditor(): JSX.Element {
  const configsQ = useWebhookConfigs();
  const [editing, setEditing] = useState<WebhookConfigPublic | null>(null);
  const [creating, setCreating] = useState(false);

  const configs = configsQ.data?.configs ?? [];

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background/40"
      aria-label="settings-webhooks-card"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Webhook className="h-5 w-5" aria-hidden="true" />
        <div className="flex-1">
          <div className="text-sm font-medium">Generic webhooks</div>
          <div className="text-xs text-muted-foreground">
            Map any external service's payload into TaskPilot tasks.
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditing(null);
            setCreating(true);
          }}
          aria-label="webhooks-add"
        >
          <Plus className="mr-1 h-4 w-4" />
          Add
        </Button>
      </div>

      <div className="space-y-2 px-4 py-3">
        {configsQ.isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : configs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No webhooks configured. Click <strong>Add</strong> to create one.
          </div>
        ) : (
          configs.map((c) => (
            <ConfigRow
              key={c.id}
              config={c}
              onEdit={() => {
                setCreating(false);
                setEditing(c);
              }}
            />
          ))
        )}
      </div>

      {(editing || creating) && (
        <ConfigEditor
          existing={editing}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Row                                                                       */
/* -------------------------------------------------------------------------- */

function ConfigRow(props: {
  config: WebhookConfigPublic;
  onEdit: () => void;
}): JSX.Element {
  const { config, onEdit } = props;
  const url = `/api/webhooks/incoming/${config.name}`;
  const deleteMut = useDeleteWebhookConfig();
  const { toast } = useToast();

  const handleDelete = async (ev: React.MouseEvent): Promise<void> => {
    ev.stopPropagation();
    if (!window.confirm(`Delete webhook "${config.name}"?`)) return;
    try {
      await deleteMut.mutateAsync({ id: config.id });
      toast({ title: 'Webhook deleted' });
    } catch (cause) {
      toast({
        title: 'Delete failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-accent/40"
      aria-label={`webhooks-row-${config.name}`}
    >
      <div className="flex-1">
        <div className="text-sm font-medium">
          {config.name}
          {!config.enabled ? (
            <span className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">
              disabled
            </span>
          ) : null}
          {!config.has_secret && config.signature_algorithm !== 'none' ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
              <AlertCircle className="h-3 w-3" />
              missing secret
            </span>
          ) : null}
        </div>
        <code className="text-[10px] text-muted-foreground">{url}</code>
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {config.mapping_rules.length} rule
        {config.mapping_rules.length === 1 ? '' : 's'}
      </div>
      <Trash2
        className="h-4 w-4 text-muted-foreground hover:text-destructive"
        onClick={(ev) => void handleDelete(ev)}
        aria-label={`webhooks-delete-${config.name}`}
      />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editor                                                                    */
/* -------------------------------------------------------------------------- */

interface EditorFormState {
  name: string;
  secret: string;
  signature_header: string;
  signature_algorithm: 'sha256' | 'sha1' | 'none';
  rules_json: string;
  enabled: boolean;
}

function defaultRules(): WebhookMappingRule[] {
  return [
    {
      match: { path: 'action', equals: 'created' },
      action: 'create_task',
      template: {
        title: 'New event: {{title}}',
        description: '{{body}}',
        priority: 'p2',
      },
    },
  ];
}

function ConfigEditor(props: {
  existing: WebhookConfigPublic | null;
  onClose: () => void;
}): JSX.Element {
  const { existing, onClose } = props;
  const { toast } = useToast();
  const createMut = useCreateWebhookConfig();
  const updateMut = useUpdateWebhookConfig();
  const testMut = useTestWebhookConfig();

  const [form, setForm] = useState<EditorFormState>(() => ({
    name: existing?.name ?? '',
    secret: '',
    signature_header: existing?.signature_header ?? 'X-Signature-256',
    signature_algorithm: existing?.signature_algorithm ?? 'sha256',
    rules_json: JSON.stringify(
      existing?.mapping_rules ?? defaultRules(),
      null,
      2,
    ),
    enabled: existing?.enabled ?? true,
  }));
  const [testPayload, setTestPayload] = useState('{\n  "action": "created"\n}');
  const [testResult, setTestResult] = useState<unknown>(null);

  const parsedRules = useMemo((): {
    ok: boolean;
    rules?: WebhookMappingRule[];
    error?: string;
  } => {
    try {
      const parsed = JSON.parse(form.rules_json);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: 'Rules must be an array' };
      }
      return { ok: true, rules: parsed as WebhookMappingRule[] };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid JSON',
      };
    }
  }, [form.rules_json]);

  const handleSave = async (): Promise<void> => {
    if (!parsedRules.ok) {
      toast({ title: parsedRules.error ?? 'Invalid rules', variant: 'destructive' });
      return;
    }
    try {
      if (existing) {
        await updateMut.mutateAsync({
          id: existing.id,
          patch: {
            name: form.name,
            // Empty string means "don't change". Send null to clear.
            secret: form.secret.length > 0 ? form.secret : undefined,
            signature_header: form.signature_header,
            signature_algorithm: form.signature_algorithm,
            mapping_rules: parsedRules.rules,
            enabled: form.enabled,
          },
        });
        toast({ title: 'Webhook updated' });
      } else {
        await createMut.mutateAsync({
          name: form.name,
          secret: form.secret.length > 0 ? form.secret : undefined,
          signature_header: form.signature_header,
          signature_algorithm: form.signature_algorithm,
          mapping_rules: parsedRules.rules,
          enabled: form.enabled,
        });
        toast({ title: 'Webhook created' });
      }
      onClose();
    } catch (cause) {
      toast({
        title: 'Save failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleTest = async (): Promise<void> => {
    if (!existing) {
      toast({
        title: 'Save first',
        description: 'The webhook needs to exist before you can test it.',
        variant: 'destructive',
      });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(testPayload);
    } catch (err) {
      toast({
        title: 'Test payload is not valid JSON',
        description: err instanceof Error ? err.message : 'parse error',
        variant: 'destructive',
      });
      return;
    }
    try {
      const res = await testMut.mutateAsync({
        id: existing.id,
        body: { payload },
      });
      setTestResult(res);
    } catch (cause) {
      toast({
        title: 'Test failed',
        description: cause instanceof Error ? cause.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  return (
    <div
      className="border-t border-border bg-muted/30 p-4"
      aria-label="webhooks-editor"
    >
      <div className="mb-3 text-sm font-medium">
        {existing ? `Edit "${existing.name}"` : 'New webhook'}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name (URL segment)">
          <Input
            value={form.name}
            onChange={(e) =>
              setForm((f) => ({ ...f, name: e.target.value }))
            }
            placeholder="linear-issues"
            aria-label="webhooks-name"
          />
        </Field>
        <Field label="Algorithm">
          <Select
            value={form.signature_algorithm}
            onValueChange={(v) =>
              setForm((f) => ({
                ...f,
                signature_algorithm: v as EditorFormState['signature_algorithm'],
              }))
            }
          >
            <SelectTrigger aria-label="webhooks-algorithm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sha256">HMAC SHA-256</SelectItem>
              <SelectItem value="sha1">HMAC SHA-1</SelectItem>
              <SelectItem value="none">None (trusted network)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Signature header">
          <Input
            value={form.signature_header}
            onChange={(e) =>
              setForm((f) => ({ ...f, signature_header: e.target.value }))
            }
            placeholder="X-Signature-256"
            aria-label="webhooks-signature-header"
          />
        </Field>
        <Field
          label={
            existing && existing.has_secret
              ? 'Secret (leave blank to keep existing)'
              : 'Shared secret'
          }
        >
          <Input
            type="password"
            value={form.secret}
            onChange={(e) =>
              setForm((f) => ({ ...f, secret: e.target.value }))
            }
            autoComplete="off"
            aria-label="webhooks-secret"
          />
        </Field>
      </div>

      <Field label="Mapping rules (JSON)" className="mt-3">
        <textarea
          value={form.rules_json}
          onChange={(e) =>
            setForm((f) => ({ ...f, rules_json: e.target.value }))
          }
          className="h-48 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          aria-label="webhooks-rules"
        />
        {!parsedRules.ok ? (
          <div className="mt-1 text-xs text-destructive">
            {parsedRules.error}
          </div>
        ) : null}
      </Field>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) =>
            setForm((f) => ({ ...f, enabled: e.target.checked }))
          }
          id="webhooks-enabled"
        />
        <label htmlFor="webhooks-enabled" className="text-xs">
          Enabled
        </label>
      </div>

      {existing ? (
        <div className="mt-4 rounded-md border border-dashed border-border bg-background/40 p-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Test payload (dry-run, no DB writes)
          </div>
          <textarea
            value={testPayload}
            onChange={(e) => setTestPayload(e.target.value)}
            className="h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
            aria-label="webhooks-test-payload"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testMut.isPending}
              aria-label="webhooks-test"
            >
              <TestTube2 className="mr-1 h-4 w-4" />
              {testMut.isPending ? 'Testing…' : 'Run test'}
            </Button>
            {testResult ? (
              <code className="rounded bg-background px-2 py-1 text-[10px]">
                {JSON.stringify(testResult)}
              </code>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={
            createMut.isPending || updateMut.isPending || !parsedRules.ok
          }
          aria-label="webhooks-save"
        >
          {existing ? 'Save changes' : 'Create webhook'}
        </Button>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`space-y-1 ${props.className ?? ''}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </div>
      {props.children}
    </div>
  );
}
