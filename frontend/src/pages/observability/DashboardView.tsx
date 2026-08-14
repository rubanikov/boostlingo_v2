import { useEffect, useState } from 'react';
import { SummaryCards } from './SummaryCards';
import { TraceTable } from './TraceTable';
import { LoadingState } from './ObservabilityStates';
import {
  fetchSummary,
  fetchTraces,
  type ObservabilityResult,
  type ObservabilitySummary,
  type ObservabilityTraces,
  type ObservabilityWindow,
  type TraceModeFilter,
  type TraceStatusFilter,
} from './observabilityApi';

interface DashboardViewProps {
  onLogout: () => void;
  onUnauthenticated: () => void;
  onDisabled: () => void;
  onUnavailable: () => void;
}

const EMPTY_TRACES: ObservabilityTraces = { traces: [], nextCursor: null, hasMore: false };

async function requestDashboard(
  timeWindow: ObservabilityWindow,
  mode: TraceModeFilter,
  status: TraceStatusFilter,
  cursor: string | null,
): Promise<[ObservabilityResult<ObservabilitySummary>, ObservabilityResult<ObservabilityTraces>]> {
  return Promise.all([
    fetchSummary(timeWindow),
    fetchTraces({
      window: timeWindow,
      mode,
      status,
      cursor,
    }),
  ]);
}

export function DashboardView({
  onLogout,
  onUnauthenticated,
  onDisabled,
  onUnavailable,
}: DashboardViewProps) {
  const [timeWindow, setTimeWindow] = useState<ObservabilityWindow>('24h');
  const [mode, setMode] = useState<TraceModeFilter>('all');
  const [status, setStatus] = useState<TraceStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null);
  const [traces, setTraces] = useState<ObservabilityTraces>(EMPTY_TRACES);

  function applyResults(
    summaryResult: ObservabilityResult<ObservabilitySummary>,
    tracesResult: ObservabilityResult<ObservabilityTraces>,
  ) {
    if (summaryResult.status !== 'ok') {
      if (summaryResult.status === 'unauthenticated') onUnauthenticated();
      else if (summaryResult.status === 'disabled') onDisabled();
      else onUnavailable();
      return;
    }
    if (tracesResult.status !== 'ok') {
      if (tracesResult.status === 'unauthenticated') onUnauthenticated();
      else if (tracesResult.status === 'disabled') onDisabled();
      else onUnavailable();
      return;
    }
    setSummary(summaryResult.data);
    setTraces(tracesResult.data);
  }

  async function load(cursor: string | null) {
    const [summaryResult, tracesResult] = await requestDashboard(timeWindow, mode, status, cursor);
    applyResults(summaryResult, tracesResult);
  }

  useEffect(() => {
    let cancelled = false;
    setPage(1);
    setCursors([null]);
    void requestDashboard(timeWindow, mode, status, null).then(([summaryResult, tracesResult]) => {
      if (cancelled) return;
      if (summaryResult.status !== 'ok') {
        if (summaryResult.status === 'unauthenticated') onUnauthenticated();
        else if (summaryResult.status === 'disabled') onDisabled();
        else onUnavailable();
        return;
      }
      if (tracesResult.status !== 'ok') {
        if (tracesResult.status === 'unauthenticated') onUnauthenticated();
        else if (tracesResult.status === 'disabled') onDisabled();
        else onUnavailable();
        return;
      }
      setSummary(summaryResult.data);
      setTraces(tracesResult.data);
    });
    return () => {
      cancelled = true;
    };
  }, [timeWindow, mode, status, onUnauthenticated, onDisabled, onUnavailable]);

  function handleRefresh() {
    void load(cursors[page - 1] ?? null);
  }

  function handleNext() {
    if (!traces.hasMore || traces.nextCursor == null) return;
    const nextCursor = traces.nextCursor;
    setCursors((stack) => [...stack.slice(0, page), nextCursor]);
    setPage((current) => current + 1);
    void load(nextCursor);
  }

  function handlePrev() {
    if (page <= 1) return;
    const previousPage = page - 1;
    setPage(previousPage);
    void load(cursors[previousPage - 1] ?? null);
  }

  if (summary == null) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Observability Dashboard</h1>
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="observability-window">
            Time window
          </label>
          <select
            id="observability-window"
            aria-label="Time window"
            className="select select-bordered select-sm"
            value={timeWindow}
            onChange={(event) => setTimeWindow(event.target.value as ObservabilityWindow)}
          >
            <option value="1h">Last 1 Hour</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
          </select>
          <button type="button" className="btn btn-sm btn-outline" onClick={handleRefresh}>
            Refresh
          </button>
          <button type="button" className="btn btn-sm btn-outline btn-error" onClick={onLogout}>
            Logout
          </button>
        </div>
      </div>

      <SummaryCards summary={summary} />
      <TraceTable
        traces={traces.traces}
        page={page}
        hasMore={traces.hasMore}
        mode={mode}
        status={status}
        onModeChange={setMode}
        onStatusChange={setStatus}
        onPrev={handlePrev}
        onNext={handleNext}
      />
    </div>
  );
}
