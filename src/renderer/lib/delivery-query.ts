/**
 * React Query hooks for `/api/delivery/*` (T693/T694).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import type {
  DeliveryItemWithSla,
  DeliveryOwnerType,
  DeliveryStatus,
  DeliveryTemplateStep,
  DeliveryTemplateWithSteps,
  InstantiateTemplateInput,
  SlaState,
} from '@/shared/delivery';

import { api, type QueryParams } from './api';

export interface DeliveryQueueFilter {
  owner_type?: DeliveryOwnerType;
  owner_name?: string;
  sla_state?: SlaState[];
  client?: string;
  venture?: string;
  include_closed?: boolean;
}

export interface DeliveryQueueResponse {
  items: DeliveryItemWithSla[];
  summary: {
    total: number;
    by_sla: Record<SlaState, number>;
    by_owner: Record<DeliveryOwnerType, number>;
  };
}

export interface DeliveryFacets {
  owner_names: string[];
  clients: string[];
  ventures: string[];
}

export interface DeliveryItemPatch {
  title?: string;
  description?: string | null;
  owner_type?: DeliveryOwnerType;
  owner_name?: string | null;
  client?: string;
  venture?: string | null;
  status?: DeliveryStatus;
  deadline?: string | null;
  sla_hours?: number | null;
}

export interface CreateDeliveryItemBody extends DeliveryItemPatch {
  title: string;
  owner_type: DeliveryOwnerType;
  client: string;
}

const KEYS = {
  all: ['delivery'] as const,
  items: (f: DeliveryQueueFilter) => ['delivery', 'items', f] as const,
  facets: ['delivery', 'facets'] as const,
  templates: ['delivery', 'templates'] as const,
};

function toQuery(f: DeliveryQueueFilter): QueryParams {
  const q: QueryParams = {};
  if (f.owner_type) q.owner_type = f.owner_type;
  if (f.owner_name) q.owner_name = f.owner_name;
  if (f.sla_state && f.sla_state.length > 0) q.sla_state = f.sla_state.join(',');
  if (f.client) q.client = f.client;
  if (f.venture) q.venture = f.venture;
  if (f.include_closed) q.include_closed = '1';
  return q;
}

function invalidate(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: KEYS.all });
}

export function useDeliveryQueue(filter: DeliveryQueueFilter): UseQueryResult<DeliveryQueueResponse> {
  return useQuery({
    queryKey: KEYS.items(filter),
    queryFn: () => api.get<DeliveryQueueResponse>('/api/delivery/items', toQuery(filter)),
    // SLA states move with the clock; refetch every minute so the counts follow.
    refetchInterval: 60_000,
  });
}

export function useDeliveryFacets(): UseQueryResult<DeliveryFacets> {
  return useQuery({
    queryKey: KEYS.facets,
    queryFn: () => api.get<DeliveryFacets>('/api/delivery/facets'),
  });
}

export function useDeliveryTemplates(): UseQueryResult<{ templates: DeliveryTemplateWithSteps[] }> {
  return useQuery({
    queryKey: KEYS.templates,
    queryFn: () => api.get<{ templates: DeliveryTemplateWithSteps[] }>('/api/delivery/templates'),
  });
}

export function useCreateDeliveryItem(): UseMutationResult<
  { item: DeliveryItemWithSla },
  Error,
  CreateDeliveryItemBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<{ item: DeliveryItemWithSla }>('/api/delivery/items', body),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDeliveryItem(): UseMutationResult<
  { item: DeliveryItemWithSla },
  Error,
  { id: string; patch: DeliveryItemPatch }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<{ item: DeliveryItemWithSla }>(`/api/delivery/items/${encodeURIComponent(id)}`, patch),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteDeliveryItem(): UseMutationResult<{ ok: true }, Error, { id: string }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => api.delete<{ ok: true }>(`/api/delivery/items/${encodeURIComponent(id)}`),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDeliveryTemplate(): UseMutationResult<
  { template: DeliveryTemplateWithSteps },
  Error,
  { id: string; patch: { sop_url?: string | null; name?: string; description?: string | null } }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<{ template: DeliveryTemplateWithSteps }>(
        `/api/delivery/templates/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDeliveryTemplateStep(): UseMutationResult<
  { step: DeliveryTemplateStep },
  Error,
  {
    templateId: string;
    stepId: string;
    patch: { sla_hours?: number | null; sla_confirmed?: boolean; owner_role?: DeliveryOwnerType };
  }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, stepId, patch }) =>
      api.patch<{ step: DeliveryTemplateStep }>(
        `/api/delivery/templates/${encodeURIComponent(templateId)}/steps/${encodeURIComponent(stepId)}`,
        patch,
      ),
    onSuccess: () => invalidate(qc),
  });
}

export function useInstantiateDeliveryTemplate(): UseMutationResult<
  { instance_id: string; items: DeliveryItemWithSla[] },
  Error,
  { id: string; input: InstantiateTemplateInput }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }) =>
      api.post<{ instance_id: string; items: DeliveryItemWithSla[] }>(
        `/api/delivery/templates/${encodeURIComponent(id)}/instantiate`,
        input,
      ),
    onSuccess: () => invalidate(qc),
  });
}
