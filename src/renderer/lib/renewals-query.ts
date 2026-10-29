/**
 * React Query hooks for `/api/renewals/*` (T704) and `/api/portal/*` (T707).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import type { DeliveryItemWithSla, DeliveryOwnerType } from '@/shared/delivery';
import type { PortalEntry, PortalEntryKind, PortalLinkWithUrl, PortalView } from '@/shared/portal';
import type {
  RenewalItemType,
  RenewalReminderWithRenewal,
  RenewalState,
  RenewalWithSchedule,
} from '@/shared/renewals';

import { api, type QueryParams } from './api';

/* -------------------------------------------------------------------------- */
/*  Renewals                                                                  */
/* -------------------------------------------------------------------------- */

export interface RenewalsFilter {
  client?: string;
  state?: RenewalState;
  include_inactive?: boolean;
}

export interface RenewalsMeta {
  item_types: Array<{ value: RenewalItemType; label: string; recurrence: string; lead_times: number[] }>;
  clients: string[];
}

export interface RenewalBody {
  client?: string;
  item_type?: RenewalItemType;
  label?: string;
  due_date?: string;
  recurrence?: string;
  lead_times?: number[] | string;
  owner_type?: DeliveryOwnerType;
  owner_name?: string | null;
  venture?: string | null;
  notes?: string | null;
  client_visible?: boolean;
  active?: boolean;
}

export interface ImportResult {
  dry_run: boolean;
  imported: number;
  duplicates: number;
  errors: number;
  rows: Array<{ line: number; status: 'ok' | 'duplicate' | 'error'; error?: string; client?: string; label?: string }>;
}

export interface EngineRunResult {
  checked: number;
  rolled: unknown[];
  reminders: unknown[];
  created_items: unknown[];
}

const RKEYS = {
  all: ['renewals'] as const,
  list: (f: RenewalsFilter) => ['renewals', 'list', f] as const,
  meta: ['renewals', 'meta'] as const,
  reminders: ['renewals', 'reminders'] as const,
};

function invalidateRenewals(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: RKEYS.all });
  // Engine runs and "mark renewed" touch the Delivery queue too.
  qc.invalidateQueries({ queryKey: ['delivery'] });
  qc.invalidateQueries({ queryKey: ['portal'] });
}

export function useRenewals(filter: RenewalsFilter): UseQueryResult<{ renewals: RenewalWithSchedule[] }> {
  const q: QueryParams = {};
  if (filter.client) q.client = filter.client;
  if (filter.state) q.state = filter.state;
  if (filter.include_inactive) q.include_inactive = '1';
  return useQuery({
    queryKey: RKEYS.list(filter),
    queryFn: () => api.get<{ renewals: RenewalWithSchedule[] }>('/api/renewals', q),
  });
}

export function useRenewalsMeta(): UseQueryResult<RenewalsMeta> {
  return useQuery({ queryKey: RKEYS.meta, queryFn: () => api.get<RenewalsMeta>('/api/renewals/meta') });
}

export function useRenewalReminders(): UseQueryResult<{ reminders: RenewalReminderWithRenewal[] }> {
  return useQuery({
    queryKey: RKEYS.reminders,
    queryFn: () => api.get<{ reminders: RenewalReminderWithRenewal[] }>('/api/renewals/reminders'),
    refetchInterval: 5 * 60_000,
  });
}

export function useCreateRenewal(): UseMutationResult<{ renewal: RenewalWithSchedule }, Error, RenewalBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<{ renewal: RenewalWithSchedule }>('/api/renewals', body),
    onSuccess: () => invalidateRenewals(qc),
  });
}

export function useUpdateRenewal(): UseMutationResult<
  { renewal: RenewalWithSchedule },
  Error,
  { id: string; patch: RenewalBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<{ renewal: RenewalWithSchedule }>(`/api/renewals/${encodeURIComponent(id)}`, patch),
    onSuccess: () => invalidateRenewals(qc),
  });
}

export function useDeleteRenewal(): UseMutationResult<{ ok: true }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => api.delete<{ ok: true }>(`/api/renewals/${encodeURIComponent(id)}`),
    onSuccess: () => invalidateRenewals(qc),
  });
}

export function useMarkRenewed(): UseMutationResult<{ renewal: RenewalWithSchedule }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<{ renewal: RenewalWithSchedule }>(`/api/renewals/${encodeURIComponent(id)}/renew`),
    onSuccess: () => invalidateRenewals(qc),
  });
}

export function useImportRenewals(): UseMutationResult<
  ImportResult,
  Error,
  { csv: string; dry_run?: boolean; skip_invalid?: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<ImportResult>('/api/renewals/import', body),
    onSuccess: (res) => {
      if (!res.dry_run) invalidateRenewals(qc);
    },
  });
}

export function useRunRenewalEngine(): UseMutationResult<EngineRunResult, Error, void> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<EngineRunResult>('/api/renewals/run'),
    onSuccess: () => invalidateRenewals(qc),
  });
}

export function useAckReminder(): UseMutationResult<{ ok: true }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => api.post<{ ok: true }>(`/api/renewals/reminders/${encodeURIComponent(id)}/ack`),
    onSuccess: () => qc.invalidateQueries({ queryKey: RKEYS.reminders }),
  });
}

/* -------------------------------------------------------------------------- */
/*  Portal                                                                    */
/* -------------------------------------------------------------------------- */

export interface PortalEntryBody {
  client?: string;
  kind?: PortalEntryKind;
  title?: string;
  body?: string | null;
  url?: string | null;
  month?: string | null;
  client_visible?: boolean;
  done?: boolean;
}

const PKEYS = {
  all: ['portal'] as const,
  clients: ['portal', 'clients'] as const,
  preview: (client: string, month: string) => ['portal', 'preview', client, month] as const,
  links: (client: string) => ['portal', 'links', client] as const,
  entries: (client: string, month: string) => ['portal', 'entries', client, month] as const,
  items: (client: string) => ['delivery', 'items', { client, include_closed: true, portal: true }] as const,
};

function invalidatePortal(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: PKEYS.all });
}

export function usePortalClients(): UseQueryResult<{ clients: string[] }> {
  return useQuery({ queryKey: PKEYS.clients, queryFn: () => api.get<{ clients: string[] }>('/api/portal/clients') });
}

export function usePortalPreview(client: string, month: string): UseQueryResult<{ view: PortalView }> {
  return useQuery({
    queryKey: PKEYS.preview(client, month),
    queryFn: () => api.get<{ view: PortalView }>('/api/portal/preview', { client, month }),
    enabled: client.length > 0,
  });
}

export function usePortalLinks(client: string): UseQueryResult<{ links: PortalLinkWithUrl[] }> {
  return useQuery({
    queryKey: PKEYS.links(client),
    queryFn: () => api.get<{ links: PortalLinkWithUrl[] }>('/api/portal/links', { client }),
    enabled: client.length > 0,
  });
}

export function usePortalEntries(client: string, month: string): UseQueryResult<{ entries: PortalEntry[] }> {
  return useQuery({
    queryKey: PKEYS.entries(client, month),
    queryFn: () => api.get<{ entries: PortalEntry[] }>('/api/portal/entries', { client, month }),
    enabled: client.length > 0,
  });
}

/** Every queue item for a client, open and closed, for the publish toggles. */
export function useClientDeliveryItems(client: string): UseQueryResult<{ items: DeliveryItemWithSla[] }> {
  return useQuery({
    queryKey: PKEYS.items(client),
    queryFn: () =>
      api.get<{ items: DeliveryItemWithSla[] }>('/api/delivery/items', { client, include_closed: '1' }),
    enabled: client.length > 0,
  });
}

export function useCreatePortalLink(): UseMutationResult<
  { link: PortalLinkWithUrl },
  Error,
  { client: string; expires_in_days: number; label?: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<{ link: PortalLinkWithUrl }>('/api/portal/links', body),
    onSuccess: () => invalidatePortal(qc),
  });
}

export function useRevokePortalLink(): UseMutationResult<{ link: PortalLinkWithUrl }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<{ link: PortalLinkWithUrl }>(`/api/portal/links/${encodeURIComponent(id)}/revoke`),
    onSuccess: () => invalidatePortal(qc),
  });
}

export function useCreatePortalEntry(): UseMutationResult<{ entry: PortalEntry }, Error, PortalEntryBody> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<{ entry: PortalEntry }>('/api/portal/entries', body),
    onSuccess: () => invalidatePortal(qc),
  });
}

export function useUpdatePortalEntry(): UseMutationResult<
  { entry: PortalEntry },
  Error,
  { id: string; patch: PortalEntryBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<{ entry: PortalEntry }>(`/api/portal/entries/${encodeURIComponent(id)}`, patch),
    onSuccess: () => invalidatePortal(qc),
  });
}

export function useDeletePortalEntry(): UseMutationResult<{ ok: true }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => api.delete<{ ok: true }>(`/api/portal/entries/${encodeURIComponent(id)}`),
    onSuccess: () => invalidatePortal(qc),
  });
}

export function useSetItemVisibility(): UseMutationResult<
  unknown,
  Error,
  { id: string; client_visible?: boolean; deliverable_url?: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }) => api.patch(`/api/delivery/items/${encodeURIComponent(id)}`, patch),
    onSuccess: () => {
      invalidatePortal(qc);
      qc.invalidateQueries({ queryKey: ['delivery'] });
    },
  });
}
