/**
 * Delivery view (T693/T694).
 *
 * Queue tab: client delivery items with owner, client, venture, status,
 * deadline and a live SLA timer, filterable by owner role, owner name, SLA
 * state, client and venture. Breached items sort first.
 *
 * Templates tab: the step lists behind each service line. Each step carries
 * a default owner role and SLA; unconfirmed SLAs are flagged until Jack
 * confirms or edits them. Instantiating a template for a client writes its
 * steps into the queue. Each template has an SOP link field (T695).
 */

import { AlertTriangle, ClipboardList, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import {
  useCreateDeliveryItem,
  useDeleteDeliveryItem,
  useDeliveryFacets,
  useDeliveryQueue,
  useDeliveryTemplates,
  useInstantiateDeliveryTemplate,
  useUpdateDeliveryItem,
  useUpdateDeliveryTemplate,
  useUpdateDeliveryTemplateStep,
  type DeliveryQueueFilter,
} from '@/renderer/lib/delivery-query';
import { cn } from '@/renderer/lib/utils';
import {
  DELIVERY_OWNER_LABELS,
  DELIVERY_OWNER_TYPES,
  DELIVERY_STATUSES,
  DELIVERY_STATUS_LABELS,
  SLA_STATE_LABELS,
  UNASSIGNED_OWNER,
  computeSla,
  formatSlaTimer,
  type DeliveryItemWithSla,
  type DeliveryOwnerType,
  type DeliveryStatus,
  type DeliveryTemplateWithSteps,
  type SlaState,
} from '@/shared/delivery';

type Tab = 'queue' | 'templates';

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm';

const SLA_FILTERS: Array<{ value: SlaState | 'all'; label: string }> = [
  { value: 'all', label: 'All open' },
  { value: 'breached', label: 'Breached' },
  { value: 'at_risk', label: 'At risk' },
  { value: 'on_track', label: 'On track' },
  { value: 'none', label: 'No SLA' },
];

const SLA_BADGE: Record<SlaState, string> = {
  breached: 'bg-red-500/15 text-red-600 dark:text-red-400',
  at_risk: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  on_track: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  none: 'bg-muted text-muted-foreground',
  met: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  missed: 'bg-red-500/10 text-red-600 dark:text-red-400',
};

/** Re-render every 30s so SLA timers count down without a refetch. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date input (YYYY-MM-DD) to an ISO timestamp at local end of day. */
function fromDateInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T23:59:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function Delivery(): JSX.Element {
  const [tab, setTab] = useState<Tab>('queue');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6" aria-label="view-delivery">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Delivery</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Client work across the ventures, who holds each item and how much SLA time is left.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-border bg-card p-1">
          {(['queue', 'templates'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium capitalize transition-colors',
                tab === t
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </header>
      {tab === 'queue' ? <QueueTab /> : <TemplatesTab onCreated={() => setTab('queue')} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Queue                                                                     */
/* -------------------------------------------------------------------------- */

function QueueTab(): JSX.Element {
  const [ownerType, setOwnerType] = useState<DeliveryOwnerType | ''>('');
  const [ownerName, setOwnerName] = useState('');
  const [slaState, setSlaState] = useState<SlaState | 'all'>('all');
  const [client, setClient] = useState('');
  const [venture, setVenture] = useState('');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const filter: DeliveryQueueFilter = useMemo(
    () => ({
      ...(ownerType ? { owner_type: ownerType } : {}),
      ...(ownerName ? { owner_name: ownerName } : {}),
      ...(slaState !== 'all' ? { sla_state: [slaState] } : {}),
      ...(client ? { client } : {}),
      ...(venture ? { venture } : {}),
      include_closed: includeClosed,
    }),
    [ownerType, ownerName, slaState, client, venture, includeClosed],
  );

  const queue = useDeliveryQueue(filter);
  const facets = useDeliveryFacets();
  const now = useNow();

  const items = useMemo(
    () => (queue.data?.items ?? []).map((i) => ({ ...i, sla: computeSla(i, now) })),
    [queue.data, now],
  );
  const bySla = queue.data?.summary.by_sla;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" aria-label="delivery-filters">
        <div className="flex flex-wrap gap-1 rounded-md border border-border bg-card p-1">
          {SLA_FILTERS.map((f) => {
            const count =
              f.value === 'all' ? queue.data?.summary.total : bySla ? bySla[f.value] : undefined;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setSlaState(f.value)}
                aria-pressed={slaState === f.value}
                aria-label={`delivery-sla-filter-${f.value}`}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors',
                  slaState === f.value
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                {f.label}
                {count !== undefined ? <span className="ml-1 opacity-70">{count}</span> : null}
              </button>
            );
          })}
        </div>
        <select
          className={SELECT_CLASS}
          value={ownerType}
          onChange={(e) => setOwnerType(e.target.value as DeliveryOwnerType | '')}
          aria-label="delivery-filter-owner-type"
        >
          <option value="">All roles</option>
          {DELIVERY_OWNER_TYPES.map((o) => (
            <option key={o} value={o}>
              {DELIVERY_OWNER_LABELS[o]}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          aria-label="delivery-filter-owner-name"
        >
          <option value="">Anyone</option>
          <option value={UNASSIGNED_OWNER}>Unassigned</option>
          {(facets.data?.owner_names ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          value={client}
          onChange={(e) => setClient(e.target.value)}
          aria-label="delivery-filter-client"
        >
          <option value="">All clients</option>
          {(facets.data?.clients ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className={SELECT_CLASS}
          value={venture}
          onChange={(e) => setVenture(e.target.value)}
          aria-label="delivery-filter-venture"
        >
          <option value="">All ventures</option>
          {(facets.data?.ventures ?? []).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Show closed
        </label>
        <Button size="sm" className="ml-auto" onClick={() => setShowNew((v) => !v)}>
          <Plus /> New item
        </Button>
      </div>

      {showNew ? <NewItemForm ventures={facets.data?.ventures ?? []} onDone={() => setShowNew(false)} /> : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
        {queue.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : queue.isError ? (
          <div className="p-6 text-sm text-red-600">Could not load the queue: {queue.error.message}</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" aria-label="delivery-empty">
            Nothing here. Create an item or instantiate a template for a client.
          </div>
        ) : (
          <table className="w-full text-sm" aria-label="delivery-queue">
            <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">SLA</th>
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Deadline</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <QueueRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function QueueRow({ item }: { item: DeliveryItemWithSla }): JSX.Element {
  const update = useUpdateDeliveryItem();
  const remove = useDeleteDeliveryItem();
  const [ownerName, setOwnerName] = useState(item.owner_name ?? '');
  useEffect(() => setOwnerName(item.owner_name ?? ''), [item.owner_name]);

  const patch = (p: Parameters<typeof update.mutate>[0]['patch']): void =>
    update.mutate({ id: item.id, patch: p });

  return (
    <tr className="border-t border-border align-top" aria-label={`delivery-row-${item.id}`}>
      <td className="whitespace-nowrap px-3 py-2">
        <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', SLA_BADGE[item.sla.state])}>
          {SLA_STATE_LABELS[item.sla.state]}
        </span>
        <div className="mt-1 text-xs text-muted-foreground">{formatSlaTimer(item.sla)}</div>
      </td>
      <td className="max-w-md px-3 py-2">
        <div className="font-medium">{item.title}</div>
        {item.description ? (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={item.description}>
            {item.description}
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <div>{item.client}</div>
        {item.venture ? <div className="text-xs text-muted-foreground">{item.venture}</div> : null}
      </td>
      <td className="px-3 py-2">
        <select
          className={cn(SELECT_CLASS, 'h-8 w-full')}
          value={item.owner_type}
          onChange={(e) => patch({ owner_type: e.target.value as DeliveryOwnerType })}
          aria-label={`delivery-owner-type-${item.id}`}
        >
          {DELIVERY_OWNER_TYPES.map((o) => (
            <option key={o} value={o}>
              {DELIVERY_OWNER_LABELS[o]}
            </option>
          ))}
        </select>
        <Input
          className="mt-1 h-8"
          placeholder="Unassigned"
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          onBlur={() => {
            if (ownerName.trim() !== (item.owner_name ?? '')) patch({ owner_name: ownerName.trim() || null });
          }}
          aria-label={`delivery-owner-name-${item.id}`}
        />
      </td>
      <td className="px-3 py-2">
        <select
          className={cn(SELECT_CLASS, 'h-8')}
          value={item.status}
          onChange={(e) => patch({ status: e.target.value as DeliveryStatus })}
          aria-label={`delivery-status-${item.id}`}
        >
          {DELIVERY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DELIVERY_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <Input
          type="date"
          className="h-8 w-36"
          value={toLocalInput(item.deadline)}
          onChange={(e) => patch({ deadline: fromDateInput(e.target.value) })}
          aria-label={`delivery-deadline-${item.id}`}
        />
      </td>
      <td className="px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`delivery-delete-${item.id}`}
          onClick={() => {
            if (window.confirm(`Delete "${item.title}"?`)) remove.mutate({ id: item.id });
          }}
        >
          <Trash2 />
        </Button>
      </td>
    </tr>
  );
}

function NewItemForm({ ventures, onDone }: { ventures: string[]; onDone: () => void }): JSX.Element {
  const create = useCreateDeliveryItem();
  const [title, setTitle] = useState('');
  const [client, setClient] = useState('');
  const [venture, setVenture] = useState('');
  const [ownerType, setOwnerType] = useState<DeliveryOwnerType>('contractor');
  const [ownerName, setOwnerName] = useState('');
  const [slaHours, setSlaHours] = useState('48');
  const [deadline, setDeadline] = useState('');

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const hours = Number(slaHours);
    create.mutate(
      {
        title,
        client,
        venture: venture || null,
        owner_type: ownerType,
        owner_name: ownerName || null,
        sla_hours: slaHours && hours > 0 ? hours : null,
        deadline: fromDateInput(deadline),
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 md:grid-cols-4"
      aria-label="delivery-new-item"
    >
      <Input className="col-span-2" placeholder="What needs doing" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <Input placeholder="Client" value={client} onChange={(e) => setClient(e.target.value)} required />
      <Input placeholder="Venture" list="delivery-ventures" value={venture} onChange={(e) => setVenture(e.target.value)} />
      <datalist id="delivery-ventures">
        {ventures.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
      <select className={SELECT_CLASS} value={ownerType} onChange={(e) => setOwnerType(e.target.value as DeliveryOwnerType)}>
        {DELIVERY_OWNER_TYPES.map((o) => (
          <option key={o} value={o}>
            {DELIVERY_OWNER_LABELS[o]}
          </option>
        ))}
      </select>
      <Input placeholder="Owner name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        SLA hours
        <Input type="number" min={1} className="w-24" value={slaHours} onChange={(e) => setSlaHours(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Deadline
        <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <div className="col-span-2 flex items-center gap-2 md:col-span-4">
        <Button type="submit" size="sm" disabled={create.isPending}>
          Add to queue
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        {create.isError ? <span className="text-xs text-red-600">{create.error.message}</span> : null}
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Templates                                                                 */
/* -------------------------------------------------------------------------- */

function TemplatesTab({ onCreated }: { onCreated: () => void }): JSX.Element {
  const templates = useDeliveryTemplates();
  if (templates.isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (templates.isError) {
    return <div className="text-sm text-red-600">Could not load templates: {templates.error.message}</div>;
  }
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto" aria-label="delivery-templates">
      {(templates.data?.templates ?? []).map((t) => (
        <TemplateCard key={t.id} template={t} onCreated={onCreated} />
      ))}
    </div>
  );
}

function TemplateCard({
  template,
  onCreated,
}: {
  template: DeliveryTemplateWithSteps;
  onCreated: () => void;
}): JSX.Element {
  const updateTemplate = useUpdateDeliveryTemplate();
  const [sop, setSop] = useState(template.sop_url ?? '');
  useEffect(() => setSop(template.sop_url ?? ''), [template.sop_url]);
  const unconfirmed = template.steps.filter((s) => !s.sla_confirmed).length;

  return (
    <section className="rounded-md border border-border bg-card p-4" aria-label={`delivery-template-${template.slug}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{template.name}</h2>
          <div className="text-xs text-muted-foreground">
            {template.venture ?? 'No venture'} · {template.steps.length} steps
          </div>
          {template.description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{template.description}</p> : null}
          {template.source_ref ? (
            <p className="mt-1 text-xs text-muted-foreground">Steps derived from {template.source_ref}</p>
          ) : null}
        </div>
        {unconfirmed > 0 ? (
          <span className="flex items-center gap-1 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {unconfirmed} default SLA{unconfirmed === 1 ? '' : 's'} to confirm
          </span>
        ) : null}
      </div>

      <label className="mt-3 flex max-w-2xl items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
        SOP link
        <Input
          className="h-8"
          placeholder="Paste the SOP URL"
          value={sop}
          onChange={(e) => setSop(e.target.value)}
          onBlur={() => {
            if (sop.trim() !== (template.sop_url ?? '')) {
              updateTemplate.mutate({ id: template.id, patch: { sop_url: sop.trim() || null } });
            }
          }}
          aria-label={`delivery-sop-${template.slug}`}
        />
        {template.sop_url ? (
          <a className="whitespace-nowrap text-primary underline" href={template.sop_url} target="_blank" rel="noreferrer">
            Open
          </a>
        ) : null}
      </label>

      <ol className="mt-3 divide-y divide-border rounded-md border border-border">
        {template.steps.map((s, i) => (
          <StepRow key={s.id} templateId={template.id} index={i} step={s} />
        ))}
      </ol>

      <InstantiateForm template={template} onCreated={onCreated} />
    </section>
  );
}

function StepRow({
  templateId,
  index,
  step,
}: {
  templateId: string;
  index: number;
  step: DeliveryTemplateWithSteps['steps'][number];
}): JSX.Element {
  const update = useUpdateDeliveryTemplateStep();
  const [hours, setHours] = useState(step.sla_hours === null ? '' : String(step.sla_hours));
  useEffect(() => setHours(step.sla_hours === null ? '' : String(step.sla_hours)), [step.sla_hours]);

  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
      <span className="w-6 text-xs text-muted-foreground">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{step.title}</div>
        {step.description ? <div className="text-xs text-muted-foreground">{step.description}</div> : null}
      </div>
      <select
        className={cn(SELECT_CLASS, 'h-8')}
        value={step.owner_role}
        onChange={(e) =>
          update.mutate({ templateId, stepId: step.id, patch: { owner_role: e.target.value as DeliveryOwnerType } })
        }
        aria-label={`delivery-step-role-${step.id}`}
      >
        {DELIVERY_OWNER_TYPES.map((o) => (
          <option key={o} value={o}>
            {DELIVERY_OWNER_LABELS[o]}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        <Input
          type="number"
          min={1}
          className="h-8 w-20"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          onBlur={() => {
            const n = Number(hours);
            const next = hours === '' ? null : n > 0 ? n : step.sla_hours;
            if (next !== step.sla_hours) update.mutate({ templateId, stepId: step.id, patch: { sla_hours: next } });
          }}
          aria-label={`delivery-step-sla-${step.id}`}
        />
        h SLA
      </label>
      {step.sla_confirmed ? (
        <span className="w-28 text-xs text-muted-foreground">Confirmed</span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-28"
          onClick={() => update.mutate({ templateId, stepId: step.id, patch: { sla_confirmed: true } })}
          aria-label={`delivery-step-confirm-${step.id}`}
        >
          Confirm default
        </Button>
      )}
    </li>
  );
}

function InstantiateForm({
  template,
  onCreated,
}: {
  template: DeliveryTemplateWithSteps;
  onCreated: () => void;
}): JSX.Element {
  const instantiate = useInstantiateDeliveryTemplate();
  const [client, setClient] = useState('');
  const [contractor, setContractor] = useState('');
  const [offshore, setOffshore] = useState('');
  const [start, setStart] = useState('');
  const [sections, setSections] = useState<string[]>(template.sections);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const startIso = start ? new Date(`${start}T09:00:00`).toISOString() : undefined;
    instantiate.mutate(
      {
        id: template.id,
        input: {
          client,
          ...(startIso ? { start_at: startIso } : {}),
          assignees: {
            ...(contractor ? { contractor } : {}),
            ...(offshore ? { offshore } : {}),
          },
          ...(template.sections.length > 0 ? { sections } : {}),
        },
      },
      {
        onSuccess: () => {
          setClient('');
          onCreated();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2" aria-label={`delivery-instantiate-${template.slug}`}>
      <Input className="w-56" placeholder="Client" value={client} onChange={(e) => setClient(e.target.value)} required />
      <Input className="w-40" placeholder="Contractor name" value={contractor} onChange={(e) => setContractor(e.target.value)} />
      <Input className="w-40" placeholder="Offshore name" value={offshore} onChange={(e) => setOffshore(e.target.value)} />
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        Start
        <Input type="date" className="w-40" value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      {template.sections.map((s) => (
        <label key={s} className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={sections.includes(s)}
            onChange={(e) =>
              setSections((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
            }
          />
          {s}
        </label>
      ))}
      <Button
        type="submit"
        size="sm"
        disabled={instantiate.isPending || (template.sections.length > 0 && sections.length === 0)}
      >
        Create queue items
      </Button>
      {instantiate.isError ? <span className="text-xs text-red-600">{instantiate.error.message}</span> : null}
    </form>
  );
}
