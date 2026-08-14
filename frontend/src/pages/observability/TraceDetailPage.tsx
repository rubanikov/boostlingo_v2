import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LoginCard } from './LoginCard';
import {
  DisabledState,
  LoadingState,
  TraceNotFoundState,
  UnreachableState,
} from './ObservabilityStates';
import {
  fetchConfig,
  fetchTrace,
  logout,
  type ObservabilitySpan,
  type ObservabilityTraceDetail,
} from './observabilityApi';
import {
  formatCount,
  formatLocalDateTime,
  formatMs,
  formatTokens,
  formatUsd,
  isClientReportedMode,
} from './formatTelemetry';

type DetailView =
  | 'loading'
  | 'disabled'
  | 'login'
  | 'unavailable'
  | 'not-found'
  | 'ready';

type SpanTab = 'prompt' | 'completion' | 'metadata';

function waterfallTotalMs(detail: ObservabilityTraceDetail): number {
  const fromSpans = detail.spans.reduce(
    (max, span) => Math.max(max, span.startOffsetMs + span.durationMs),
    0,
  );
  return Math.max(detail.totalLatencyMs ?? 0, fromSpans, 1);
}

function spanBarClass(name: string): string {
  if (name.includes('turn') || name.startsWith('tts')) return 'bg-info';
  if (name.startsWith('stt')) return 'bg-accent';
  if (name.includes('segment') || name.includes('translate')) return 'bg-secondary';
  return 'bg-primary';
}

function Waterfall({
  spans,
  totalMs,
  selectedSpanId,
  onSelect,
}: {
  spans: ObservabilitySpan[];
  totalMs: number;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
}) {
  const midLabel = formatMs(Math.round(totalMs / 2));
  const endLabel = formatMs(Math.round(totalMs));

  return (
    <div className="space-y-3 font-mono text-sm">
      <div className="flex border-b border-base-300 pb-2 text-base-content/50">
        <div className="w-1/3">Span Name</div>
        <div className="w-2/3 relative">
          <div className="absolute left-0">0ms</div>
          <div className="absolute left-1/2 -translate-x-1/2">{midLabel}</div>
          <div className="absolute right-0">{endLabel}</div>
        </div>
      </div>
      {spans.map((span) => {
        const leftPct = (span.startOffsetMs / totalMs) * 100;
        const widthPct = Math.max((span.durationMs / totalMs) * 100, 0.8);
        const selected = span.spanId === selectedSpanId;
        return (
          <button
            type="button"
            key={span.spanId}
            className={`flex items-center w-full text-left p-1 rounded hover:bg-base-300 ${selected ? 'bg-base-300/50' : ''}`}
            onClick={() => onSelect(span.spanId)}
          >
            <div
              className="w-1/3 truncate pr-2"
              style={{ paddingLeft: `${span.depth * 1}rem` }}
              title={span.name}
            >
              {span.depth > 0 ? `↳ ${span.name}` : span.name}
            </div>
            <div className="w-2/3 relative h-6">
              <div
                className={`h-6 rounded-sm absolute ${spanBarClass(span.name)}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function SpanDetailCard({ span }: { span: ObservabilitySpan }) {
  const [tab, setTab] = useState<SpanTab>('prompt');
  const tabClass = (id: SpanTab) => `tab ${tab === id ? 'tab-active' : ''}`;

  let body = '—';
  if (tab === 'prompt') body = span.input ?? '—';
  if (tab === 'completion') body = span.output ?? '—';
  if (tab === 'metadata') body = JSON.stringify(span.metadata, null, 2);

  return (
    <div className="card bg-base-200 border border-base-300">
      <div className="card-body p-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="card-title text-lg">Span: {span.name}</h2>
          <div className="text-sm text-base-content/70">Duration: {formatMs(span.durationMs)}</div>
        </div>

        <div role="tablist" className="tabs tabs-box mb-4">
          <button type="button" role="tab" className={tabClass('prompt')} onClick={() => setTab('prompt')}>
            Prompt
          </button>
          <button
            type="button"
            role="tab"
            className={tabClass('completion')}
            onClick={() => setTab('completion')}
          >
            Completion
          </button>
          <button
            type="button"
            role="tab"
            className={tabClass('metadata')}
            onClick={() => setTab('metadata')}
          >
            Metadata
          </button>
        </div>

        <div className="bg-base-300 p-4 rounded-lg font-mono text-sm overflow-auto max-h-64 whitespace-pre-wrap">
          {body}
        </div>
        {span.truncated ? (
          <div className="text-xs text-base-content/50 mt-2 italic">
            Note: Oversized span text is truncated to preserve UI performance.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TraceSidebar({ detail }: { detail: ObservabilityTraceDetail }) {
  return (
    <div className="card bg-base-200 border border-base-300">
      <div className="card-body p-4">
        <h2 className="card-title text-lg mb-4">Trace Details</h2>
        <dl className="space-y-4 text-sm">
          <div>
            <dt className="text-base-content/70">Timestamp</dt>
            <dd className="font-medium">{formatLocalDateTime(detail.timestamp)}</dd>
          </div>
          <div>
            <dt className="text-base-content/70">Total Latency</dt>
            <dd className="font-medium">{formatMs(detail.totalLatencyMs)}</dd>
            {isClientReportedMode(detail.mode) ? (
              <dd className="text-xs text-base-content/50 mt-1">client-reported</dd>
            ) : null}
          </div>
          <div className="divider my-1" />
          <div>
            <dt className="text-base-content/70">Total Tokens</dt>
            <dd className="font-medium">{formatTokens(detail.totalTokens)}</dd>
            <dd className="text-xs text-base-content/50 mt-1">
              Prompt: {formatCount(detail.inputTokens)} | Completion: {formatCount(detail.outputTokens)}
            </dd>
          </div>
          <div>
            <dt className="text-base-content/70">Estimated Cost</dt>
            <dd className="font-medium">{formatUsd(detail.costUsd)}</dd>
          </div>
          <div className="divider my-1" />
          <div>
            <dt className="text-base-content/70">Model</dt>
            <dd className="font-medium">{detail.model ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-base-content/70">Session ID</dt>
            <dd className="font-mono text-xs">{detail.sessionId ?? '—'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

const TRACE_ID_PATTERN = /^[0-9a-f]{16,64}$/;

export function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<DetailView>('loading');
  const [detail, setDetail] = useState<ObservabilityTraceDetail | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setView('loading');
      if (!TRACE_ID_PATTERN.test(traceId)) {
        if (!cancelled) setView('not-found');
        return;
      }

      const config = await fetchConfig();
      if (cancelled) return;
      if (config.status === 'unavailable') {
        setView('unavailable');
        return;
      }
      if (config.status !== 'ok' || !config.data.enabled) {
        setView('disabled');
        return;
      }
      if (!config.data.authenticated) {
        setView('login');
        return;
      }

      const result = await fetchTrace(traceId);
      if (cancelled) return;
      if (result.status === 'unauthenticated') {
        setView('login');
        return;
      }
      if (result.status === 'disabled') {
        // Cookie-gated 404 here means the trace is missing, not that the feature is off:
        // config already reported enabled.
        setView('not-found');
        return;
      }
      if (result.status === 'unavailable') {
        setView('unavailable');
        return;
      }

      setDetail(result.data);
      setSelectedSpanId(result.data.spans[0]?.spanId ?? null);
      setView('ready');
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [traceId, reloadNonce]);

  async function handleLogout() {
    await logout();
    navigate('/observability');
  }

  function reload() {
    setReloadNonce((value) => value + 1);
  }

  if (view === 'loading') return <LoadingState />;
  if (view === 'disabled') return <DisabledState />;
  if (view === 'login') {
    return <LoginCard onLoggedIn={reload} onDisabled={() => setView('disabled')} />;
  }
  if (view === 'unavailable') {
    return <UnreachableState onRetry={reload} onLogout={() => void handleLogout()} />;
  }
  if (view === 'not-found') {
    return <TraceNotFoundState onBack={() => navigate('/observability')} />;
  }
  if (detail == null) return <LoadingState />;

  const selected = detail.spans.find((span) => span.spanId === selectedSpanId) ?? detail.spans[0];
  const totalMs = waterfallTotalMs(detail);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/observability" className="btn btn-sm btn-ghost">
          ← Back to Dashboard
        </Link>
        <div className="divider divider-horizontal mx-0" />
        <h1 className="text-xl font-bold font-mono">Trace: {traceId}</h1>
        <div className={`badge ${detail.mode === 'realtime' ? 'badge-info' : 'badge-success'}`}>
          {detail.mode === 'realtime' ? 'Realtime' : 'Cascade'}
        </div>
        <div className={`badge ${detail.status === 'error' ? 'badge-error' : 'badge-success'}`}>
          {detail.status === 'error' ? 'Error' : 'Success'}
        </div>
        {isClientReportedMode(detail.mode) ? (
          <span className="text-xs text-base-content/50">client-reported</span>
        ) : null}
        <div className="flex-1" />
        <button type="button" className="btn btn-sm btn-outline btn-error" onClick={() => void handleLogout()}>
          Logout
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card bg-base-200 border border-base-300">
            <div className="card-body p-4">
              <h2 className="card-title text-lg mb-4">Span Waterfall</h2>
              {detail.spans.length === 0 ? (
                <p className="text-base-content/70">No spans on this trace.</p>
              ) : (
                <Waterfall
                  spans={detail.spans}
                  totalMs={totalMs}
                  selectedSpanId={selected?.spanId ?? null}
                  onSelect={setSelectedSpanId}
                />
              )}
            </div>
          </div>
          {selected ? <SpanDetailCard key={selected.spanId} span={selected} /> : null}
        </div>
        <div className="space-y-6">
          <TraceSidebar detail={detail} />
        </div>
      </div>
    </div>
  );
}
