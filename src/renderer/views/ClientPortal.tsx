/**
 * Client portal admin (T707; monthly notes block for T703).
 *
 * Pick a client, then:
 *  - Share links: create a signed link with an expiry, copy it, revoke it.
 *  - Queue items: choose which items the client sees and attach a
 *    deliverable link.
 *  - Entries: findings, deliverable links, next steps and monthly notes.
 *    Each starts hidden until "Visible" is ticked.
 *  - Preview: exactly what the client page shows, from the same API view
 *    the public page renders.
 */

import { Copy, Eye, Link2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/renderer/components/ui/button';
import { Input } from '@/renderer/components/ui/input';
import { Textarea } from '@/renderer/components/ui/textarea';
import {
  useClientDeliveryItems,
  useCreatePortalEntry,
  useCreatePortalLink,
  useDeletePortalEntry,
  usePortalClients,
  usePortalEntries,
  usePortalLinks,
  usePortalPreview,
  useRevokePortalLink,
  useSetItemVisibility,
  useUpdatePortalEntry,
} from '@/renderer/lib/renewals-query';
import { cn } from '@/renderer/lib/utils';
import { DELIVERY_STATUS_LABELS, type DeliveryItemWithSla } from '@/shared/delivery';
import {
  PORTAL_ENTRY_KINDS,
  PORTAL_ENTRY_KIND_LABELS,
  PORTAL_WORK_STATUS_LABELS,
  type PortalEntry,
  type PortalEntryKind,
  type PortalLinkItem,
  type PortalView,
} from '@/shared/portal';
import { RENEWAL_STATE_LABELS, monthOf } from '@/shared/renewals';

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
const CARD = 'rounded-md border border-border bg-card p-4';

export default function ClientPortal(): JSX.Element {
  const clients = usePortalClients();
  const [client, setClient] = useState('');
  const [month, setMonth] = useState(() => monthOf());
  const list = useMemo(() => clients.data?.clients ?? [], [clients.data]);

  useEffect(() => {
    if (!client && list.length > 0) setClient(list[0]!);
  }, [client, list]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6" aria-label="view-client-portal">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight">Client portal</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            A read-only page per client. Only items you mark visible are shown.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={SELECT_CLASS}
            value={client}
            onChange={(e) => setClient(e.target.value)}
            aria-label="portal-client"
          >
            {list.length === 0 ? <option value="">No clients yet</option> : null}
            {list.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input
            type="month"
            className="h-9 w-40"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="portal-month"
          />
        </div>
      </header>

      {client ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="space-y-4">
            <LinksCard client={client} />
            <EntriesCard client={client} month={month} />
            <ItemsCard client={client} />
          </div>
          <PreviewCard client={client} month={month} />
        </div>
      ) : (
        <div className="p-10 text-center text-sm text-muted-foreground">
          Clients appear here once they have queue items, renewals or portal entries.
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function LinksCard({ client }: { client: string }): JSX.Element {
  const links = usePortalLinks(client);
  const create = useCreatePortalLink();
  const revoke = useRevokePortalLink();
  const [days, setDays] = useState('30');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, url: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  return (
    <section className={CARD} aria-label="portal-links">
      <h2 className="mb-2 flex items-center gap-1.5 font-semibold">
        <Link2 className="h-4 w-4" /> Share links
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Expires in
          <Input type="number" min={1} max={365} className="h-8 w-20" value={days} onChange={(e) => setDays(e.target.value)} />
          days
        </label>
        <Button
          size="sm"
          disabled={create.isPending || !(Number(days) >= 1 && Number(days) <= 365)}
          onClick={() => create.mutate({ client, expires_in_days: Math.round(Number(days)) })}
          aria-label="portal-create-link"
        >
          <Plus /> New link
        </Button>
        {create.isError ? <span className="text-xs text-red-600">{create.error.message}</span> : null}
      </div>
      <ul className="mt-3 divide-y divide-border text-sm">
        {(links.data?.links ?? []).map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <span
                className={cn(
                  'mr-2 rounded px-1.5 py-0.5 text-xs font-medium',
                  l.status === 'active'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {l.status}
              </span>
              <span className="text-xs text-muted-foreground">
                expires {l.expires_at.slice(0, 10)} · {l.view_count} view{l.view_count === 1 ? '' : 's'}
              </span>
            </div>
            {l.status === 'active' ? (
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => void copy(l.id, l.url)} aria-label={`portal-copy-${l.id}`}>
                  <Copy /> {copied === l.id ? 'Copied' : 'Copy'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm('Turn off this link? Anyone holding it loses access.')) revoke.mutate({ id: l.id });
                  }}
                  aria-label={`portal-revoke-${l.id}`}
                >
                  Revoke
                </Button>
              </div>
            ) : null}
          </li>
        ))}
        {(links.data?.links ?? []).length === 0 ? (
          <li className="py-2 text-xs text-muted-foreground">No links yet.</li>
        ) : null}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function EntriesCard({ client, month }: { client: string; month: string }): JSX.Element {
  const entries = usePortalEntries(client, month);
  const create = useCreatePortalEntry();
  const [kind, setKind] = useState<PortalEntryKind>('monthly_note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');

  const grouped = PORTAL_ENTRY_KINDS.map((k) => ({
    kind: k,
    items: (entries.data?.entries ?? []).filter((e) => e.kind === k),
  }));

  return (
    <section className={CARD} aria-label="portal-entries">
      <h2 className="mb-2 font-semibold">Notes, findings and next steps</h2>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(
            {
              client,
              kind,
              title,
              body: body || null,
              url: url || null,
              month: kind === 'next_step' ? null : month,
            },
            {
              onSuccess: () => {
                setTitle('');
                setBody('');
                setUrl('');
              },
            },
          );
        }}
      >
        <div className="flex flex-wrap gap-2">
          <select className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as PortalEntryKind)}>
            {PORTAL_ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {PORTAL_ENTRY_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <Input className="min-w-48 flex-1" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <Textarea rows={3} placeholder="Details (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-48 flex-1" placeholder="Link (https://…, optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button type="submit" size="sm" disabled={create.isPending}>
            <Plus /> Add
          </Button>
        </div>
        {create.isError ? <span className="text-xs text-red-600">{create.error.message}</span> : null}
        <p className="text-xs text-muted-foreground">
          New entries are hidden. Findings, deliverables and monthly notes belong to the month above; next steps stay
          until marked done.
        </p>
      </form>
      <div className="mt-3 space-y-3">
        {grouped
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div key={g.kind}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {PORTAL_ENTRY_KIND_LABELS[g.kind]}
              </h3>
              <ul className="divide-y divide-border">
                {g.items.map((e) => (
                  <EntryRow key={e.id} entry={e} />
                ))}
              </ul>
            </div>
          ))}
      </div>
    </section>
  );
}

function EntryRow({ entry: e }: { entry: PortalEntry }): JSX.Element {
  const update = useUpdatePortalEntry();
  const remove = useDeletePortalEntry();
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm" aria-label={`portal-entry-${e.id}`}>
      <div className="min-w-0 flex-1">
        <div className={cn('font-medium', e.done && 'line-through opacity-60')}>{e.title}</div>
        {e.body ? <div className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{e.body}</div> : null}
        {e.url ? <div className="truncate text-xs text-muted-foreground">{e.url}</div> : null}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={e.client_visible}
            onChange={(ev) => update.mutate({ id: e.id, patch: { client_visible: ev.target.checked } })}
            aria-label={`portal-entry-visible-${e.id}`}
          />
          Visible
        </label>
        {e.kind === 'next_step' ? (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={e.done}
              onChange={(ev) => update.mutate({ id: e.id, patch: { done: ev.target.checked } })}
            />
            Done
          </label>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`portal-entry-delete-${e.id}`}
          onClick={() => {
            if (window.confirm(`Delete "${e.title}"?`)) remove.mutate({ id: e.id });
          }}
        >
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

function ItemsCard({ client }: { client: string }): JSX.Element {
  const items = useClientDeliveryItems(client);
  const list = (items.data?.items ?? []).filter((i) => i.status !== 'cancelled');
  return (
    <section className={CARD} aria-label="portal-items">
      <h2 className="mb-1 font-semibold">Queue items</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Visible items show by title and status only. Descriptions and owner names stay internal.
      </p>
      {list.length === 0 ? (
        <div className="text-xs text-muted-foreground">No queue items for this client.</div>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ item }: { item: DeliveryItemWithSla }): JSX.Element {
  const setVis = useSetItemVisibility();
  const [url, setUrl] = useState(item.deliverable_url ?? '');
  useEffect(() => setUrl(item.deliverable_url ?? ''), [item.deliverable_url]);
  return (
    <li className="grid gap-1 py-2 text-sm md:grid-cols-[1fr_auto]" aria-label={`portal-item-${item.id}`}>
      <div className="min-w-0">
        <div className="font-medium">{item.title}</div>
        <div className="text-xs text-muted-foreground">{DELIVERY_STATUS_LABELS[item.status]}</div>
        <Input
          className="mt-1 h-7 text-xs"
          placeholder="Deliverable link (optional)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => {
            if (url.trim() !== (item.deliverable_url ?? '')) setVis.mutate({ id: item.id, deliverable_url: url.trim() || null });
          }}
          aria-label={`portal-item-url-${item.id}`}
        />
        {setVis.isError ? <div className="text-xs text-red-600">{setVis.error.message}</div> : null}
      </div>
      <label className="flex items-center gap-1 self-start text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={item.client_visible}
          onChange={(e) => setVis.mutate({ id: item.id, client_visible: e.target.checked })}
          aria-label={`portal-item-visible-${item.id}`}
        />
        Visible
      </label>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

function PreviewCard({ client, month }: { client: string; month: string }): JSX.Element {
  const preview = usePortalPreview(client, month);
  return (
    <section className={cn(CARD, 'self-start')} aria-label="portal-preview">
      <h2 className="mb-3 font-semibold">Preview</h2>
      {preview.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : preview.isError ? (
        <div className="text-sm text-red-600">{preview.error.message}</div>
      ) : preview.data ? (
        <PortalPreview view={preview.data.view} />
      ) : null}
    </section>
  );
}

function LinkList({ items }: { items: PortalLinkItem[] }): JSX.Element {
  return (
    <ul className="space-y-2">
      {items.map((e, idx) => (
        <li key={idx}>
          <div className="font-medium">
            {e.url ? (
              <a className="text-primary underline" href={e.url} target="_blank" rel="noreferrer">
                {e.title}
              </a>
            ) : (
              e.title
            )}
          </div>
          {e.body ? <div className="whitespace-pre-line text-muted-foreground">{e.body}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function PortalPreview({ view }: { view: PortalView }): JSX.Element {
  const blocks: Array<{ title: string; body: JSX.Element }> = [];
  if (view.monthly_notes.length > 0) blocks.push({ title: 'Monthly notes', body: <LinkList items={view.monthly_notes} /> });
  const work = [...view.work.completed, ...view.work.in_progress];
  if (work.length > 0) {
    blocks.push({
      title: `Work in ${view.month_label}`,
      body: (
        <ul className="space-y-1">
          {work.map((w, idx) => (
            <li key={idx} className="flex justify-between gap-2">
              <span>{w.title}</span>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {PORTAL_WORK_STATUS_LABELS[w.status]}
                {w.completed_on ? ` ${w.completed_on}` : w.due_on ? ` · due ${w.due_on}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (view.deliverables.length > 0) blocks.push({ title: 'Findings and deliverables', body: <LinkList items={view.deliverables} /> });
  if (view.renewals.length > 0) {
    blocks.push({
      title: 'Upcoming renewals',
      body: (
        <ul className="space-y-1">
          {view.renewals.map((r, idx) => (
            <li key={idx} className="flex justify-between gap-2">
              <span>
                {r.label} <span className="text-xs text-muted-foreground">{r.item_type_label}</span>
              </span>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {RENEWAL_STATE_LABELS[r.state]} · due {r.due_on}
              </span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (view.next_steps.length > 0) blocks.push({ title: 'Next steps', body: <LinkList items={view.next_steps} /> });

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="text-lg font-semibold">{view.client}</div>
        <div className="text-xs text-muted-foreground">Client update for {view.month_label}</div>
      </div>
      {blocks.length === 0 ? (
        <div className="text-muted-foreground">Nothing has been published for this month yet.</div>
      ) : (
        blocks.map((b) => (
          <div key={b.title} className="rounded border border-border p-3">
            <div className="mb-1 font-semibold">{b.title}</div>
            {b.body}
          </div>
        ))
      )}
    </div>
  );
}
