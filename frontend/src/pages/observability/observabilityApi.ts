import { API_BASE_URL } from '../realtimeConfig';

export type ObservabilityStatus = 'ok' | 'unauthenticated' | 'disabled' | 'unavailable';

export type ObservabilityResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unauthenticated' }
  | { status: 'disabled' }
  | { status: 'unavailable' };

export type ObservabilityWindow = '1h' | '24h' | '7d';

export interface ObservabilityConfig {
  enabled: boolean;
  authenticated: boolean;
}

export interface ObservabilitySummary {
  window: ObservabilityWindow;
  from: string;
  to: string;
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    series: Array<{ t: string; p50Ms: number | null; p95Ms: number | null }>;
  } | null;
  errorRate: {
    rate: number | null;
    errorCount: number | null;
    totalCount: number | null;
    series: Array<{ t: string; rate: number | null }>;
  } | null;
  cost: {
    totalUsd: number | null;
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
  } | null;
  sessions: { realtime: number | null; cascade: number | null } | null;
}

export interface ObservabilityTraceRow {
  traceId: string;
  timestamp: string;
  mode: 'cascade' | 'realtime';
  latencyMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  status: 'success' | 'error';
}

export interface ObservabilityTraces {
  traces: ObservabilityTraceRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type TraceModeFilter = 'all' | 'cascade' | 'realtime';
export type TraceStatusFilter = 'all' | 'error';

export interface FetchTracesParams {
  window?: ObservabilityWindow;
  mode?: TraceModeFilter;
  status?: TraceStatusFilter;
  limit?: number;
  cursor?: string | null;
}

export type SpanMetadataValue = string | number | boolean | null;
export type SpanMetadata = Record<string, SpanMetadataValue>;

export interface ObservabilitySpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startOffsetMs: number;
  durationMs: number;
  status: 'success' | 'error';
  depth: number;
  input: string | null;
  output: string | null;
  truncated: boolean;
  metadata: SpanMetadata;
}

export interface ObservabilityTraceDetail {
  traceId: string;
  mode: 'cascade' | 'realtime';
  status: 'success' | 'error';
  timestamp: string;
  totalLatencyMs: number | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  model: string | null;
  sessionId: string | null;
  spans: ObservabilitySpan[];
}

function mapStatus(status: number): Exclude<ObservabilityStatus, 'ok'> {
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'disabled';
  return 'unavailable';
}

async function observabilityFetch<T>(path: string, init?: RequestInit): Promise<ObservabilityResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
    });
  } catch {
    return { status: 'unavailable' };
  }

  if (response.ok) {
    if (response.status === 204) {
      return { status: 'ok', data: undefined as T };
    }
    return { status: 'ok', data: (await response.json()) as T };
  }

  return { status: mapStatus(response.status) };
}

export function fetchConfig(): Promise<ObservabilityResult<ObservabilityConfig>> {
  return observabilityFetch<ObservabilityConfig>('/api/observability/config');
}

export function login(token: string): Promise<ObservabilityResult<void>> {
  return observabilityFetch<void>('/api/observability/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

export function logout(): Promise<ObservabilityResult<void>> {
  return observabilityFetch<void>('/api/observability/logout', { method: 'POST' });
}

export function fetchSummary(
  window: ObservabilityWindow = '24h',
): Promise<ObservabilityResult<ObservabilitySummary>> {
  return observabilityFetch<ObservabilitySummary>(`/api/observability/summary?window=${window}`);
}

export function fetchTraces(
  params: FetchTracesParams = {},
): Promise<ObservabilityResult<ObservabilityTraces>> {
  const search = new URLSearchParams();
  search.set('window', params.window ?? '24h');
  search.set('mode', params.mode ?? 'all');
  search.set('status', params.status ?? 'all');
  if (params.limit != null) {
    search.set('limit', String(params.limit));
  }
  if (params.cursor) {
    search.set('cursor', params.cursor);
  }
  return observabilityFetch<ObservabilityTraces>(`/api/observability/traces?${search.toString()}`);
}

export function fetchTrace(traceId: string): Promise<ObservabilityResult<ObservabilityTraceDetail>> {
  return observabilityFetch<ObservabilityTraceDetail>(
    `/api/observability/traces/${encodeURIComponent(traceId)}`,
  );
}
