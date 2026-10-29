/**
 * Renewals view (T704).
 *
 * Table of client renewals (licenses, CAQH, DEA, risk assessments, BAAs,
 * site rescans, custom) with state, next reminder and the Delivery queue item
 * for the current cycle. Reminders panel above the table; add form and CSV
 * import below the filters. State and next reminder come from the API, which
 * uses the same shared helpers as the engine.
 */

import { Bell, Check, Play, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  useAckReminder,
  useCreateRenewal,
  useDeleteRenewal,
  useImportRenewals,
  useMarkRenewed,
  useRenewalReminders,
  useRenewals,
  useRenewalsMeta,
  useRunRenewalEngine,
  useUpdateRenewal,
  type ImportResult,
} from '@/renderer/lib/renewals-query';
import { cn } from '@/renderer/lib/utils';
import { DELIVERY_OWNER_LABELS, DELIVERY_OWNER_TYPES, type DeliveryOwnerType } from '@/shared/delivery';
import {
  RENEWAL_ITEM_TYPES,
  RENEWAL_ITEM_TYPE_LABELS,
  RENEWAL_STATE_LABELS,
  RENEWAL_TYPE_DEFAULTS,
  describeRecurrence,
  parseRecurrence,
  type RenewalItemType,
  type RenewalState,
  type RenewalWithSchedule,
} from '@/shared/renewals';

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

const STATE_BADGE: Record<RenewalState, string> = {
  overdue: 'bg-red-500/15 text-red-600 dark:text-red-400',
  due_soon: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  upcoming: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  inactive: 'bg-muted text-muted-foreground',
};

const STATE_FILTERS: Array<{ value: RenewalState | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due_soon', label: 'Due soon' },
  { value: 'upcoming', label: 'Upcoming' },
];

const CSV_EXAMPLE = `client,item_type,label,due_date,recurrence,lead_times,owner_type,owner_name,client_visible
Practice A,dea,Dr. Lee DEA,2027-03-01,3y,90/60/30,jack,,yes
Practice A,caqh_attestation,Dr. Lee CAQH,2027-01-15,120d,30/14/7,offshore,,no`;

function safeDescribe(recurrence: string): string {
  try {
    return describeRecurrence(parseRecurrence(recurrence));
  } catch {
    return recurrence;
  }
}

function dueLabel(r: RenewalWithSchedule): string {
  const d = r.schedule.days_until;
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return 'due today';
  return `in ${d}d`;
}

export default function Renewals(): JSX.Element {
  const [client, setClient] = useState('');
  const [state, setState] = useState<RenewalState | 'all'>('all');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [panel, setPanel] = useState<'none' | 'new' | 'import'>('none');

  const filter = useMemo(
    () => ({
      ...(client ? { client } : {}),
      ...(state !== 'all' ? { state } : {}),
      include_inactive: includeInactive,
    }),
    [client, state, includeInactive],
  );
  const renewals = useRenewals(filter);
  const meta = useRenewalsMeta();
  const runEngine = useRunRenewalEngine();

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6" aria-label="view-renewals">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Renewals</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Licenses, attestations and recurring client checks. Reminders fire at each lead time and the first one
            opens a Delivery queue item.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => runEngine.mutate()}
            disabled={runEngine.isPending}
            aria-label="renewals-run-engine"
          >
            <Play /> Run now
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPanel((p) => (p === 'import' ? 'none' : 'import'))}>
            <Upload /> Import CSV
          </Button>
          <Button size="sm" onClick={() => setPanel((p) => (p === 'new' ? 'none' : 'new'))}>
            <Plus /> New renewal
          </Button>
        </div>
      </header>

      {runEngine.data ? (
        <div className="text-xs text-muted-foreground" aria-label="renewals-run-result">
          Checked {runEngine.data.checked}. {runEngine.data.reminders.length} new reminder
          {runEngine.data.reminders.length === 1 ? '' : 's'}, {runEngine.data.created_items.length} queue item
          {runEngine.data.created_items.length === 1 ? '' : 's'} created, {runEngine.data.rolled.length} rolled to the
          next cycle.
        </div>
      ) : null}

      <RemindersPanel />

      <div className="flex flex-wrap items-center gap-2" aria-label="renewals-filters">
        <div className="flex gap-1 rounded-md border border-border bg-card p-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setState(f.value)}
              aria-pressed={state === f.value}
              aria-label={`renewals-state-filter-${f.value}`}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition-colors',
                state === f.value
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          className={SELECT_CLASS}
          value={client}
          onChange={(e) => setClient(e.target.value)}
          aria-label="renewals-filter-client"
        >
          <option value="">All clients</option>
          {(meta.data?.clients ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show inactive
        </label>
      </div>

      {panel === 'new' ? <NewRenewalForm clients={meta.data?.clients ?? []} onDone={() => setPanel('none')} /> : null}
      {panel === 'import' ? <ImportPanel onDone={() => setPanel('none')} /> : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        {renewals.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : renewals.isError ? (
          <div className="p-6 text-sm text-red-600">Could not load renewals: {renewals.error.message}</div>
        ) : (renewals.data?.renewals ?? []).length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" aria-label="renewals-empty">
            No renewals yet. Add one or import a CSV.
          </div>
        ) : (
          <table className="w-full text-sm" aria-label="renewals-table">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Renewal</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 font-medium">Cadence</th>
                <th className="px-3 py-2 font-medium">Next reminder</th>
                <th className="px-3 py-2 font-medium">Portal</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {(renewals.data?.renewals ?? []).map((r) => (
                <RenewalRow key={r.id} renewal={r} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RemindersPanel(): JSX.Element | null {
  const reminders = useRenewalReminders();
  const ack = useAckReminder();
  const list = reminders.data?.reminders ?? [];
  if (list.length === 0) return null;
  return (
    <section className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3" aria-label="renewals-reminders">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Bell className="h-4 w-4" /> {list.length} reminder{list.length === 1 ? '' : 's'}
      </h2>
      <ul className="space-y-1">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">{r.client}</span>: {RENEWAL_ITEM_TYPE_LABELS[r.item_type]} for {r.label} due{' '}
              {r.cycle_due_date} ({r.lead_days}-day reminder)
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => ack.mutate({ id: r.id })}
              aria-label={`renewals-ack-${r.id}`}
            >
              <Check /> Got it
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RenewalRow({ renewal: r }: { renewal: RenewalWithSchedule }): JSX.Element {
  const update = useUpdateRenewal();
  const remove = useDeleteRenewal();
  const renew = useMarkRenewed();
  const [editingLeads, setEditingLeads] = useState(false);
  const [leads, setLeads] = useState(r.lead_times.join('/'));

  return (
    <tr className="border-t border-border align-top" aria-label={`renewal-row-${r.id}`}>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', STATE_BADGE[r.schedule.state])}>
          {RENEWAL_STATE_LABELS[r.schedule.state]}
        </span>
        {r.current_item_id ? <div className="mt-1 text-xs text-muted-foreground">In Delivery queue</div> : null}
      </td>
      <td className="max-w-xs px-3 py-2">
        <div className="font-medium">{r.label}</div>
        <div className="text-xs text-muted-foreground">
          {RENEWAL_ITEM_TYPE_LABELS[r.item_type]} · {DELIVERY_OWNER_LABELS[r.owner_type]}
          {r.owner_name ? ` (${r.owner_name})` : ''}
        </div>
      </td>
      <td className="px-3 py-2">
        <div>{r.client}</div>
        {r.venture ? <div className="text-xs text-muted-foreground">{r.venture}</div> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        <Input
          type="date"
          className="h-8 w-36"
          value={r.due_date}
          onChange={(e) => e.target.value && update.mutate({ id: r.id, patch: { due_date: e.target.value } })}
          aria-label={`renewal-due-${r.id}`}
        />
        <div className="mt-1 text-xs text-muted-foreground">{r.active ? dueLabel(r) : ''}</div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs">
        <div>{safeDescribe(r.recurrence)}</div>
        {editingLeads ? (
          <Input
            autoFocus
            className="mt-1 h-7 w-28"
            value={leads}
            onChange={(e) => setLeads(e.target.value)}
            onBlur={() => {
              setEditingLeads(false);
              if (leads !== r.lead_times.join('/')) update.mutate({ id: r.id, patch: { lead_times: leads } });
            }}
            aria-label={`renewal-leads-${r.id}`}
          />
        ) : (
          <button
            type="button"
            className="mt-1 text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setEditingLeads(true)}
            title="Edit lead times"
          >
            Leads {r.lead_times.join('/')}d
          </button>
        )}
        {update.isError ? <div className="text-red-600">{update.error.message}</div> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
        {r.schedule.next_reminder
          ? `${r.schedule.next_reminder.trigger_date} (${r.schedule.next_reminder.lead_days}d)`
          : 'None left'}
      </td>
      <td className="px-3 py-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={r.client_visible}
            onChange={(e) => update.mutate({ id: r.id, patch: { client_visible: e.target.checked } })}
            aria-label={`renewal-visible-${r.id}`}
          />
          Visible
        </label>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {r.active ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => renew.mutate({ id: r.id })}
            disabled={renew.isPending}
            title={r.schedule.next_due_date ? `Next due ${r.schedule.next_due_date}` : 'One-time: marks inactive'}
            aria-label={`renewal-renew-${r.id}`}
          >
            <Check /> Renewed
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update.mutate({ id: r.id, patch: { active: true } })}
            aria-label={`renewal-reactivate-${r.id}`}
          >
            Reactivate
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`renewal-delete-${r.id}`}
          onClick={() => {
            if (window.confirm(`Delete "${r.label}" for ${r.client}?`)) remove.mutate({ id: r.id });
          }}
        >
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

function NewRenewalForm({ clients, onDone }: { clients: string[]; onDone: () => void }): JSX.Element {
  const create = useCreateRenewal();
  const [client, setClient] = useState('');
  const [itemType, setItemType] = useState<RenewalItemType>('state_license');
  const [label, setLabel] = useState('');
  const [due, setDue] = useState('');
  const [recurrence, setRecurrence] = useState(RENEWAL_TYPE_DEFAULTS.state_license.recurrence);
  const [leads, setLeads] = useState(RENEWAL_TYPE_DEFAULTS.state_license.lead_times.join('/'));
  const [ownerType, setOwnerType] = useState<DeliveryOwnerType>('jack');
  const [ownerName, setOwnerName] = useState('');
  const [visible, setVisible] = useState(false);

  const pickType = (t: RenewalItemType): void => {
    setItemType(t);
    setRecurrence(RENEWAL_TYPE_DEFAULTS[t].recurrence);
    setLeads(RENEWAL_TYPE_DEFAULTS[t].lead_times.join('/'));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          {
            client,
            item_type: itemType,
            label,
            due_date: due,
            recurrence,
            lead_times: leads,
            owner_type: ownerType,
            owner_name: ownerName || null,
            client_visible: visible,
          },
          { onSuccess: onDone },
        );
      }}
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 md:grid-cols-4"
      aria-label="renewals-new"
    >
      <Input placeholder="Client" list="renewal-clients" value={client} onChange={(e) => setClient(e.target.value)} required />
      <datalist id="renewal-clients">
        {clients.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <select className={SELECT_CLASS} value={itemType} onChange={(e) => pickType(e.target.value as RenewalItemType)}>
        {RENEWAL_ITEM_TYPES.map((t) => (
          <option key={t} value={t}>
            {RENEWAL_ITEM_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <Input
        className="col-span-2"
        placeholder="What is renewed (e.g. NY license, Dr. Kim)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        required
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Due
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Repeats
        <Input className="w-24" placeholder="2y" value={recurrence} onChange={(e) => setRecurrence(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Lead days
        <Input className="w-28" placeholder="90/60/30" value={leads} onChange={(e) => setLeads(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        Show on client portal
      </label>
      <select className={SELECT_CLASS} value={ownerType} onChange={(e) => setOwnerType(e.target.value as DeliveryOwnerType)}>
        {DELIVERY_OWNER_TYPES.map((o) => (
          <option key={o} value={o}>
            {DELIVERY_OWNER_LABELS[o]}
          </option>
        ))}
      </select>
      <Input placeholder="Owner name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
      <div className="col-span-2 flex items-center gap-2">
        <Button type="submit" size="sm" disabled={create.isPending}>
          Add renewal
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {create.isError ? <span className="text-xs text-red-600">{create.error.message}</span> : null}
      </div>
    </form>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }): JSX.Element {
  const importer = useImportRenewals();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setCsv(await file.text());
    setPreview(null);
  };

  return (
    <section className="space-y-2 rounded-md border border-border bg-card p-3" aria-label="renewals-import">
      <p className="text-xs text-muted-foreground">
        Required columns: client, item_type, label, due_date. Optional: recurrence (none, 120d, 3m, 2y), lead_times
        (90/60/30), owner_type, owner_name, venture, notes, client_visible. Rows already present are skipped.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} className="text-xs" />
      <Textarea
        rows={6}
        className="font-mono text-xs"
        placeholder={CSV_EXAMPLE}
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          setPreview(null);
        }}
        aria-label="renewals-import-csv"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!csv.trim() || importer.isPending}
          onClick={() => importer.mutate({ csv, dry_run: true }, { onSuccess: setPreview })}
        >
          Check
        </Button>
        <Button
          size="sm"
          disabled={!preview || preview.errors > 0 || importer.isPending}
          onClick={() =>
            importer.mutate(
              { csv },
              {
                onSuccess: (res) => {
                  setPreview(res);
                  if (!res.dry_run) onDone();
                },
              },
            )
          }
        >
          Import
        </Button>
        {preview && preview.errors > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={importer.isPending}
            onClick={() => importer.mutate({ csv, skip_invalid: true }, { onSuccess: () => onDone() })}
          >
            Import valid rows only
          </Button>
        ) : null}
        {importer.isError ? <span className="text-xs text-red-600">{importer.error.message}</span> : null}
      </div>
      {preview ? (
        <div className="text-xs" aria-label="renewals-import-preview">
          <div className="text-muted-foreground">
            {preview.rows.filter((r) => r.status === 'ok').length} ready, {preview.duplicates} duplicate
            {preview.duplicates === 1 ? '' : 's'}, {preview.errors} error{preview.errors === 1 ? '' : 's'}.
          </div>
          <ul className="mt-1 space-y-0.5">
            {preview.rows
              .filter((r) => r.status === 'error')
              .map((r) => (
                <li key={r.line} className="text-red-600">
                  Line {r.line}: {r.error}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
