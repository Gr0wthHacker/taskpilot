/**
 * React Query setup for the renderer.
 *
 * Exports:
 *  - `queryClient` — singleton with conservative defaults.
 *  - `queryKeys` — typed factory for all server-state caches.
 *  - Typed hook wrappers around the HTTP API (tasks list, detail, mutations).
 *  - `useApiEventStream` — subscribes to SSE on `/api/events` (if exposed by
 *    the server) and invalidates relevant queries on push events.
 */

import {
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import {
  applyWorkspaceFilter,
  useWorkspaceStore,
} from '@/renderer/store/workspace';

import type {
  AddTaskBlockResponse,
  ApplyPermissionProfileResponse,
  ApproveTaskBody,
  ApproveTaskResponse,
  ArchiveTaskResponse,
  DeleteAttachmentResponse,
  ListAttachmentsResponse,
  AutoLaunchGetResponse,
  AutoLaunchSetBody,
  BackupsStatusResponse,
  CreateBackupResponse,
  DeleteBackupResponse,
  ListBackupsResponse,
  RestoreBackupResponse,
  TelemetryFlushResponse,
  TelemetryStatusResponse,
  RecordTelemetryEventBody,
  AutoLaunchSetResponse,
  AvailabilityQuery,
  AvailabilityResponse,
  ClearTaskPermissionsResponse,
  CommitGitHubFilesBody,
  CommitGitHubFilesResponse,
  ConfigResponse,
  CreateGitHubBranchBody,
  CreateGitHubBranchResponse,
  CreateGitHubIssueBody,
  CreateGitHubIssueResponse,
  CreateTaskBody,
  CreateTaskResponse,
  CreateTemplateBody,
  CreateTemplateResponse,
  DailyPlanResponse,
  DataExportResponse,
  DataImportBody,
  DataImportResponse,
  DeleteTaskResponse,
  DeleteTemplateResponse,
  DeriveTaskResponse,
  ExecuteTaskResponse,
  GetTaskPermissionsResponse,
  GetTaskResponse,
  GetTemplateResponse,
  GitHubConnectBody,
  GitHubConnectResponse,
  GitHubStatusResponse,
  HealthResponse,
  IoPendingResponse,
  IoResultsResponse,
  IoStatusResponse,
  ListCalendarEventsQuery,
  ListCalendarEventsResponse,
  ListGitHubIssuesQuery,
  ListGitHubIssuesResponse,
  ListGitHubReposResponse,
  ListPermissionProfilesResponse,
  ListSkillsResponse,
  ListNotionDatabasesResponse,
  ListSlackChannelsResponse,
  NotionConnectBody,
  NotionConnectResponse,
  NotionStatusResponse,
  NotionSyncNowResponse,
  PostSlackMessageBody,
  PostSlackMessageResponse,
  SelectNotionDatabaseBody,
  SelectNotionDatabaseResponse,
  SlackCaptureNowResponse,
  SlackConnectBody,
  SlackConnectResponse,
  SlackStatusResponse,
  GmailCaptureNowResponse,
  GmailConnectStartBody,
  GmailConnectStartResponse,
  GmailConnectCompleteBody,
  GmailConnectCompleteResponse,
  GmailDraftBody,
  GmailDraftResponse,
  GmailLabelBody,
  GmailSendBody,
  GmailSendResponse,
  GmailStatusResponse,
  ListSubredditPostsQuery,
  ListSubredditPostsResponse,
  GetSubredditPostQuery,
  GetSubredditPostResponse,
  SearchSubredditQuery,
  SearchSubredditResponse,
  AttachTaskLovableBody,
  AttachTaskLovableResponse,
  DetachTaskLovableResponse,
  GetTaskLovableResponse,
  ListTasksQuery,
  ListTasksResponse,
  ListTemplatesResponse,
  MaterializeTemplateBody,
  MaterializeTemplateResponse,
  OkResponse,
  OpenGitHubPullBody,
  OpenGitHubPullResponse,
  RejectTaskBody,
  RejectTaskResponse,
  ScheduleTaskBody,
  ScheduleTaskResponse,
  UnarchiveTaskResponse,
  UpdateTaskBody,
  UpdateTaskPermissionsResponse,
  UpdateTaskResponse,
  UpdateTemplateBody,
  UpdateTemplateResponse,
  GetTaskLinksResponse,
  RegisterSkillBody,
  RegisterSkillResponse,
  RemoveTaskBlockResponse,
  SuggestSkillsForTaskResponse,
  UpdateTaskLinksBody,
  UpdateTaskLinksResponse,
  RecentFailuresResponse,
  ReportsAllResponse,
  ReportWindow,
  ReviewTrendResponse,
  SuccessRateResponse,
  TagHeatMapResponse,
  ThroughputResponse,
  TimeToDoneResponse,
  CostSummaryResponse,
  ListCostEventsResponse,
  RecordCostEventBody,
  RecordCostEventResponse,
  ListFeedbackResponse,
  RecordFeedbackBody,
  RecordFeedbackResponse,
  JournalResponse,
  ListDecisionsResponse,
  CreateDecisionBody,
  CreateDecisionResponse,
  DeleteDecisionResponse,
  SearchEntityType,
  SearchResponse,
  ListGoalsQuery,
  ListGoalsResponse,
  CreateGoalBody,
  CreateGoalResponse,
  GetGoalResponse,
  UpdateGoalBody,
  UpdateGoalResponse,
  DeleteGoalResponse,
  AttachTaskGoalBody,
  AttachTaskGoalResponse,
  ListBusinessesResponse,
  GetBusinessResponse,
  PostBusinessUpdateBody,
  PostBusinessUpdateResponse,
  ListContentResponse,
  GetContentResponse,
  CreateContentBody,
  CreateContentResponse,
  UpdateContentBody,
  UpdateContentResponse,
  AdvanceContentBody,
  AdvanceContentResponse,
  SetDerivativeBody,
  SetDerivativeResponse,
  DeleteContentResponse,
  StatusReportWindow,
  StatusReportDestination,
  GenerateStatusReportBody,
  GenerateStatusReportResponse,
  StatusReportPreviewResponse,
  StatusReportHistoryResponse,
  StatusReportScheduleResponse,
  UpdateStatusReportScheduleBody,
  ContextMonitorStatusResponse,
  ListContextObservationsQuery,
  ListContextObservationsResponse,
  ListDeliberationsQuery,
  ListDeliberationsResponse,
  GetDeliberationResponse,
  DeleteContextObservationResponse,
  RequestDeliberationBody,
  RequestDeliberationResponse,
} from '@/shared/api-contract';
import type {
  AgentMethod,
  PermissionProfileName,
  PermissionSet,
  Task,
} from '@/shared/types';

import { api, apiUrl, resolveApiToken, type QueryParams } from './api';

/* -------------------------------------------------------------------------- */
/*  QueryClient singleton                                                     */
/* -------------------------------------------------------------------------- */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // No refetch on window focus — server-sent events keep caches fresh
      // when relevant, and most renderer surfaces don't need second-by-second
      // freshness. Cuts ~80% of the post-tab-switch query storm at 30k+ rows.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // 30s staleTime is the sweet spot for badge counts and list views.
      // SSE invalidations override this for the surfaces that genuinely
      // need fresher data; everything else (sidebar counts, recent task
      // lists) is fine with a 30s cache.
      staleTime: 30_000,
      // Keep unused query data in cache for 5 minutes so paginated lists
      // (cursor-based) don't refetch the prior page when navigating back.
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
});

/* -------------------------------------------------------------------------- */
/*  Query key factory                                                         */
/* -------------------------------------------------------------------------- */

export const queryKeys = {
  health: ['health'] as const,
  config: ['config'] as const,
  tasks: {
    all: ['tasks'] as const,
    list: (filter?: ListTasksQuery) =>
      ['tasks', 'list', filter ?? {}] as const,
    infinite: (filter: ListTasksQuery) =>
      ['tasks', 'infinite', filter] as const,
    stats: () => ['tasks', 'stats'] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    children: (parentId: string) => ['tasks', 'children', parentId] as const,
  },
  memory: {
    all: ['memory'] as const,
    infinite: (filter: Record<string, unknown>) =>
      ['memory', 'infinite', filter] as const,
    stats: () => ['memory', 'stats'] as const,
    detail: (id: string) => ['memory', 'detail', id] as const,
  },
  calendar: {
    all: ['calendar'] as const,
    events: (range?: ListCalendarEventsQuery) =>
      ['calendar', 'events', range ?? {}] as const,
    availability: (q: AvailabilityQuery) =>
      ['calendar', 'availability', q] as const,
  },
  io: {
    all: ['io'] as const,
    pending: ['io', 'pending'] as const,
    results: ['io', 'results'] as const,
    status: ['io', 'status'] as const,
  },
  review: {
    all: ['review'] as const,
    queue: (reason?: ReviewReason | 'all') =>
      ['review', 'queue', reason ?? 'all'] as const,
  },
  templates: {
    all: ['templates'] as const,
    list: ['templates', 'list'] as const,
    detail: (id: string) => ['templates', 'detail', id] as const,
  },
  plan: {
    all: ['plan'] as const,
    today: (date?: string) => ['plan', 'today', date ?? ''] as const,
  },
  permissions: {
    all: ['permissions'] as const,
    task: (id: string) => ['permissions', 'task', id] as const,
    profiles: ['permissions', 'profiles'] as const,
  },
  links: {
    all: ['links'] as const,
    task: (id: string) => ['links', 'task', id] as const,
  },
  skills: {
    all: ['skills'] as const,
    list: ['skills', 'list'] as const,
    suggest: (taskId: string) => ['skills', 'suggest', taskId] as const,
  },
  attachments: {
    all: ['attachments'] as const,
    task: (id: string) => ['attachments', 'task', id] as const,
  },
  search: {
    all: ['search'] as const,
    query: (q: string, types: string, limit: number) =>
      ['search', 'query', q, types, limit] as const,
  },
  goals: {
    all: ['goals'] as const,
    list: (filter?: ListGoalsQuery) => ['goals', 'list', filter ?? {}] as const,
    detail: (id: string) => ['goals', 'detail', id] as const,
    tasks: (id: string) => ['goals', 'tasks', id] as const,
  },
  businesses: {
    all: ['businesses'] as const,
    list: () => ['businesses', 'list'] as const,
    detail: (tag: string) => ['businesses', 'detail', tag] as const,
  },
  content: {
    all: ['content'] as const,
    list: () => ['content', 'list'] as const,
    detail: (id: string) => ['content', 'detail', id] as const,
  },
  context: {
    all: ['context'] as const,
    status: () => ['context', 'status'] as const,
    observations: (q?: ListContextObservationsQuery) =>
      ['context', 'observations', q ?? {}] as const,
    deliberations: (q?: ListDeliberationsQuery) =>
      ['context', 'deliberations', q ?? {}] as const,
    deliberation: (id: string) => ['context', 'deliberation', id] as const,
  },
} as const;

/* -------------------------------------------------------------------------- */
/*  Review queue                                                              */
/* -------------------------------------------------------------------------- */

export type ReviewReason = 'derivation' | 'result' | 'failed';

export interface ReviewItem {
  task: Task;
  reason: ReviewReason;
  parent: { id: string; title: string } | null;
  source_preview: string;
  added_at: string;
  confidence: number | null;
  confidence_threshold: number;
  low_confidence: boolean;
  flag_label: string | null;
  derivatives: Array<{ title: string; agent_method: AgentMethod }> | null;
}

export interface ReviewQueueResponse {
  items: ReviewItem[];
}

export function useReviewQueue(
  reason?: ReviewReason | 'all',
): UseQueryResult<ReviewQueueResponse> {
  const result = useQuery({
    queryKey: queryKeys.review.queue(reason),
    queryFn: () => {
      const params: QueryParams | undefined =
        reason && reason !== 'all' ? { reason } : undefined;
      return api.get<ReviewQueueResponse>('/api/review/queue', params);
    },
  });

  // Mirror the workspace filter used by useTasksList. Review items wrap a
  // Task, so we re-use applyWorkspaceFilter on the nested task field.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const filtered = useMemo<ReviewQueueResponse | undefined>(() => {
    if (!result.data) return result.data;
    if (activeWorkspaceId === null) return result.data;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
    if (!ws) return result.data;
    const allowedTasks = new Set(
      applyWorkspaceFilter(
        result.data.items.map((i) => i.task),
        ws,
      ).map((t) => t.id),
    );
    return {
      ...result.data,
      items: result.data.items.filter((i) => allowedTasks.has(i.task.id)),
    };
  }, [result.data, workspaces, activeWorkspaceId]);

  return { ...result, data: filtered } as UseQueryResult<ReviewQueueResponse>;
}

export function useApproveReview(): UseMutationResult<
  ApproveTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<ApproveTaskResponse>(
        `/api/review/${encodeURIComponent(id)}/approve`,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.review.all });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function useRejectReview(): UseMutationResult<
  RejectTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<RejectTaskResponse>(
        `/api/review/${encodeURIComponent(id)}/reject`,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.review.all });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Health / config                                                           */
/* -------------------------------------------------------------------------- */

export function useHealth(): UseQueryResult<HealthResponse> {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => api.get<HealthResponse>('/api/health'),
  });
}

export function useConfig(): UseQueryResult<ConfigResponse> {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => api.get<ConfigResponse>('/api/config'),
    staleTime: Infinity,
  });
}

/* -------------------------------------------------------------------------- */
/*  Default task inputs (read from settings)                                  */
/* -------------------------------------------------------------------------- */

export interface DefaultTaskInputs {
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  agent_method: 'cowork' | 'cli' | 'either' | 'human_only';
}

interface SettingValueResponse {
  value: string | null;
}

const DEFAULT_TASK_INPUTS: DefaultTaskInputs = {
  priority: 'p2',
  agent_method: 'human_only',
};

function parseTaskPriority(
  raw: string | null,
): DefaultTaskInputs['priority'] {
  if (raw === 'p0' || raw === 'p1' || raw === 'p2' || raw === 'p3') return raw;
  return DEFAULT_TASK_INPUTS.priority;
}

function parseAgentMethod(
  raw: string | null,
): DefaultTaskInputs['agent_method'] {
  if (
    raw === 'cowork' ||
    raw === 'cli' ||
    raw === 'either' ||
    raw === 'human_only'
  ) {
    return raw;
  }
  return DEFAULT_TASK_INPUTS.agent_method;
}

/**
 * Pull the persisted "default_priority" and "default_agent_method" settings
 * so callers (e.g. NewTaskDialog) can seed their form state with whatever
 * the user configured in Settings → General. Falls back to the hardcoded
 * defaults whenever a setting is missing or the server can't be reached.
 */
export function useDefaultTaskInputs(): {
  defaults: DefaultTaskInputs;
  isLoading: boolean;
} {
  const settingFetch = async (key: string): Promise<SettingValueResponse> => {
    try {
      return await api.get<SettingValueResponse>(
        `/api/settings/${encodeURIComponent(key)}`,
      );
    } catch {
      // Server unavailable / 404 — fall back to defaults via `value: null`.
      return { value: null };
    }
  };

  const priorityQ = useQuery({
    queryKey: ['settings', 'default_priority'],
    queryFn: () => settingFetch('default_priority'),
    staleTime: 60_000,
    retry: false,
  });
  const methodQ = useQuery({
    queryKey: ['settings', 'default_agent_method'],
    queryFn: () => settingFetch('default_agent_method'),
    staleTime: 60_000,
    retry: false,
  });

  return {
    defaults: {
      priority: parseTaskPriority(priorityQ.data?.value ?? null),
      agent_method: parseAgentMethod(methodQ.data?.value ?? null),
    },
    isLoading: priorityQ.isLoading || methodQ.isLoading,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tasks                                                                     */
/* -------------------------------------------------------------------------- */

function toQueryParams(
  filter: ListTasksQuery | undefined,
): QueryParams | undefined {
  if (!filter) return undefined;
  const out: QueryParams = {};
  if (filter.status !== undefined) out.status = filter.status;
  if (filter.priority !== undefined) out.priority = filter.priority;
  if (filter.parent !== undefined) out.parent = filter.parent;
  if (filter.agent_only !== undefined) out.agent_only = filter.agent_only;
  if (filter.include_archived !== undefined) {
    out.include_archived = filter.include_archived;
  }
  return out;
}

/**
 * Fetch the task list and (implicitly) narrow it to the active workspace.
 *
 * The HTTP API doesn't know about workspaces — they're a renderer-only
 * concept layered on top of tag matching. We keep the API query stable
 * (workspaces don't appear in the cache key) and instead post-filter the
 * returned task array based on the active workspace pulled from the Zustand
 * store. Switching workspaces never refetches; it just re-renders.
 *
 * Pass `ignoreWorkspace: true` to opt out of the filter — useful when the
 * caller is rendering UI that should ignore the active workspace (e.g. the
 * Projects view aggregating tags across all businesses).
 */
export function useTasksList(
  filter?: ListTasksQuery,
  options: { ignoreWorkspace?: boolean } = {},
): UseQueryResult<ListTasksResponse> {
  const result = useQuery({
    queryKey: queryKeys.tasks.list(filter),
    // The server caps each response at DEFAULT_PAGE_LIMIT (100) and returns a
    // `next_cursor`. This hook is used by ~22 non-paginated list surfaces
    // (board, triage, calendar, projects…), so we follow the cursor here and
    // return the full filtered set as a single response — keeping the
    // `ListTasksResponse` shape every consumer already expects. The guard
    // bounds worst-case fan-out; real working sets are a few pages at most.
    queryFn: async () => {
      const first = await api.get<ListTasksResponse>(
        '/api/tasks',
        toQueryParams(filter),
      );
      if (!first.next_cursor) return first;
      const tasks = [...first.tasks];
      let cursor: string | null = first.next_cursor;
      for (let page = 0; cursor && page < 50; page += 1) {
        const next: ListTasksResponse = await api.get<ListTasksResponse>(
          '/api/tasks',
          toQueryParams({ ...filter, cursor }),
        );
        tasks.push(...next.tasks);
        cursor = next.next_cursor;
      }
      return { ...first, tasks, next_cursor: null };
    },
  });

  // Subscribe to the workspace store so changes re-render the consumer.
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const filtered = useMemo<ListTasksResponse | undefined>(() => {
    if (options.ignoreWorkspace) return result.data;
    if (!result.data) return result.data;
    if (activeWorkspaceId === null) return result.data;
    const ws = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
    if (!ws) return result.data;
    const tasks = applyWorkspaceFilter(result.data.tasks, ws);
    return { ...result.data, tasks };
  }, [result.data, workspaces, activeWorkspaceId, options.ignoreWorkspace]);

  // Return the same shape react-query gives back, with `data` swapped for
  // the workspace-narrowed projection. We splice rather than re-fetch so
  // status/isLoading/error flags stay accurate.
  return { ...result, data: filtered } as UseQueryResult<ListTasksResponse>;
}

/**
 * Cursor-paginated task list. Use for any high-volume surface (inbox, board,
 * search, triage) — never fetches more than `limit` rows at a time, and
 * `fetchNextPage()` chains via the opaque `next_cursor` the server returns.
 *
 * Defaults to `fields: 'summary'` because list surfaces almost never need
 * the heavy `description` / `agent_instructions` columns; pass `'full'` to
 * opt back in.
 */
export interface UseTasksInfiniteOptions extends Omit<ListTasksQuery, 'cursor'> {
  /**
   * Optional staleness override for individual list surfaces.
   * Defaults to the global queryClient setting (30s).
   */
  staleTime?: number;
}

export function useTasksInfinite(
  filter: UseTasksInfiniteOptions = {},
): UseInfiniteQueryResult<
  { pages: ListTasksResponse[]; pageParams: (string | undefined)[] },
  Error
> {
  const { staleTime, ...listFilter } = filter;
  const finalFilter: ListTasksQuery = {
    fields: 'summary',
    limit: 100,
    ...listFilter,
  };

  return useInfiniteQuery({
    // Cursor lives in the queryKey so different filter combos don't collide.
    queryKey: queryKeys.tasks.infinite(finalFilter),
    queryFn: ({ pageParam }: { pageParam?: string }) =>
      api.get<ListTasksResponse>(
        '/api/tasks',
        toQueryParams({
          ...finalFilter,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime,
  });
}

/**
 * Materialized counts row served by `GET /api/tasks/stats`. Mirrors the
 * `TaskStats` shape in `@/main/task-stats` — duplicated here to avoid a
 * renderer→main type import.
 */
export interface TaskStatsShape {
  total: number;
  inbox: number;
  queued: number;
  in_progress: number;
  blocked: number;
  review_pending: number;
  done: number;
  cancelled: number;
  archived: number;
  agent_executable_open: number;
  updated_at: string;
}

/**
 * Read the materialized task counts (sidebar badges, command-palette hints).
 * O(1) on the server side — a singleton row read. Stays fresh via a 15s
 * staleTime + SSE invalidation on the `tasks` key family (any task_created /
 * task_updated / task_deleted event invalidates this prefix automatically).
 */
export function useTaskStats(): UseQueryResult<{ stats: TaskStatsShape }> {
  return useQuery({
    queryKey: queryKeys.tasks.stats(),
    queryFn: () =>
      api.get<{ stats: TaskStatsShape }>('/api/tasks/stats'),
    // Counts feed badges — a 15s cache is plenty.
    staleTime: 15_000,
  });
}

/* -------------------------------------------------------------------------- */
/*  Memory subsystem (v9)                                                     */
/* -------------------------------------------------------------------------- */

export interface MemoryListFilter {
  status?: 'raw' | 'enriched' | 'failed';
  kind?: 'text' | 'url' | 'file';
  tag?: string;
  search?: string;
  fields?: 'full' | 'summary';
  limit?: number;
}

export interface MemoryItemShape {
  id: string;
  kind: 'text' | 'url' | 'file';
  title: string | null;
  raw_content?: string;
  summary: string | null;
  tags: string[];
  entities?: Record<string, unknown> | null;
  source_url: string | null;
  source_path?: string | null;
  content_hash?: string;
  status: 'raw' | 'enriched' | 'failed';
  enrichment_error?: string | null;
  created_at: string;
  updated_at: string;
  enriched_at: string | null;
}

export interface MemoryLinkShape {
  id: string;
  source_id: string;
  target_kind: 'memory' | 'task' | 'goal';
  target_id: string;
  link_kind: 'related' | 'refers_to' | 'duplicate_of';
  score: number;
  created_at: string;
}

export interface MemoryStatsShape {
  total: number;
  raw: number;
  enriched: number;
  failed: number;
  kind_text: number;
  kind_url: number;
  kind_file: number;
  updated_at: string;
}

export interface MemoryListResponse {
  items: MemoryItemShape[];
  next_cursor: string | null;
}

export function useMemoryInfinite(
  filter: MemoryListFilter = {},
): UseInfiniteQueryResult<
  { pages: MemoryListResponse[]; pageParams: (string | undefined)[] },
  Error
> {
  // Summary mode by default keeps list payloads small; detail view fetches full.
  const finalFilter: Record<string, unknown> = {
    fields: 'summary',
    limit: 50,
    ...filter,
  };
  return useInfiniteQuery({
    queryKey: queryKeys.memory.infinite(finalFilter),
    queryFn: ({ pageParam }: { pageParam?: string }) =>
      api.get<MemoryListResponse>(
        '/api/memory',
        toQueryParams({
          ...finalFilter,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

export function useMemoryStats(): UseQueryResult<{ stats: MemoryStatsShape }> {
  return useQuery({
    queryKey: queryKeys.memory.stats(),
    queryFn: () => api.get<{ stats: MemoryStatsShape }>('/api/memory/stats'),
    staleTime: 15_000,
  });
}

export function useMemoryDetail(
  id: string | null | undefined,
): UseQueryResult<{ item: MemoryItemShape; links: MemoryLinkShape[] }> {
  return useQuery({
    queryKey: queryKeys.memory.detail(id ?? ''),
    queryFn: () =>
      api.get<{ item: MemoryItemShape; links: MemoryLinkShape[] }>(
        `/api/memory/${encodeURIComponent(id ?? '')}`,
      ),
    enabled: Boolean(id),
  });
}

export interface CaptureMemoryBody {
  kind: 'text' | 'url' | 'file';
  content?: string;
  url?: string;
  title?: string;
  tags?: string[];
  enrich?: boolean;
}

export function useCaptureMemory(): UseMutationResult<
  { item: MemoryItemShape },
  Error,
  CaptureMemoryBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<{ item: MemoryItemShape }>('/api/memory', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.all });
    },
  });
}

export function useUpdateMemory(): UseMutationResult<
  { item: MemoryItemShape },
  Error,
  { id: string; patch: { title?: string | null; summary?: string | null; tags?: string[] } }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<{ item: MemoryItemShape }>(
        `/api/memory/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.all });
      qc.invalidateQueries({
        queryKey: queryKeys.memory.detail(res.item.id),
      });
    },
  });
}

export function useDeleteMemory(): UseMutationResult<
  { ok: boolean; id: string },
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) =>
      api.delete<{ ok: boolean; id: string }>(`/api/memory/${encodeURIComponent(id)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.all });
    },
  });
}

export function useRetryMemoryEnrichment(): UseMutationResult<
  { ok: boolean; request_path: string },
  Error,
  string
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) =>
      api.post<{ ok: boolean; request_path: string }>(
        `/api/memory/${encodeURIComponent(id)}/enrich`,
        {},
      ),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: queryKeys.memory.detail(id) });
    },
  });
}

export function useTaskChildren(
  parentId: string | null | undefined,
): UseQueryResult<ListTasksResponse> {
  return useQuery({
    queryKey: queryKeys.tasks.children(parentId ?? ''),
    queryFn: () =>
      api.get<ListTasksResponse>('/api/tasks', { parent: parentId ?? '' }),
    enabled: Boolean(parentId),
  });
}

export function useTask(
  id: string | null | undefined,
): UseQueryResult<GetTaskResponse> {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id ?? ''),
    queryFn: () => api.get<GetTaskResponse>(`/api/tasks/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
}

function invalidateTaskCaches(
  qc: QueryClient,
  task?: Pick<Task, 'id' | 'parent_id'> | null,
): void {
  qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
  if (task) {
    qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(task.id) });
    if (task.parent_id) {
      qc.invalidateQueries({
        queryKey: queryKeys.tasks.children(task.parent_id),
      });
    }
  }
}

export function useCreateTask(): UseMutationResult<
  CreateTaskResponse,
  Error,
  CreateTaskBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTaskBody) =>
      api.post<CreateTaskResponse>('/api/tasks', body),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

export function useUpdateTask(): UseMutationResult<
  UpdateTaskResponse,
  Error,
  { id: string; patch: UpdateTaskBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdateTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

/**
 * Snooze/unsnooze a task. Stores (or clears) `snoozed_until` under
 * `task.context` — read-merge-write, since a context patch replaces the whole
 * object server-side. Pass `until: null` to wake the task immediately.
 */
export function useSnoozeTask(): UseMutationResult<
  UpdateTaskResponse,
  Error,
  { task: Task; until: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task, until }) => {
      const next = { ...(task.context ?? {}) } as Record<string, unknown>;
      if (until === null) delete next['snoozed_until'];
      else next['snoozed_until'] = until;
      return api.patch<UpdateTaskResponse>(
        `/api/tasks/${encodeURIComponent(task.id)}`,
        { context: next },
      );
    },
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

export function useDeleteTask(): UseMutationResult<
  DeleteTaskResponse,
  Error,
  { id: string; parent_id?: string | null }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteTaskResponse>(`/api/tasks/${encodeURIComponent(id)}`),
    onSuccess: (_res, vars) =>
      invalidateTaskCaches(qc, {
        id: vars.id,
        parent_id: vars.parent_id ?? null,
      }),
  });
}

export function useDeriveTask(): UseMutationResult<
  DeriveTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<DeriveTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/derive`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.io.all });
    },
  });
}

export function useExecuteTask(): UseMutationResult<
  ExecuteTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<ExecuteTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/execute`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.io.all });
    },
  });
}

export function useApproveTask(): UseMutationResult<
  ApproveTaskResponse,
  Error,
  { id: string; body: ApproveTaskBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<ApproveTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/approve`,
        body,
      ),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

export function useRejectTask(): UseMutationResult<
  RejectTaskResponse,
  Error,
  { id: string; body: RejectTaskBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<RejectTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/reject`,
        body,
      ),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

export function useArchiveTask(): UseMutationResult<
  ArchiveTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<ArchiveTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/archive`,
      ),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

export function useUnarchiveTask(): UseMutationResult<
  UnarchiveTaskResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<UnarchiveTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/unarchive`,
      ),
    onSuccess: (res) => invalidateTaskCaches(qc, res.task),
  });
}

/**
 * Reserve a calendar slot for the task. Server returns the created event id
 * + the rendered start/end times so the UI can show a "Scheduled at HH:MM"
 * toast. After success we invalidate the task detail (so the
 * `calendar_event_id` field refreshes) and the calendar events query so the
 * new event shows up in the next calendar view render.
 */
export function useScheduleTask(): UseMutationResult<
  ScheduleTaskResponse,
  Error,
  { id: string; body?: ScheduleTaskBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<ScheduleTaskResponse>(
        `/api/tasks/${encodeURIComponent(id)}/schedule`,
        body ?? {},
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.calendar.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Task templates                                                            */
/* -------------------------------------------------------------------------- */

export function useTemplates(): UseQueryResult<ListTemplatesResponse> {
  return useQuery({
    queryKey: queryKeys.templates.list,
    queryFn: () => api.get<ListTemplatesResponse>('/api/templates'),
  });
}

export function useTemplate(
  id: string | null | undefined,
): UseQueryResult<GetTemplateResponse> {
  return useQuery({
    queryKey: queryKeys.templates.detail(id ?? ''),
    queryFn: () =>
      api.get<GetTemplateResponse>(
        `/api/templates/${encodeURIComponent(id ?? '')}`,
      ),
    enabled: Boolean(id),
  });
}

function invalidateTemplateCaches(qc: QueryClient, id?: string): void {
  qc.invalidateQueries({ queryKey: queryKeys.templates.all });
  if (id) {
    qc.invalidateQueries({ queryKey: queryKeys.templates.detail(id) });
  }
}

export function useCreateTemplate(): UseMutationResult<
  CreateTemplateResponse,
  Error,
  CreateTemplateBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<CreateTemplateResponse>('/api/templates', body),
    onSuccess: (res) => invalidateTemplateCaches(qc, res.template.id),
  });
}

export function useUpdateTemplate(): UseMutationResult<
  UpdateTemplateResponse,
  Error,
  { id: string; patch: UpdateTemplateBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdateTemplateResponse>(
        `/api/templates/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: (res) => invalidateTemplateCaches(qc, res.template.id),
  });
}

export function useDeleteTemplate(): UseMutationResult<
  DeleteTemplateResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteTemplateResponse>(
        `/api/templates/${encodeURIComponent(id)}`,
      ),
    onSuccess: (_res, vars) => invalidateTemplateCaches(qc, vars.id),
  });
}

export function useMaterializeTemplate(): UseMutationResult<
  MaterializeTemplateResponse,
  Error,
  { id: string; body?: MaterializeTemplateBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<MaterializeTemplateResponse>(
        `/api/templates/${encodeURIComponent(id)}/materialize`,
        body ?? {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Goals / Initiatives (Wave 17)                                             */
/* -------------------------------------------------------------------------- */

function goalsQueryParams(
  filter: ListGoalsQuery | undefined,
): QueryParams | undefined {
  if (!filter) return undefined;
  const out: QueryParams = {};
  if (filter.status !== undefined) out.status = filter.status;
  if (filter.workspace !== undefined) out.workspace = filter.workspace;
  return out;
}

export function useGoals(
  filter?: ListGoalsQuery,
): UseQueryResult<ListGoalsResponse> {
  return useQuery({
    queryKey: queryKeys.goals.list(filter),
    queryFn: () =>
      api.get<ListGoalsResponse>('/api/goals', goalsQueryParams(filter)),
  });
}

export function useGoal(
  id: string | null | undefined,
): UseQueryResult<GetGoalResponse> {
  return useQuery({
    queryKey: queryKeys.goals.detail(id ?? ''),
    queryFn: () =>
      api.get<GetGoalResponse>(`/api/goals/${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  });
}

function invalidateGoalCaches(qc: QueryClient, id?: string): void {
  qc.invalidateQueries({ queryKey: queryKeys.goals.all });
  if (id) {
    qc.invalidateQueries({ queryKey: queryKeys.goals.detail(id) });
    qc.invalidateQueries({ queryKey: queryKeys.goals.tasks(id) });
  }
}

export function useCreateGoal(): UseMutationResult<
  CreateGoalResponse,
  Error,
  CreateGoalBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.post<CreateGoalResponse>('/api/goals', body),
    onSuccess: (res) => invalidateGoalCaches(qc, res.goal.id),
  });
}

export function useUpdateGoal(): UseMutationResult<
  UpdateGoalResponse,
  Error,
  { id: string; patch: UpdateGoalBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdateGoalResponse>(
        `/api/goals/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: (res) => invalidateGoalCaches(qc, res.goal.id),
  });
}

export function useDeleteGoal(): UseMutationResult<
  DeleteGoalResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteGoalResponse>(`/api/goals/${encodeURIComponent(id)}`),
    onSuccess: (_res, vars) => {
      invalidateGoalCaches(qc, vars.id);
      // Detaching tasks bumped their context — refresh task caches too.
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Businesses                                                                */
/* -------------------------------------------------------------------------- */

export function useBusinesses(): UseQueryResult<ListBusinessesResponse> {
  return useQuery({
    queryKey: queryKeys.businesses.list(),
    queryFn: () => api.get<ListBusinessesResponse>('/api/businesses'),
  });
}

export function useBusiness(
  tag: string | null | undefined,
): UseQueryResult<GetBusinessResponse> {
  return useQuery({
    queryKey: queryKeys.businesses.detail(tag ?? ''),
    queryFn: () =>
      api.get<GetBusinessResponse>(
        `/api/businesses/${encodeURIComponent(tag ?? '')}`,
      ),
    enabled: Boolean(tag),
  });
}

export function usePostBusinessUpdate(): UseMutationResult<
  PostBusinessUpdateResponse,
  Error,
  { tag: string; body: PostBusinessUpdateBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tag, body }) =>
      api.post<PostBusinessUpdateResponse>(
        `/api/businesses/${encodeURIComponent(tag)}/update`,
        body,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.businesses.all });
      qc.invalidateQueries({ queryKey: queryKeys.businesses.detail(vars.tag) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Content pipeline                                                          */
/* -------------------------------------------------------------------------- */

export function useContentList(): UseQueryResult<ListContentResponse> {
  return useQuery({
    queryKey: queryKeys.content.list(),
    queryFn: () => api.get<ListContentResponse>('/api/content'),
  });
}

export function useContentPiece(
  id: string | null | undefined,
): UseQueryResult<GetContentResponse> {
  return useQuery({
    queryKey: queryKeys.content.detail(id ?? ''),
    queryFn: () =>
      api.get<GetContentResponse>(
        `/api/content/${encodeURIComponent(id ?? '')}`,
      ),
    enabled: Boolean(id),
  });
}

function invalidateContentCaches(qc: QueryClient, id?: string): void {
  qc.invalidateQueries({ queryKey: queryKeys.content.all });
  if (id) {
    qc.invalidateQueries({ queryKey: queryKeys.content.detail(id) });
  }
}

export function useCreateContent(): UseMutationResult<
  CreateContentResponse,
  Error,
  CreateContentBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<CreateContentResponse>('/api/content', body),
    onSuccess: (res) => invalidateContentCaches(qc, res.piece.id),
  });
}

export function useUpdateContent(): UseMutationResult<
  UpdateContentResponse,
  Error,
  { id: string; body: UpdateContentBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.patch<UpdateContentResponse>(
        `/api/content/${encodeURIComponent(id)}`,
        body,
      ),
    onSuccess: (res) => invalidateContentCaches(qc, res.piece.id),
  });
}

export function useAdvanceContent(): UseMutationResult<
  AdvanceContentResponse,
  Error,
  { id: string; body: AdvanceContentBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<AdvanceContentResponse>(
        `/api/content/${encodeURIComponent(id)}/advance`,
        body,
      ),
    onSuccess: (res) => invalidateContentCaches(qc, res.piece.id),
  });
}

export function useSetContentDerivative(): UseMutationResult<
  SetDerivativeResponse,
  Error,
  { id: string; body: SetDerivativeBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<SetDerivativeResponse>(
        `/api/content/${encodeURIComponent(id)}/derivatives`,
        body,
      ),
    onSuccess: (res) => invalidateContentCaches(qc, res.piece.id),
  });
}

export function useDeleteContent(): UseMutationResult<
  DeleteContentResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteContentResponse>(
        `/api/content/${encodeURIComponent(id)}`,
      ),
    onSuccess: (_res, vars) => invalidateContentCaches(qc, vars.id),
  });
}

/**
 * Attach (or detach, with `goal_id: null`) a task to a goal. Invalidates both
 * the task's caches and the goals caches (membership + progress shift).
 */
export function useAttachTaskGoal(): UseMutationResult<
  AttachTaskGoalResponse,
  Error,
  { id: string; body: AttachTaskGoalBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<AttachTaskGoalResponse>(
        `/api/tasks/${encodeURIComponent(id)}/goal`,
        body,
      ),
    onSuccess: (res) => {
      invalidateTaskCaches(qc, res.task);
      qc.invalidateQueries({ queryKey: queryKeys.goals.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Calendar                                                                   */
/* -------------------------------------------------------------------------- */

function calendarRangeToParams(
  range: ListCalendarEventsQuery | undefined,
): QueryParams | undefined {
  if (!range) return undefined;
  const out: QueryParams = {};
  if (range.from !== undefined) out.from = range.from;
  if (range.to !== undefined) out.to = range.to;
  return out;
}

export function useCalendarEvents(
  range?: ListCalendarEventsQuery,
): UseQueryResult<ListCalendarEventsResponse> {
  return useQuery({
    queryKey: queryKeys.calendar.events(range),
    queryFn: () =>
      api.get<ListCalendarEventsResponse>(
        '/api/calendar/events',
        calendarRangeToParams(range),
      ),
  });
}

export function useAvailability(
  q: AvailabilityQuery | null,
): UseQueryResult<AvailabilityResponse> {
  return useQuery({
    queryKey: queryKeys.calendar.availability(
      q ?? { from: '', to: '', duration: '' },
    ),
    queryFn: () =>
      api.get<AvailabilityResponse>(
        '/api/calendar/availability',
        q
          ? { from: q.from, to: q.to, duration: q.duration }
          : undefined,
      ),
    enabled: Boolean(q),
  });
}

/* -------------------------------------------------------------------------- */
/*  Daily plan                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Generate (and cache) the daily plan for `date` (YYYY-MM-DD). The server
 * synthesizes the plan on each call from live calendar events + tasks; we
 * keep the result in React Query so reopening the view re-uses the prior
 * synthesis until the user explicitly hits "Regenerate".
 *
 * The query is `enabled: false` by default — callers explicitly trigger it
 * via `refetch()` from the "Generate today's plan" button so we don't pay
 * the calendar API cost on every page load.
 */
export function useDailyPlan(
  date?: string,
): UseQueryResult<DailyPlanResponse> {
  return useQuery({
    queryKey: queryKeys.plan.today(date),
    queryFn: () =>
      api.post<DailyPlanResponse>('/api/plan/today', date ? { date } : {}),
    enabled: false,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  I/O                                                                       */
/* -------------------------------------------------------------------------- */

export function useIoPending(): UseQueryResult<IoPendingResponse> {
  return useQuery({
    queryKey: queryKeys.io.pending,
    queryFn: () => api.get<IoPendingResponse>('/api/io/pending'),
  });
}

export function useIoResults(): UseQueryResult<IoResultsResponse> {
  return useQuery({
    queryKey: queryKeys.io.results,
    queryFn: () => api.get<IoResultsResponse>('/api/io/results'),
  });
}

export function useIoStatus(): UseQueryResult<IoStatusResponse> {
  return useQuery({
    queryKey: queryKeys.io.status,
    queryFn: () => api.get<IoStatusResponse>('/api/io/status'),
  });
}

/* -------------------------------------------------------------------------- */
/*  Server-sent events (push invalidation)                                    */
/* -------------------------------------------------------------------------- */

export type ApiEventKind =
  | 'derived_ingested'
  | 'result_ingested'
  | 'pipeline_changed'
  | 'review_added'
  | 'inbox_ingested'
  | 'task_updated'
  | 'task_created'
  | 'task_deleted'
  | 'conversation_ingested'
  | 'memory_enriched';

export interface ApiEventPayload {
  kind: ApiEventKind;
  task_id?: string;
  parent_id?: string | null;
}

export interface RecentApiEvent {
  at: string;
  kind: string;
  task_id?: string;
  parent_id?: string | null;
}

/**
 * Module-level ring buffer of the last 50 SSE events. Used by the Settings
 * "Copy diagnostic info" action; populated by `useApiEventStream` whenever
 * an event arrives. Kept outside React state so any consumer can read it
 * synchronously without forcing re-renders.
 */
const RECENT_EVENTS: RecentApiEvent[] = [];
const RECENT_EVENTS_CAP = 50;

function pushRecentEvent(entry: RecentApiEvent): void {
  RECENT_EVENTS.unshift(entry);
  if (RECENT_EVENTS.length > RECENT_EVENTS_CAP) {
    RECENT_EVENTS.length = RECENT_EVENTS_CAP;
  }
}

export function getRecentApiEvents(): RecentApiEvent[] {
  return RECENT_EVENTS.slice();
}

/**
 * Subscribe to the API's SSE stream (when the server exposes one). The stream
 * is optional: a connection failure is silently ignored — push events are a
 * latency optimization on top of normal polling/invalidation, not a hard
 * requirement.
 *
 * Mount this once near the app root. The hook returns a cleanup function via
 * `useEffect`.
 */
export function useApiEventStream(): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let source: EventSource | null = null;
    let cancelled = false;

    const handle = (raw: MessageEvent<string>): void => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw.data);
      } catch {
        return;
      }
      // Named events (`event: derived_ingested\ndata: ...`) expose the event
      // name on `raw.type`; the server doesn't always include `kind` in the
      // payload itself, so fall back to that. Unnamed `message` events keep
      // working because the parsed body still wins when it has `.kind`.
      const fromPayload =
        parsed && typeof parsed === 'object' && 'kind' in parsed
          ? (parsed as { kind?: unknown }).kind
          : undefined;
      const kind =
        typeof fromPayload === 'string'
          ? fromPayload
          : typeof raw.type === 'string' && raw.type !== 'message'
            ? raw.type
            : undefined;
      if (kind === undefined) return;
      const taskId =
        parsed && typeof parsed === 'object' && 'taskId' in parsed
          ? (parsed as { taskId?: unknown }).taskId
          : parsed && typeof parsed === 'object' && 'task_id' in parsed
            ? (parsed as { task_id?: unknown }).task_id
            : undefined;
      const parentId =
        parsed && typeof parsed === 'object' && 'parent_id' in parsed
          ? (parsed as { parent_id?: unknown }).parent_id
          : undefined;
      const payload: ApiEventPayload = {
        kind: kind as ApiEventKind,
        ...(typeof taskId === 'string' ? { task_id: taskId } : {}),
        ...(typeof parentId === 'string' || parentId === null
          ? { parent_id: parentId as string | null }
          : {}),
      };
      pushRecentEvent({
        at: new Date().toISOString(),
        kind: payload.kind,
        ...(payload.task_id !== undefined ? { task_id: payload.task_id } : {}),
        ...(payload.parent_id !== undefined
          ? { parent_id: payload.parent_id }
          : {}),
      });

      switch (payload.kind) {
        case 'derived_ingested':
        case 'result_ingested':
        case 'pipeline_changed':
          qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
          qc.invalidateQueries({ queryKey: queryKeys.io.all });
          qc.invalidateQueries({ queryKey: queryKeys.review.all });
          if (payload.task_id) {
            qc.invalidateQueries({
              queryKey: queryKeys.tasks.detail(payload.task_id),
            });
          }
          break;
        case 'review_added':
          qc.invalidateQueries({ queryKey: queryKeys.review.all });
          qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
          break;
        case 'inbox_ingested':
          // New tasks landed in the inbox folder — refresh the tasks list
          // and any active task-detail query.
          qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
          qc.invalidateQueries({ queryKey: queryKeys.io.all });
          if (payload.task_id) {
            qc.invalidateQueries({
              queryKey: queryKeys.tasks.detail(payload.task_id),
            });
          }
          break;
        case 'task_updated':
        case 'task_created':
        case 'task_deleted':
          qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
          if (payload.task_id) {
            qc.invalidateQueries({
              queryKey: queryKeys.tasks.detail(payload.task_id),
            });
          }
          if (payload.parent_id) {
            qc.invalidateQueries({
              queryKey: queryKeys.tasks.children(payload.parent_id),
            });
          }
          break;
        case 'conversation_ingested':
          qc.invalidateQueries({ queryKey: ['conversations'] });
          break;
        case 'memory_enriched':
          // Any enrichment landing → refresh the list AND the detail page
          // (which carries summary + tags + links).
          qc.invalidateQueries({ queryKey: queryKeys.memory.all });
          break;
        default:
          break;
      }
    };

    (async (): Promise<void> => {
      try {
        const url = await apiUrl('/api/events');
        if (cancelled) return;
        source = new EventSource(url);
        source.onmessage = handle;
        // Named event variants (Express SSE often uses `event:` lines).
        const kinds: ApiEventKind[] = [
          'derived_ingested',
          'result_ingested',
          'pipeline_changed',
          'review_added',
          'inbox_ingested',
          'task_updated',
          'task_created',
          'task_deleted',
          'conversation_ingested',
          'memory_enriched',
        ];
        for (const k of kinds) {
          source.addEventListener(k, handle as EventListener);
        }
        source.onerror = (): void => {
          // SSE auto-reconnects; if the endpoint is missing we just stay quiet.
        };
      } catch {
        // No SSE available; rely on standard invalidation.
      }
    })();

    return () => {
      cancelled = true;
      if (source) source.close();
    };
  }, [qc]);
}

/* -------------------------------------------------------------------------- */
/*  Data export / import (Wave 7 power features)                              */
/* -------------------------------------------------------------------------- */

/**
 * Trigger the server-side export. Returns the raw JSON object — callers
 * are responsible for serializing and saving it (the Settings view turns
 * it into a Blob and clicks a hidden anchor for download).
 *
 * NOTE: the server sets `Content-Disposition: attachment`. For programmatic
 * use we still go through `fetch` rather than relying on the browser's
 * default download behavior so we can attach the filename ourselves.
 */
export async function fetchDataExport(): Promise<{
  payload: DataExportResponse;
  filename: string;
}> {
  const url = await apiUrl('/api/data/export');
  const token = await resolveApiToken();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`Export failed: ${response.status}`);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/i.exec(disposition);
  const filename =
    match?.[1] ?? `taskpilot-export-${new Date().toISOString()}.json`;
  const payload = (await response.json()) as DataExportResponse;
  return { payload, filename };
}

export function useExportData(): UseMutationResult<
  { payload: DataExportResponse; filename: string },
  Error,
  void
> {
  return useMutation({
    mutationFn: () => fetchDataExport(),
  });
}

export function useImportData(): UseMutationResult<
  DataImportResponse,
  Error,
  { body: DataImportBody; overwrite?: boolean }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, overwrite }) =>
      api.post<DataImportResponse>(
        '/api/data/import',
        body,
        overwrite ? { overwrite: 'true' } : undefined,
      ),
    onSuccess: () => {
      // Restored data could touch literally every cache — nuke them all so
      // every view re-fetches.
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.io.all });
      qc.invalidateQueries({ queryKey: queryKeys.review.all });
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Auto-launch toggle                                                        */
/* -------------------------------------------------------------------------- */

export function useAutoLaunch(): UseQueryResult<AutoLaunchGetResponse> {
  return useQuery({
    queryKey: ['system', 'auto-launch'],
    queryFn: () =>
      api.get<AutoLaunchGetResponse>('/api/system/auto-launch'),
    staleTime: 30_000,
    retry: false,
  });
}

export function useSetAutoLaunch(): UseMutationResult<
  AutoLaunchSetResponse,
  Error,
  AutoLaunchSetBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AutoLaunchSetBody) =>
      api.post<AutoLaunchSetResponse>('/api/system/auto-launch', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system', 'auto-launch'] });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Projects (derived from tasks list)                                        */
/* -------------------------------------------------------------------------- */

/**
 * One project per distinct tag. The shape is intentionally light — the
 * Projects view does its own aggregation, but exposing the type here lets
 * other consumers (CommandPalette, future widgets) share the same model.
 */
export interface ProjectSummary {
  tag: string;
  total: number;
  open: number;
  in_progress: number;
  done: number;
}

/**
 * Derive a project list from the full task list. Pure function — no
 * network call. Returns projects sorted by total task count, descending.
 */
export function aggregateProjectsFromTasks(tasks: Task[]): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();
  for (const task of tasks) {
    if (!task.tags || task.tags.length === 0) continue;
    for (const tag of task.tags) {
      let entry = map.get(tag);
      if (!entry) {
        entry = { tag, total: 0, open: 0, in_progress: 0, done: 0 };
        map.set(tag, entry);
      }
      entry.total += 1;
      if (task.status === 'in_progress') entry.in_progress += 1;
      else if (task.status === 'done') entry.done += 1;
      else if (
        task.status === 'inbox' ||
        task.status === 'queued' ||
        task.status === 'blocked'
      )
        entry.open += 1;
    }
  }
  return [...map.values()].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return a.tag.localeCompare(b.tag);
  });
}

/**
 * Convenience hook for the Projects view — fetches the full task list and
 * memoizes the aggregation. The Projects view component currently does
 * this inline; this hook is exported for any other consumer that wants
 * the same data.
 */
export function useProjects(): {
  projects: ProjectSummary[];
  isLoading: boolean;
} {
  const tasksQ = useTasksList({});
  const projects = useMemoizedProjects(tasksQ.data?.tasks ?? []);
  return { projects, isLoading: tasksQ.isLoading };
}

// Tiny memoization wrapper so consumers don't re-aggregate on every render
// when the underlying tasks list reference is stable.
function useMemoizedProjects(tasks: Task[]): ProjectSummary[] {
  // useEffect is overkill here; the tasks reference is already memoized by
  // React Query. A plain function call is fine — `aggregateProjectsFromTasks`
  // is O(N) and the task count is bounded by SQLite.
  return aggregateProjectsFromTasks(tasks);
}

/* -------------------------------------------------------------------------- */
/*  GitHub integration                                                        */
/* -------------------------------------------------------------------------- */

const GITHUB_KEYS = {
  status: ['github', 'status'] as const,
  repos: ['github', 'repos'] as const,
  issues: (owner: string, repo: string, state?: string) =>
    ['github', 'issues', owner, repo, state ?? 'open'] as const,
};

/**
 * Probe the connection state. The server hits `GET /user` against the stored
 * PAT — `connected: false` is returned either when no PAT is stored or when
 * the stored one was revoked / 401s.
 */
export function useGitHubStatus(): UseQueryResult<GitHubStatusResponse> {
  return useQuery({
    queryKey: GITHUB_KEYS.status,
    queryFn: () => api.get<GitHubStatusResponse>('/api/github/status'),
    staleTime: 30_000,
    retry: false,
  });
}

export function useConnectGitHub(): UseMutationResult<
  GitHubConnectResponse,
  Error,
  GitHubConnectBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitHubConnectBody) =>
      api.post<GitHubConnectResponse>('/api/github/connect', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GITHUB_KEYS.status });
      qc.invalidateQueries({ queryKey: GITHUB_KEYS.repos });
    },
  });
}

export function useDisconnectGitHub(): UseMutationResult<
  OkResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OkResponse>('/api/github/disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GITHUB_KEYS.status });
      qc.invalidateQueries({ queryKey: GITHUB_KEYS.repos });
    },
  });
}

export function useGitHubRepos(
  enabled = true,
): UseQueryResult<ListGitHubReposResponse> {
  return useQuery({
    queryKey: GITHUB_KEYS.repos,
    queryFn: () => api.get<ListGitHubReposResponse>('/api/github/repos'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useCreateGitHubBranch(): UseMutationResult<
  CreateGitHubBranchResponse,
  Error,
  CreateGitHubBranchBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<CreateGitHubBranchResponse>('/api/github/branches', body),
  });
}

export function useCommitGitHubFiles(): UseMutationResult<
  CommitGitHubFilesResponse,
  Error,
  CommitGitHubFilesBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<CommitGitHubFilesResponse>('/api/github/commits', body),
  });
}

export function useOpenGitHubPull(): UseMutationResult<
  OpenGitHubPullResponse,
  Error,
  OpenGitHubPullBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<OpenGitHubPullResponse>('/api/github/pulls', body),
  });
}

export function useGitHubIssues(
  query: ListGitHubIssuesQuery | null,
): UseQueryResult<ListGitHubIssuesResponse> {
  return useQuery({
    queryKey: GITHUB_KEYS.issues(
      query?.owner ?? '',
      query?.repo ?? '',
      query?.state,
    ),
    queryFn: () => {
      if (!query) {
        return Promise.resolve({ issues: [] } satisfies ListGitHubIssuesResponse);
      }
      const params: QueryParams = { owner: query.owner, repo: query.repo };
      if (query.state) params.state = query.state;
      return api.get<ListGitHubIssuesResponse>('/api/github/issues', params);
    },
    enabled: Boolean(query),
    retry: false,
  });
}

export function useCreateGitHubIssue(): UseMutationResult<
  CreateGitHubIssueResponse,
  Error,
  CreateGitHubIssueBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<CreateGitHubIssueResponse>('/api/github/issues', body),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({
        queryKey: GITHUB_KEYS.issues(vars.owner, vars.repo),
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Permissions                                                                */
/* -------------------------------------------------------------------------- */

export function useTaskPermissions(
  id: string | null | undefined,
): UseQueryResult<GetTaskPermissionsResponse> {
  return useQuery({
    queryKey: queryKeys.permissions.task(id ?? ''),
    queryFn: () =>
      api.get<GetTaskPermissionsResponse>(
        `/api/tasks/${encodeURIComponent(id ?? '')}/permissions`,
      ),
    enabled: Boolean(id),
  });
}

export function useUpdateTaskPermissions(): UseMutationResult<
  UpdateTaskPermissionsResponse,
  Error,
  { id: string; permissions: PermissionSet }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permissions }) =>
      api.patch<UpdateTaskPermissionsResponse>(
        `/api/tasks/${encodeURIComponent(id)}/permissions`,
        { permissions },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({
        queryKey: queryKeys.permissions.task(res.task.id),
      });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function useClearTaskPermissions(): UseMutationResult<
  ClearTaskPermissionsResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<ClearTaskPermissionsResponse>(
        `/api/tasks/${encodeURIComponent(id)}/permissions`,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({
        queryKey: queryKeys.permissions.task(res.task.id),
      });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function usePermissionProfiles(): UseQueryResult<ListPermissionProfilesResponse> {
  return useQuery({
    queryKey: queryKeys.permissions.profiles,
    queryFn: () =>
      api.get<ListPermissionProfilesResponse>('/api/permissions/profiles'),
    staleTime: Infinity,
  });
}

export function useApplyPermissionProfile(): UseMutationResult<
  ApplyPermissionProfileResponse,
  Error,
  { profile: PermissionProfileName; task_id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ profile, task_id }) =>
      api.post<ApplyPermissionProfileResponse>(
        `/api/permissions/profiles/${encodeURIComponent(profile)}/apply`,
        { task_id },
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({
        queryKey: queryKeys.permissions.task(res.task.id),
      });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Task links (Wave 12 intelligence layer)                                   */
/* -------------------------------------------------------------------------- */

export function useTaskLinks(
  id: string | null | undefined,
): UseQueryResult<GetTaskLinksResponse> {
  return useQuery({
    queryKey: queryKeys.links.task(id ?? ''),
    queryFn: () =>
      api.get<GetTaskLinksResponse>(
        `/api/tasks/${encodeURIComponent(id ?? '')}/links`,
      ),
    enabled: Boolean(id),
  });
}

export function useUpdateTaskLinks(): UseMutationResult<
  UpdateTaskLinksResponse,
  Error,
  { id: string; patch: UpdateTaskLinksBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdateTaskLinksResponse>(
        `/api/tasks/${encodeURIComponent(id)}/links`,
        patch,
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: queryKeys.links.task(res.task.id) });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function useAddTaskBlock(): UseMutationResult<
  AddTaskBlockResponse,
  Error,
  { id: string; other_id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, other_id }) =>
      api.post<AddTaskBlockResponse>(
        `/api/tasks/${encodeURIComponent(id)}/links/blocks/${encodeURIComponent(other_id)}`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.links.task(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.links.task(vars.other_id) });
    },
  });
}

export function useRemoveTaskBlock(): UseMutationResult<
  RemoveTaskBlockResponse,
  Error,
  { id: string; other_id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, other_id }) =>
      api.delete<RemoveTaskBlockResponse>(
        `/api/tasks/${encodeURIComponent(id)}/links/blocks/${encodeURIComponent(other_id)}`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.links.task(vars.id) });
      qc.invalidateQueries({ queryKey: queryKeys.links.task(vars.other_id) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Skills registry                                                           */
/* -------------------------------------------------------------------------- */

export function useSkills(): UseQueryResult<ListSkillsResponse> {
  return useQuery({
    queryKey: queryKeys.skills.list,
    queryFn: () => api.get<ListSkillsResponse>('/api/skills'),
    staleTime: 5 * 60_000,
  });
}

export function useSuggestSkills(
  taskId: string | null | undefined,
  enabled = true,
): UseQueryResult<SuggestSkillsForTaskResponse> {
  return useQuery({
    queryKey: queryKeys.skills.suggest(taskId ?? ''),
    queryFn: () =>
      api.get<SuggestSkillsForTaskResponse>(
        `/api/skills/suggest/${encodeURIComponent(taskId ?? '')}`,
      ),
    enabled: Boolean(taskId) && enabled,
  });
}

export function useRegisterSkill(): UseMutationResult<
  RegisterSkillResponse,
  Error,
  RegisterSkillBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<RegisterSkillResponse>('/api/skills/register', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.skills.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Full-text search (Wave 17)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run a full-text search against `GET /api/search`. Returns the ranked
 * results, the total count, and `fts_available` (false when the server fell
 * back to a LIKE scan).
 *
 * The query is `enabled` only when `q` has at least 2 trimmed characters and
 * the hook is explicitly enabled — callers (the command palette, the /search
 * view) own debouncing, so this hook fires on whatever (already-debounced)
 * `q` it receives. Results stay cached briefly so re-opening the palette with
 * the same query is instant.
 *
 * `types` is the list of entity kinds to include; an empty array means "all".
 */
export function useSearch(
  q: string,
  types: SearchEntityType[] = [],
  options: { limit?: number; enabled?: boolean } = {},
): UseQueryResult<SearchResponse> {
  const trimmed = q.trim();
  const limit = options.limit ?? 50;
  const typesParam = [...types].sort().join(',');
  const enabled = (options.enabled ?? true) && trimmed.length >= 2;

  return useQuery({
    queryKey: queryKeys.search.query(trimmed, typesParam, limit),
    queryFn: () => {
      const params: QueryParams = { q: trimmed, limit };
      if (typesParam.length > 0) params.types = typesParam;
      return api.get<SearchResponse>('/api/search', params);
    },
    enabled,
    // Search is cheap + local; keep results fresh-ish but cache enough that
    // arrow-keying through palette ↔ /search doesn't refetch identical queries.
    staleTime: 5_000,
    retry: false,
    // Keep showing the prior page's results while the next query loads so the
    // list doesn't flash empty between keystrokes.
    placeholderData: (prev) => prev,
  });
}

/* -------------------------------------------------------------------------- */
/*  Slack integration                                                         */
/* -------------------------------------------------------------------------- */

const SLACK_KEYS = {
  status: ['slack', 'status'] as const,
  channels: ['slack', 'channels'] as const,
};

/**
 * Probe the connection state. The server hits `auth.test` against the
 * stored bot token — `connected: false` is returned either when no token
 * is stored or when Slack rejects it.
 */
export function useSlackStatus(): UseQueryResult<SlackStatusResponse> {
  return useQuery({
    queryKey: SLACK_KEYS.status,
    queryFn: () => api.get<SlackStatusResponse>('/api/slack/status'),
    staleTime: 30_000,
    retry: false,
  });
}

export function useConnectSlack(): UseMutationResult<
  SlackConnectResponse,
  Error,
  SlackConnectBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SlackConnectBody) =>
      api.post<SlackConnectResponse>('/api/slack/connect', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SLACK_KEYS.status });
      qc.invalidateQueries({ queryKey: SLACK_KEYS.channels });
    },
  });
}

export function useDisconnectSlack(): UseMutationResult<
  OkResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OkResponse>('/api/slack/disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SLACK_KEYS.status });
      qc.invalidateQueries({ queryKey: SLACK_KEYS.channels });
    },
  });
}

export function useSlackChannels(
  enabled = true,
): UseQueryResult<ListSlackChannelsResponse> {
  return useQuery({
    queryKey: SLACK_KEYS.channels,
    queryFn: () =>
      api.get<ListSlackChannelsResponse>('/api/slack/channels'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function usePostToSlack(): UseMutationResult<
  PostSlackMessageResponse,
  Error,
  PostSlackMessageBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<PostSlackMessageResponse>('/api/slack/post', body),
  });
}

export function useSlackCaptureNow(): UseMutationResult<
  SlackCaptureNowResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<SlackCaptureNowResponse>('/api/slack/capture-now'),
    onSuccess: () => {
      // New tasks may have landed — refresh task lists.
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.io.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Notion integration                                                        */
/* -------------------------------------------------------------------------- */

const NOTION_KEYS = {
  status: ['notion', 'status'] as const,
  databases: ['notion', 'databases'] as const,
};

/**
 * Probe the connection state. The server hits `users.me` against the
 * stored token — `connected: false` is returned when no token is
 * stored or when Notion rejects it.
 */
export function useNotionStatus(): UseQueryResult<NotionStatusResponse> {
  return useQuery({
    queryKey: NOTION_KEYS.status,
    queryFn: () => api.get<NotionStatusResponse>('/api/notion/status'),
    staleTime: 30_000,
    retry: false,
  });
}

export function useConnectNotion(): UseMutationResult<
  NotionConnectResponse,
  Error,
  NotionConnectBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NotionConnectBody) =>
      api.post<NotionConnectResponse>('/api/notion/connect', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTION_KEYS.status });
      qc.invalidateQueries({ queryKey: NOTION_KEYS.databases });
    },
  });
}

export function useDisconnectNotion(): UseMutationResult<
  OkResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OkResponse>('/api/notion/disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTION_KEYS.status });
      qc.invalidateQueries({ queryKey: NOTION_KEYS.databases });
    },
  });
}

export function useNotionDatabases(
  enabled = true,
): UseQueryResult<ListNotionDatabasesResponse> {
  return useQuery({
    queryKey: NOTION_KEYS.databases,
    queryFn: () =>
      api.get<ListNotionDatabasesResponse>('/api/notion/databases'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSelectNotionDatabase(): UseMutationResult<
  SelectNotionDatabaseResponse,
  Error,
  SelectNotionDatabaseBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SelectNotionDatabaseBody) =>
      api.post<SelectNotionDatabaseResponse>(
        '/api/notion/databases/select',
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTION_KEYS.status });
    },
  });
}

export function useNotionSyncNow(): UseMutationResult<
  NotionSyncNowResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<NotionSyncNowResponse>('/api/notion/sync-now'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Gmail integration                                                         */
/* -------------------------------------------------------------------------- */

const GMAIL_KEYS = {
  status: ['gmail', 'status'] as const,
};

/**
 * Probe the connection state. The server inspects the granted scopes in
 * `~/.taskpilot/tokens.json` — `connected: true` requires at least one
 * `gmail.*` scope present. `send_enabled` requires BOTH the `gmail.send`
 * scope AND the `gmail_send_enabled` user toggle.
 */
export function useGmailStatus(): UseQueryResult<GmailStatusResponse> {
  return useQuery({
    queryKey: GMAIL_KEYS.status,
    queryFn: () => api.get<GmailStatusResponse>('/api/gmail/status'),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Kick off the Gmail OAuth flow. Returns `{auth_url, redirect_uri, state}`;
 * callers open `auth_url` in the system browser and poll status. The same
 * Google OAuth2 client is used for Calendar; consent surfaces the union of
 * Calendar + Gmail scopes.
 */
export function useConnectGmail(): UseMutationResult<
  GmailConnectStartResponse,
  Error,
  GmailConnectStartBody | void
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<GmailConnectStartResponse>(
        '/api/gmail/connect/start',
        body ?? {},
      ),
  });
}

export function useCompleteGmailConnect(): UseMutationResult<
  GmailConnectCompleteResponse,
  Error,
  GmailConnectCompleteBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<GmailConnectCompleteResponse>(
        '/api/gmail/connect/complete',
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GMAIL_KEYS.status });
    },
  });
}

export function useDisconnectGmail(): UseMutationResult<
  OkResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<OkResponse>('/api/gmail/disconnect'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GMAIL_KEYS.status });
    },
  });
}

/**
 * Stage a draft email. Does NOT send — the returned `draft_id` is the
 * caller's handle to pass back into `useSendGmailDraft`. The draft is
 * visible in the user's Gmail Drafts folder immediately.
 */
export function useCreateGmailDraft(): UseMutationResult<
  GmailDraftResponse,
  Error,
  GmailDraftBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<GmailDraftResponse>('/api/gmail/messages/draft', body),
  });
}

/**
 * Send a Gmail message — either a previously-staged draft, or a one-shot
 * compose-and-send. Server returns 403 with `gmail_send_disabled` if the
 * user hasn't enabled send on behalf in Settings.
 */
export function useSendGmailDraft(): UseMutationResult<
  GmailSendResponse,
  Error,
  GmailSendBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<GmailSendResponse>('/api/gmail/messages/send', body),
  });
}

export function useGmailLabel(): UseMutationResult<
  OkResponse,
  Error,
  { messageId: string; body: GmailLabelBody }
> {
  return useMutation({
    mutationFn: ({ messageId, body }) =>
      api.post<OkResponse>(
        `/api/gmail/messages/${encodeURIComponent(messageId)}/label`,
        body,
      ),
  });
}

export function useGmailCaptureNow(): UseMutationResult<
  GmailCaptureNowResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<GmailCaptureNowResponse>('/api/gmail/capture-now'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
      qc.invalidateQueries({ queryKey: queryKeys.io.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Reddit                                                                    */
/* -------------------------------------------------------------------------- */

const REDDIT_KEYS = {
  posts: (sub: string, query?: ListSubredditPostsQuery) =>
    ['reddit', 'subreddit', sub, 'posts', query ?? {}] as const,
  post: (sub: string, postId: string) =>
    ['reddit', 'subreddit', sub, 'post', postId] as const,
  search: (sub: string, query: SearchSubredditQuery) =>
    ['reddit', 'subreddit', sub, 'search', query] as const,
};

function redditQueryParams(
  q: ListSubredditPostsQuery | undefined,
): QueryParams | undefined {
  if (!q) return undefined;
  const params: QueryParams = {};
  if (q.sort !== undefined) params.sort = q.sort;
  if (q.limit !== undefined) params.limit = q.limit;
  if (q.t !== undefined) params.t = q.t;
  if (q.after !== undefined) params.after = q.after;
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Fetch posts from a subreddit. Pass `enabled: false` (default when no
 * subreddit string) to skip the call until the user explicitly requests
 * it — the JSON API costs an HTTP round-trip even though it's free.
 */
export function useSubredditPosts(
  subreddit: string | null | undefined,
  query?: ListSubredditPostsQuery,
  options: { enabled?: boolean } = {},
): UseQueryResult<ListSubredditPostsResponse> {
  const sub = subreddit?.trim() ?? '';
  return useQuery({
    queryKey: REDDIT_KEYS.posts(sub, query),
    queryFn: () =>
      api.get<ListSubredditPostsResponse>(
        `/api/reddit/subreddit/${encodeURIComponent(sub)}/posts`,
        redditQueryParams(query),
      ),
    enabled: Boolean(sub) && options.enabled !== false,
    staleTime: 60_000,
    retry: false,
  });
}

export function useRedditPost(
  subreddit: string | null | undefined,
  postId: string | null | undefined,
  query?: GetSubredditPostQuery,
): UseQueryResult<GetSubredditPostResponse> {
  const sub = subreddit?.trim() ?? '';
  const id = postId?.trim() ?? '';
  return useQuery({
    queryKey: REDDIT_KEYS.post(sub, id),
    queryFn: () => {
      const params: QueryParams | undefined =
        query?.limit !== undefined ? { limit: query.limit } : undefined;
      return api.get<GetSubredditPostResponse>(
        `/api/reddit/subreddit/${encodeURIComponent(sub)}/posts/${encodeURIComponent(id)}`,
        params,
      );
    },
    enabled: Boolean(sub) && Boolean(id),
    retry: false,
  });
}

export function useSearchSubreddit(
  subreddit: string | null | undefined,
  query: SearchSubredditQuery | null,
): UseQueryResult<SearchSubredditResponse> {
  const sub = subreddit?.trim() ?? '';
  return useQuery({
    queryKey: REDDIT_KEYS.search(sub, query ?? { q: '' }),
    queryFn: () => {
      if (!query) {
        return Promise.resolve({
          posts: [],
          after: null,
        } satisfies SearchSubredditResponse);
      }
      const params: QueryParams = { q: query.q };
      if (query.sort !== undefined) params.sort = query.sort;
      if (query.limit !== undefined) params.limit = query.limit;
      if (query.restrict_sr !== undefined) {
        params.restrict_sr = query.restrict_sr;
      }
      return api.get<SearchSubredditResponse>(
        `/api/reddit/subreddit/${encodeURIComponent(sub)}/search`,
        params,
      );
    },
    enabled: Boolean(sub) && Boolean(query?.q),
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  Lovable                                                                   */
/* -------------------------------------------------------------------------- */

const LOVABLE_KEYS = {
  task: (id: string) => ['lovable', 'task', id] as const,
};

export function useTaskLovable(
  taskId: string | null | undefined,
): UseQueryResult<GetTaskLovableResponse> {
  return useQuery({
    queryKey: LOVABLE_KEYS.task(taskId ?? ''),
    queryFn: () =>
      api.get<GetTaskLovableResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/lovable`,
      ),
    enabled: Boolean(taskId),
    retry: false,
  });
}

export function useAttachTaskLovable(): UseMutationResult<
  AttachTaskLovableResponse,
  Error,
  { task_id: string; body: AttachTaskLovableBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task_id, body }) =>
      api.post<AttachTaskLovableResponse>(
        `/api/tasks/${encodeURIComponent(task_id)}/lovable`,
        body,
      ),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: LOVABLE_KEYS.task(vars.task_id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(res.task.id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useDetachTaskLovable(): UseMutationResult<
  DetachTaskLovableResponse,
  Error,
  { task_id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task_id }) =>
      api.delete<DetachTaskLovableResponse>(
        `/api/tasks/${encodeURIComponent(task_id)}/lovable`,
      ),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: LOVABLE_KEYS.task(vars.task_id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(res.task.id) });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Reports                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the day count for a window. The dashboard uses the same window
 * value for both the time-series endpoints (which expect `days`) and the
 * rate/median endpoints (which expect `window`), so we centralise the
 * conversion here.
 */
function windowToDays(window: ReportWindow): number {
  if (window === '7d') return 7;
  if (window === '30d') return 30;
  if (window === '90d') return 90;
  return 90; // 'all' falls back to 90d for the time-series widgets.
}

const REPORTS_KEYS = {
  all: ['reports'] as const,
  bundle: (window: ReportWindow, days?: number) =>
    ['reports', 'bundle', window, days ?? windowToDays(window)] as const,
  throughput: (days: number) => ['reports', 'throughput', days] as const,
  successRate: (window: ReportWindow) =>
    ['reports', 'success-rate', window] as const,
  timeToDone: (window: ReportWindow) =>
    ['reports', 'time-to-done', window] as const,
  tags: (window: ReportWindow, limit?: number) =>
    ['reports', 'tags', window, limit ?? 20] as const,
  failures: (limit?: number) => ['reports', 'failures', limit ?? 10] as const,
  reviewTrend: (days: number) => ['reports', 'review-trend', days] as const,
};

/**
 * Fetch every report in a single round-trip. The dashboard view uses this
 * as its primary query so the whole grid loads together — individual
 * widgets can still subscribe to a sub-query if they need to re-render
 * independently, but the default is "one fetch per filter change".
 *
 * `staleTime` is 60s so flipping between views doesn't refetch immediately;
 * the SSE bridge invalidates `['reports']` on `task_updated` events, which
 * is the main path back to fresh data.
 */
export function useReportsBundle(
  window: ReportWindow = '30d',
  days?: number,
): UseQueryResult<ReportsAllResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.bundle(window, days),
    queryFn: () => {
      const params: QueryParams = { window };
      if (days !== undefined) params.days = days;
      return api.get<ReportsAllResponse>('/api/reports/all', params);
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsThroughput(
  days = 30,
): UseQueryResult<ThroughputResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.throughput(days),
    queryFn: () =>
      api.get<ThroughputResponse>('/api/reports/throughput', { days }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsSuccessRate(
  window: ReportWindow = '30d',
): UseQueryResult<SuccessRateResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.successRate(window),
    queryFn: () =>
      api.get<SuccessRateResponse>('/api/reports/success-rate', { window }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsTimeToDone(
  window: ReportWindow = '30d',
): UseQueryResult<TimeToDoneResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.timeToDone(window),
    queryFn: () =>
      api.get<TimeToDoneResponse>('/api/reports/time-to-done', { window }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsTags(
  window: ReportWindow = '30d',
  limit = 20,
): UseQueryResult<TagHeatMapResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.tags(window, limit),
    queryFn: () =>
      api.get<TagHeatMapResponse>('/api/reports/tags', { window, limit }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsFailures(
  limit = 10,
): UseQueryResult<RecentFailuresResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.failures(limit),
    queryFn: () =>
      api.get<RecentFailuresResponse>('/api/reports/failures', { limit }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useReportsReviewTrend(
  days = 30,
): UseQueryResult<ReviewTrendResponse> {
  return useQuery({
    queryKey: REPORTS_KEYS.reviewTrend(days),
    queryFn: () =>
      api.get<ReviewTrendResponse>('/api/reports/review-trend', { days }),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Re-export the window-to-days converter so callers (the Reports view in
 * particular) can keep the date-range picker in sync without redefining it.
 */
export { windowToDays as reportsWindowToDays };

/* -------------------------------------------------------------------------- */
/*  Status report (Wave 16E)                                                  */
/* -------------------------------------------------------------------------- */

const STATUS_REPORT_KEYS = {
  all: ['status-report'] as const,
  preview: (window: StatusReportWindow) =>
    ['status-report', 'preview', window] as const,
  history: (limit: number) => ['status-report', 'history', limit] as const,
  schedule: ['status-report', 'schedule'] as const,
};

/**
 * Live preview of the status report for a window. Generates but does NOT
 * publish — the view re-runs this as the window picker changes. `staleTime`
 * is short because the report is "what just happened" and the user expects it
 * to reflect recent task activity.
 */
export function useStatusReportPreview(
  window: StatusReportWindow = '7d',
): UseQueryResult<StatusReportPreviewResponse> {
  return useQuery({
    queryKey: STATUS_REPORT_KEYS.preview(window),
    queryFn: () =>
      api.get<StatusReportPreviewResponse>('/api/reports/status/preview', {
        window,
      }),
    staleTime: 15_000,
    retry: false,
  });
}

export function useStatusReportHistory(
  limit = 20,
): UseQueryResult<StatusReportHistoryResponse> {
  return useQuery({
    queryKey: STATUS_REPORT_KEYS.history(limit),
    queryFn: () =>
      api.get<StatusReportHistoryResponse>('/api/reports/status/history', {
        limit,
      }),
    staleTime: 15_000,
    retry: false,
  });
}

export function useStatusReportSchedule(): UseQueryResult<StatusReportScheduleResponse> {
  return useQuery({
    queryKey: STATUS_REPORT_KEYS.schedule,
    queryFn: () =>
      api.get<StatusReportScheduleResponse>('/api/reports/status/schedule'),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Generate + publish a report. Invalidates the history list on success so a
 * freshly generated report shows up immediately.
 */
export function useGenerateStatusReport(): UseMutationResult<
  GenerateStatusReportResponse,
  unknown,
  GenerateStatusReportBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateStatusReportBody) =>
      api.post<GenerateStatusReportResponse>('/api/reports/status', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_REPORT_KEYS.all });
    },
  });
}

export function useUpdateStatusReportSchedule(): UseMutationResult<
  StatusReportScheduleResponse,
  unknown,
  UpdateStatusReportScheduleBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateStatusReportScheduleBody) =>
      api.patch<StatusReportScheduleResponse>(
        '/api/reports/status/schedule',
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: STATUS_REPORT_KEYS.schedule });
    },
  });
}

/** Re-export the destination union for views that build toggle lists. */
export type { StatusReportDestination };

/* -------------------------------------------------------------------------- */
/*  Backups (Wave 12 — Settings → Advanced)                                   */
/* -------------------------------------------------------------------------- */

const BACKUPS_KEYS = {
  list: ['backups', 'list'] as const,
  status: ['backups', 'status'] as const,
};

export function useBackupsList(): UseQueryResult<ListBackupsResponse> {
  return useQuery({
    queryKey: BACKUPS_KEYS.list,
    queryFn: () => api.get<ListBackupsResponse>('/api/backups'),
    staleTime: 5_000,
  });
}

export function useBackupsStatus(): UseQueryResult<BackupsStatusResponse> {
  return useQuery({
    queryKey: BACKUPS_KEYS.status,
    queryFn: () => api.get<BackupsStatusResponse>('/api/backups/status'),
    staleTime: 5_000,
    refetchInterval: 30_000,
  });
}

export function useCreateBackup(): UseMutationResult<
  CreateBackupResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CreateBackupResponse>('/api/backups'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BACKUPS_KEYS.list });
      qc.invalidateQueries({ queryKey: BACKUPS_KEYS.status });
    },
  });
}

export function useDeleteBackup(): UseMutationResult<
  DeleteBackupResponse,
  Error,
  { filename: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ filename }) =>
      api.delete<DeleteBackupResponse>(
        `/api/backups/${encodeURIComponent(filename)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BACKUPS_KEYS.list });
      qc.invalidateQueries({ queryKey: BACKUPS_KEYS.status });
    },
  });
}

export function useRestoreBackup(): UseMutationResult<
  RestoreBackupResponse,
  Error,
  { filename: string }
> {
  return useMutation({
    mutationFn: ({ filename }) =>
      api.post<RestoreBackupResponse>(
        `/api/backups/${encodeURIComponent(filename)}/restore`,
      ),
  });
}

/* -------------------------------------------------------------------------- */
/*  Telemetry (Wave 12 — Settings → Advanced)                                 */
/* -------------------------------------------------------------------------- */

const TELEMETRY_KEYS = {
  status: ['telemetry', 'status'] as const,
};

export function useTelemetryStatus(): UseQueryResult<TelemetryStatusResponse> {
  return useQuery({
    queryKey: TELEMETRY_KEYS.status,
    queryFn: () => api.get<TelemetryStatusResponse>('/api/telemetry/status'),
    staleTime: 10_000,
    refetchInterval: 60_000,
  });
}

export function useFlushTelemetry(): UseMutationResult<
  TelemetryFlushResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<TelemetryFlushResponse>('/api/telemetry/flush'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TELEMETRY_KEYS.status });
    },
  });
}

export function useRecordTelemetry(): UseMutationResult<
  OkResponse,
  Error,
  RecordTelemetryEventBody
> {
  return useMutation({
    mutationFn: (body) => api.post<OkResponse>('/api/telemetry/event', body),
  });
}

/* -------------------------------------------------------------------------- */
/*  Cost tracking (Wave 13)                                                   */
/* -------------------------------------------------------------------------- */

const COST_KEYS = {
  all: ['cost'] as const,
  summary: (window: string) => ['cost', 'summary', window] as const,
  events: (taskId?: string, limit?: number) =>
    ['cost', 'events', taskId ?? '', limit ?? 200] as const,
};

export function useCostSummary(
  window = '30d',
): UseQueryResult<CostSummaryResponse> {
  return useQuery({
    queryKey: COST_KEYS.summary(window),
    queryFn: () =>
      api.get<CostSummaryResponse>('/api/cost/summary', { window }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCostEvents(
  taskId?: string,
  limit = 200,
): UseQueryResult<ListCostEventsResponse> {
  return useQuery({
    queryKey: COST_KEYS.events(taskId, limit),
    queryFn: () => {
      const params: QueryParams = { limit };
      if (taskId) params.task_id = taskId;
      return api.get<ListCostEventsResponse>('/api/cost/events', params);
    },
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Total cost (LLM + third-party USD) attributed to a single task. Gated by
 * `enabled` so list views can opt individual cards in without firing a
 * request per card when cost display is off.
 */
export function useTaskCost(
  taskId: string | null | undefined,
  enabled = true,
): UseQueryResult<number> {
  return useQuery({
    queryKey: [...COST_KEYS.events(taskId ?? undefined, 200), 'total'] as const,
    queryFn: () =>
      api.get<ListCostEventsResponse>('/api/cost/events', {
        limit: 200,
        ...(taskId ? { task_id: taskId } : {}),
      }),
    enabled: enabled && Boolean(taskId),
    staleTime: 30_000,
    retry: false,
    select: (data) =>
      data.events.reduce(
        (sum, e) => sum + (e.cost_usd ?? 0) + (e.third_party_cost_usd ?? 0),
        0,
      ),
  });
}

export function useRecordCostEvent(): UseMutationResult<
  RecordCostEventResponse,
  Error,
  RecordCostEventBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<RecordCostEventResponse>('/api/cost/events', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: COST_KEYS.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Feedback (Wave 13)                                                        */
/* -------------------------------------------------------------------------- */

const FEEDBACK_KEYS = {
  all: ['feedback'] as const,
  forTask: (taskId: string) => ['feedback', 'task', taskId] as const,
};

export function useFeedbackForTask(
  taskId: string | null | undefined,
): UseQueryResult<ListFeedbackResponse> {
  return useQuery({
    queryKey: FEEDBACK_KEYS.forTask(taskId ?? ''),
    queryFn: () =>
      api.get<ListFeedbackResponse>('/api/feedback', { task_id: taskId ?? '' }),
    enabled: Boolean(taskId),
    staleTime: 30_000,
    retry: false,
  });
}

export function useRecordFeedback(): UseMutationResult<
  RecordFeedbackResponse,
  Error,
  RecordFeedbackBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<RecordFeedbackResponse>('/api/feedback', body),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: FEEDBACK_KEYS.all });
      qc.invalidateQueries({ queryKey: FEEDBACK_KEYS.forTask(vars.task_id) });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Task journal (Wave 15A)                                                   */
/* -------------------------------------------------------------------------- */

const JOURNAL_KEYS = {
  all: ['journal'] as const,
  forTask: (taskId: string, limit: number) =>
    ['journal', 'task', taskId, limit] as const,
};

/**
 * Fetch the chronological event narrative for a task.
 *
 * The renderer pages by re-calling with a larger `limit` rather than using
 * `since` — the timeline only grows append-only at the head, so re-fetching
 * the whole window is simpler than threading a cursor.
 */
export function useTaskJournal(
  taskId: string | null | undefined,
  limit = 100,
): UseQueryResult<JournalResponse> {
  return useQuery({
    queryKey: JOURNAL_KEYS.forTask(taskId ?? '', limit),
    queryFn: () =>
      api.get<JournalResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/journal`,
        { limit },
      ),
    enabled: Boolean(taskId),
    staleTime: 15_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  Decision log (Wave 16)                                                    */
/* -------------------------------------------------------------------------- */

const DECISION_KEYS = {
  all: ['decisions'] as const,
  forTask: (taskId: string) => ['decisions', 'task', taskId] as const,
};

/**
 * Fetch the append-only decision log for a task (newest-first).
 */
export function useTaskDecisions(
  taskId: string | null | undefined,
): UseQueryResult<ListDecisionsResponse> {
  return useQuery({
    queryKey: DECISION_KEYS.forTask(taskId ?? ''),
    queryFn: () =>
      api.get<ListDecisionsResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/decisions`,
      ),
    enabled: Boolean(taskId),
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Append a decision-log entry. Invalidates the task's decision list and its
 * journal (the journal surfaces decisions too).
 */
export function useCreateDecision(): UseMutationResult<
  CreateDecisionResponse,
  Error,
  { taskId: string; body: CreateDecisionBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }) =>
      api.post<CreateDecisionResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/decisions`,
        body,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: DECISION_KEYS.forTask(vars.taskId) });
      qc.invalidateQueries({ queryKey: JOURNAL_KEYS.all });
    },
  });
}

/**
 * Delete a decision-log entry by its own id. The mutation carries the parent
 * `taskId` so we can invalidate that task's list afterward.
 */
export function useDeleteDecision(): UseMutationResult<
  DeleteDecisionResponse,
  Error,
  { id: string; taskId: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteDecisionResponse>(
        `/api/decisions/${encodeURIComponent(id)}`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: DECISION_KEYS.forTask(vars.taskId) });
      qc.invalidateQueries({ queryKey: JOURNAL_KEYS.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Generic webhooks (Wave 13)                                                */
/* -------------------------------------------------------------------------- */

import type {
  CreateWebhookConfigBody,
  CreateWebhookConfigResponse,
  DeleteWebhookConfigResponse,
  ImportCommitBody,
  ImportCommitResponse,
  ImportPreviewBody,
  ImportPreviewResponse,
  ImportSuggestBody,
  ImportSuggestResponse,
  ListWebhookConfigsResponse,
  TestWebhookConfigBody,
  TestWebhookConfigResponse,
  UpdateWebhookConfigBody,
  UpdateWebhookConfigResponse,
} from '@/shared/api-contract';

const WEBHOOK_CONFIGS_KEY = ['webhooks', 'configs'] as const;

export function useWebhookConfigs(): UseQueryResult<ListWebhookConfigsResponse> {
  return useQuery({
    queryKey: WEBHOOK_CONFIGS_KEY,
    queryFn: () => api.get<ListWebhookConfigsResponse>('/api/webhooks/configs'),
  });
}

export function useCreateWebhookConfig(): UseMutationResult<
  CreateWebhookConfigResponse,
  Error,
  CreateWebhookConfigBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<CreateWebhookConfigResponse>('/api/webhooks/configs', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WEBHOOK_CONFIGS_KEY });
    },
  });
}

export function useUpdateWebhookConfig(): UseMutationResult<
  UpdateWebhookConfigResponse,
  Error,
  { id: string; patch: UpdateWebhookConfigBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdateWebhookConfigResponse>(
        `/api/webhooks/configs/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WEBHOOK_CONFIGS_KEY });
    },
  });
}

export function useDeleteWebhookConfig(): UseMutationResult<
  DeleteWebhookConfigResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteWebhookConfigResponse>(
        `/api/webhooks/configs/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: WEBHOOK_CONFIGS_KEY });
    },
  });
}

export function useTestWebhookConfig(): UseMutationResult<
  TestWebhookConfigResponse,
  Error,
  { id: string; body: TestWebhookConfigBody }
> {
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.post<TestWebhookConfigResponse>(
        `/api/webhooks/configs/${encodeURIComponent(id)}/test`,
        body,
      ),
  });
}

/* -------------------------------------------------------------------------- */
/*  Bulk import (Wave 13)                                                     */
/* -------------------------------------------------------------------------- */

export function useImportSuggest(): UseMutationResult<
  ImportSuggestResponse,
  Error,
  ImportSuggestBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<ImportSuggestResponse>('/api/import/suggest', body),
  });
}

export function useImportPreview(): UseMutationResult<
  ImportPreviewResponse,
  Error,
  ImportPreviewBody
> {
  return useMutation({
    mutationFn: (body) =>
      api.post<ImportPreviewResponse>('/api/import/preview', body),
  });
}

export function useImportCommit(): UseMutationResult<
  ImportCommitResponse,
  Error,
  ImportCommitBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<ImportCommitResponse>('/api/import/commit', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Attachments (Wave 13)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fetch the metadata array for a task's attachments. Uploads invalidate
 * this — see `AttachmentDrop` / `useDeleteAttachment` for the wiring.
 *
 * Note: uploads themselves go through `fetch` directly (multipart FormData
 * doesn't round-trip cleanly through the JSON wrapper in `api.*`). The
 * dropzone component owns that path and invalidates the cache below on
 * success.
 */
export function useTaskAttachments(
  taskId: string | null | undefined,
): UseQueryResult<ListAttachmentsResponse> {
  return useQuery({
    queryKey: queryKeys.attachments.task(taskId ?? ''),
    queryFn: () =>
      api.get<ListAttachmentsResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/attachments`,
      ),
    enabled: Boolean(taskId),
  });
}

export function useDeleteAttachment(): UseMutationResult<
  DeleteAttachmentResponse,
  Error,
  { task_id: string; filename: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ task_id, filename }) =>
      api.delete<DeleteAttachmentResponse>(
        `/api/tasks/${encodeURIComponent(task_id)}/attachments/${encodeURIComponent(filename)}`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({
        queryKey: queryKeys.attachments.task(vars.task_id),
      });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(vars.task_id) });
    },
  });
}

/**
 * Invalidate the attachments cache for a task. Called by `AttachmentDrop`
 * after a successful upload (the dropzone bypasses the JSON wrapper).
 */
export function useInvalidateTaskAttachments(): (taskId: string) => void {
  const qc = useQueryClient();
  return (taskId: string) => {
    qc.invalidateQueries({ queryKey: queryKeys.attachments.task(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
  };
}

/* -------------------------------------------------------------------------- */
/*  Cowork queue (Wave 13)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tasks waiting on a human in the Cowork window. Pulls every queued task,
 * then filters to `agent_method` in {`cowork`, `either`} client-side so we
 * don't need a new server endpoint. The query rides on the existing
 * `/api/tasks` route and re-renders whenever the tasks list changes via
 * the SSE bridge.
 */
export interface CoworkQueueItem {
  task: Task;
}

export interface CoworkQueueResult {
  items: CoworkQueueItem[];
  count: number;
  isLoading: boolean;
}

export function useCoworkQueue(filter?: {
  status?: 'inbox' | 'queued' | 'in_progress' | 'all';
}): CoworkQueueResult {
  const status = filter?.status ?? 'queued';
  const query =
    status === 'all'
      ? undefined
      : ({ status } as ListTasksQuery);
  const listQ = useTasksList(query);
  const tasks = listQ.data?.tasks ?? [];
  const filtered = tasks.filter(
    (t) => t.agent_method === 'cowork' || t.agent_method === 'either',
  );
  return {
    items: filtered.map((task) => ({ task })),
    count: filtered.length,
    isLoading: listQ.isLoading,
  };
}

/* -------------------------------------------------------------------------- */
/*  Outputs panel + briefing pack (Wave 15)                                   */
/* -------------------------------------------------------------------------- */

import type {
  GetOutputFileContentResponse,
  GetTaskOutputsResponse,
} from '@/shared/api-contract';

/**
 * React Query key namespace for the outputs panel. Kept inline so the
 * `queryKeys` factory at the top of the file doesn't grow without
 * coordination across waves.
 */
const OUTPUTS_KEYS = {
  all: ['outputs'] as const,
  task: (taskId: string) => ['outputs', 'task', taskId] as const,
};

/**
 * Fetch the {@link OutputBundle} for a task. Returned shape is everything
 * the Outputs panel needs to render — files, artifacts, attachments,
 * summary, metrics. Re-renders whenever the task detail cache is
 * invalidated, so a fresh execution surfaces new outputs without manual
 * wiring.
 */
export function useTaskOutputs(
  taskId: string | null | undefined,
): UseQueryResult<GetTaskOutputsResponse> {
  return useQuery({
    queryKey: OUTPUTS_KEYS.task(taskId ?? ''),
    queryFn: () =>
      api.get<GetTaskOutputsResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/outputs`,
      ),
    enabled: Boolean(taskId),
    staleTime: 15_000,
  });
}

/**
 * Fetch one output/attachment file's full (capped) content for the in-app
 * viewer. Only enabled when both a task id and a file path are present and
 * `enabled` is true (so the query doesn't fire until the viewer opens).
 */
export function useOutputFileContent(
  taskId: string | null | undefined,
  filePath: string | null | undefined,
  enabled = true,
): UseQueryResult<GetOutputFileContentResponse> {
  return useQuery({
    queryKey: ['outputs', 'file', taskId ?? '', filePath ?? ''],
    queryFn: () =>
      api.get<GetOutputFileContentResponse>(
        `/api/tasks/${encodeURIComponent(
          taskId ?? '',
        )}/outputs/file?path=${encodeURIComponent(filePath ?? '')}`,
      ),
    enabled: Boolean(taskId) && Boolean(filePath) && enabled,
    staleTime: 30_000,
  });
}

/**
 * Trigger a briefing-pack download. Returns a function the consumer can
 * call (e.g. from a button click) — we don't use `useMutation` because the
 * happy path is "stream a ZIP to disk", not "POST and get JSON back".
 *
 * The function builds a token-bearing URL, fetches the ZIP, and pipes the
 * blob into an anchor with `download="<filename>"` so the browser saves
 * it locally. Throws on any HTTP failure so callers can `try/catch` and
 * toast.
 */
export function useBriefingPack(): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const url = await apiUrl(
      `/api/tasks/${encodeURIComponent(taskId)}/briefing-pack`,
    );
    const token = await resolveApiToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, { method: 'GET', headers });
    if (!response.ok) {
      // Try to surface the canonical error message before bailing.
      let message = `Briefing pack failed (${response.status})`;
      try {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        if (body?.error?.message) message = body.error.message;
      } catch {
        /* leave default */
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = `task-${taskId}-briefing.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  };
}

/* -------------------------------------------------------------------------- */
/*  Knowledge base                                                            */
/* -------------------------------------------------------------------------- */

import type {
  GetKnowledgeOverviewResponse,
  GetKnowledgeResourcesResponse,
  GetTaskKnowledgeResponse,
  ReindexKnowledgeResponse,
} from '@/shared/api-contract';

const KNOWLEDGE_KEYS = {
  all: ['knowledge'] as const,
  overview: ['knowledge', 'overview'] as const,
  resources: (business: string) => ['knowledge', 'resources', business] as const,
  task: (taskId: string) => ['knowledge', 'task', taskId] as const,
};

/** Overview of the knowledge base: businesses + extractor status. */
export function useKnowledgeOverview(): UseQueryResult<GetKnowledgeOverviewResponse> {
  return useQuery({
    queryKey: KNOWLEDGE_KEYS.overview,
    queryFn: () => api.get<GetKnowledgeOverviewResponse>('/api/knowledge'),
    staleTime: 30_000,
  });
}

/** Full catalog for one business. */
export function useKnowledgeResources(
  business: string | null | undefined,
): UseQueryResult<GetKnowledgeResourcesResponse> {
  return useQuery({
    queryKey: KNOWLEDGE_KEYS.resources(business ?? ''),
    queryFn: () =>
      api.get<GetKnowledgeResourcesResponse>(
        `/api/knowledge/resources/${encodeURIComponent(business ?? '')}`,
      ),
    enabled: Boolean(business),
    staleTime: 30_000,
  });
}

/** Knowledge resources matched to a task. */
export function useTaskKnowledge(
  taskId: string | null | undefined,
): UseQueryResult<GetTaskKnowledgeResponse> {
  return useQuery({
    queryKey: KNOWLEDGE_KEYS.task(taskId ?? ''),
    queryFn: () =>
      api.get<GetTaskKnowledgeResponse>(
        `/api/knowledge/task/${encodeURIComponent(taskId ?? '')}`,
      ),
    enabled: Boolean(taskId),
    staleTime: 30_000,
  });
}

/** Reindex all businesses, or one when `business` is supplied. */
export function useReindexKnowledge(): UseMutationResult<
  ReindexKnowledgeResponse,
  Error,
  { business?: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ business }) =>
      api.post<ReindexKnowledgeResponse>(
        '/api/knowledge/reindex',
        business ? { business } : {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KNOWLEDGE_KEYS.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Phases / pipelines (Wave 15)                                              */
/* -------------------------------------------------------------------------- */

import type {
  CreatePipelineBody,
  CreatePipelineResponse,
  DeletePipelineResponse,
  GetTaskPhaseResponse,
  ListPipelinesResponse,
  UpdatePipelineBody,
  UpdatePipelineResponse,
  UpdateTaskPhaseBody,
  UpdateTaskPhaseResponse,
} from '@/shared/api-contract';

const PHASES_KEYS = {
  pipelines: ['phases', 'pipelines'] as const,
  task: (taskId: string) => ['phases', 'task', taskId] as const,
};

/**
 * Fetch the pipeline catalog. Server-side seeds the defaults on first read,
 * so this always returns a non-empty list.
 */
export function usePipelines(): UseQueryResult<ListPipelinesResponse> {
  return useQuery({
    queryKey: PHASES_KEYS.pipelines,
    queryFn: () =>
      api.get<ListPipelinesResponse>('/api/phases/pipelines'),
    staleTime: 60_000,
  });
}

export function useCreatePipeline(): UseMutationResult<
  CreatePipelineResponse,
  Error,
  CreatePipelineBody
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<CreatePipelineResponse>('/api/phases/pipelines', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.pipelines });
    },
  });
}

export function useUpdatePipeline(): UseMutationResult<
  UpdatePipelineResponse,
  Error,
  { id: string; patch: UpdatePipelineBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<UpdatePipelineResponse>(
        `/api/phases/pipelines/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.pipelines });
      qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
    },
  });
}

export function useDeletePipeline(): UseMutationResult<
  DeletePipelineResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeletePipelineResponse>(
        `/api/phases/pipelines/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.pipelines });
    },
  });
}

export function useResetPipelines(): UseMutationResult<
  ListPipelinesResponse,
  Error,
  void
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<ListPipelinesResponse>('/api/phases/pipelines/reset'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.pipelines });
    },
  });
}

/**
 * Fetch the resolved phase + pipeline for a single task.
 */
export function useTaskPhase(
  taskId: string | null | undefined,
): UseQueryResult<GetTaskPhaseResponse> {
  return useQuery({
    queryKey: PHASES_KEYS.task(taskId ?? ''),
    queryFn: () =>
      api.get<GetTaskPhaseResponse>(
        `/api/tasks/${encodeURIComponent(taskId ?? '')}/phase`,
      ),
    enabled: Boolean(taskId),
    staleTime: 10_000,
  });
}

export function useUpdateTaskPhase(): UseMutationResult<
  UpdateTaskPhaseResponse,
  Error,
  { id: string; body: UpdateTaskPhaseBody }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      api.patch<UpdateTaskPhaseResponse>(
        `/api/tasks/${encodeURIComponent(id)}/phase`,
        body,
      ),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.task(vars.id) });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function useAdvanceTaskPhase(): UseMutationResult<
  UpdateTaskPhaseResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<UpdateTaskPhaseResponse>(
        `/api/tasks/${encodeURIComponent(id)}/phase/advance`,
      ),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.task(vars.id) });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

export function useRegressTaskPhase(): UseMutationResult<
  UpdateTaskPhaseResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<UpdateTaskPhaseResponse>(
        `/api/tasks/${encodeURIComponent(id)}/phase/regress`,
      ),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: PHASES_KEYS.task(vars.id) });
      invalidateTaskCaches(qc, res.task);
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Cross-task knowledge graph (Wave 17)                                      */
/* -------------------------------------------------------------------------- */

import type {
  GraphResponse,
  GraphScope as GraphScopeContract,
} from '@/shared/api-contract';

const GRAPH_KEYS = {
  all: ['graph'] as const,
  scope: (kind: GraphScopeContract['kind'], value?: string) =>
    ['graph', kind, value ?? ''] as const,
};

/**
 * Fetch the cross-task knowledge graph for a scope. `value` is the workspace
 * id / tag / root task id (ignored for the `all` scope). The result is the
 * full set of nodes + edges; the Graph view lays it out client-side with a
 * hand-rolled force simulation. Re-renders whenever the task cache is
 * invalidated via the SSE bridge.
 */
export function useTaskGraph(
  scope: GraphScopeContract,
): UseQueryResult<GraphResponse> {
  return useQuery({
    queryKey: GRAPH_KEYS.scope(scope.kind, scope.value),
    queryFn: () => {
      const params: QueryParams = { scope: scope.kind };
      if (scope.value !== undefined) params.value = scope.value;
      return api.get<GraphResponse>('/api/graph', params);
    },
    staleTime: 30_000,
    retry: false,
  });
}

/* -------------------------------------------------------------------------- */
/*  Recurring schedules (v5)                                                  */
/* -------------------------------------------------------------------------- */

export type RecurrenceKindString =
  | 'daily'
  | 'weekdays'
  | 'weekly'
  | 'monthly';

export interface ChildTemplate {
  title_template: string;
  instructions_template?: string;
  priority?: 'p0' | 'p1' | 'p2' | 'p3';
  tags?: string[];
}

export interface RecurringSchedule {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  recurrence_kind: RecurrenceKindString;
  recurrence_interval: number;
  next_fire_at: string;
  last_fired_at: string | null;
  fan_out_goal_id: string | null;
  child_templates: ChildTemplate[];
  created_at: string;
  updated_at: string;
}

interface ListSchedulesResponse {
  schedules: RecurringSchedule[];
}
interface GetScheduleResponse {
  schedule: RecurringSchedule;
}
interface FireScheduleResponse {
  schedule_id: string;
  fired_at: string;
  next_fire_at: string;
  created_task_ids: string[];
  expected_count: number;
}

const SCHEDULES_KEYS = {
  all: ['schedules'] as const,
  list: ['schedules', 'list'] as const,
  detail: (id: string) => ['schedules', 'detail', id] as const,
};

function invalidateScheduleCaches(qc: QueryClient, id?: string): void {
  qc.invalidateQueries({ queryKey: SCHEDULES_KEYS.all });
  if (id) qc.invalidateQueries({ queryKey: SCHEDULES_KEYS.detail(id) });
  // Firing a schedule creates tasks — bust the task list too.
  qc.invalidateQueries({ queryKey: queryKeys.tasks.all });
}

export function useSchedules(): UseQueryResult<ListSchedulesResponse> {
  return useQuery({
    queryKey: SCHEDULES_KEYS.list,
    queryFn: () => api.get<ListSchedulesResponse>('/api/schedules'),
  });
}

export function useFireSchedule(): UseMutationResult<
  FireScheduleResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.post<FireScheduleResponse>(
        `/api/schedules/${encodeURIComponent(id)}/fire-now`,
        {},
      ),
    onSuccess: (res) => invalidateScheduleCaches(qc, res.schedule_id),
  });
}

export function useUpdateSchedule(): UseMutationResult<
  GetScheduleResponse,
  Error,
  { id: string; patch: Partial<RecurringSchedule> }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      api.patch<GetScheduleResponse>(
        `/api/schedules/${encodeURIComponent(id)}`,
        patch,
      ),
    onSuccess: (res) => invalidateScheduleCaches(qc, res.schedule.id),
  });
}

export function useDeleteSchedule(): UseMutationResult<
  { ok: true },
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`),
    onSuccess: (_res, { id }) => invalidateScheduleCaches(qc, id),
  });
}

/* -------------------------------------------------------------------------- */
/*  Ambient monitor — /api/context/*  (Watch view, sidebar badge)             */
/* -------------------------------------------------------------------------- */

/**
 * Composed status for the Watch header + Settings status pill + Sidebar
 * badge. Refetched on a short interval so a freshly-completed deliberation
 * surfaces without the user having to touch anything.
 */
export function useContextStatus(): UseQueryResult<ContextMonitorStatusResponse> {
  return useQuery({
    queryKey: queryKeys.context.status(),
    queryFn: () =>
      api.get<ContextMonitorStatusResponse>('/api/context/status'),
    // 10s cadence for a status badge is plenty; react-query pauses this
    // interval automatically while the window is unfocused.
    refetchInterval: 10_000,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * List recent observations. The Watch view passes a `source` filter chip
 * and a `since` ISO timestamp computed from the active time range.
 */
export function useObservations(
  query?: ListContextObservationsQuery,
): UseQueryResult<ListContextObservationsResponse> {
  return useQuery({
    queryKey: queryKeys.context.observations(query),
    queryFn: () => {
      const params: QueryParams = {};
      if (query?.limit !== undefined) params.limit = query.limit;
      if (query?.source !== undefined) params.source = query.source;
      if (query?.since !== undefined) params.since = query.since;
      if (query?.batch_id !== undefined) params.batch_id = query.batch_id;
      if (query?.workspace_id !== undefined) {
        params.workspace_id = query.workspace_id;
      }
      return api.get<ListContextObservationsResponse>(
        '/api/context/observations',
        params,
      );
    },
    staleTime: 5_000,
    retry: false,
  });
}

/** List recent deliberations (verdicts + pending). */
export function useDeliberations(
  query?: ListDeliberationsQuery,
): UseQueryResult<ListDeliberationsResponse> {
  return useQuery({
    queryKey: queryKeys.context.deliberations(query),
    queryFn: () => {
      const params: QueryParams = {};
      if (query?.limit !== undefined) params.limit = query.limit;
      if (query?.status !== undefined) params.status = query.status;
      if (query?.since !== undefined) params.since = query.since;
      return api.get<ListDeliberationsResponse>(
        '/api/context/deliberations',
        params,
      );
    },
    staleTime: 5_000,
    retry: false,
  });
}

/** Fetch a single deliberation joined with its observations. */
export function useDeliberation(
  id: string | null | undefined,
): UseQueryResult<GetDeliberationResponse> {
  return useQuery({
    queryKey: queryKeys.context.deliberation(id ?? ''),
    queryFn: () =>
      api.get<GetDeliberationResponse>(
        `/api/context/deliberations/${encodeURIComponent(id ?? '')}`,
      ),
    enabled: Boolean(id),
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Manual deliberation trigger. Posted by the Watch "Deliberate now" button
 * and the `context.deliberate` command palette entry. The server responds
 * 202 with the new batch_id; the deliberations list refetches automatically.
 */
export function useDeliberateNow(): UseMutationResult<
  RequestDeliberationResponse,
  Error,
  RequestDeliberationBody | undefined
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      api.post<RequestDeliberationResponse>(
        '/api/context/deliberate',
        body ?? { reason: 'manual' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.context.all });
    },
  });
}

/** Remove a single observation (and its screenshot file if any). */
export function useDeleteObservation(): UseMutationResult<
  DeleteContextObservationResponse,
  Error,
  { id: string }
> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) =>
      api.delete<DeleteContextObservationResponse>(
        `/api/context/observations/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.context.all });
    },
  });
}

