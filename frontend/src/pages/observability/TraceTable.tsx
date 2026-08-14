import { useNavigate } from 'react-router-dom';
import type { ObservabilityTraceRow, TraceModeFilter, TraceStatusFilter } from './observabilityApi';
import {
  formatMs,
  formatTokens,
  formatTraceId,
  formatUsd,
  formatLocalTime,
  isClientReportedMode,
} from './formatTelemetry';

interface TraceTableProps {
  traces: ObservabilityTraceRow[];
  page: number;
  hasMore: boolean;
  mode: TraceModeFilter;
  status: TraceStatusFilter;
  onModeChange: (mode: TraceModeFilter) => void;
  onStatusChange: (status: TraceStatusFilter) => void;
  onPrev: () => void;
  onNext: () => void;
}

export function TraceTable({
  traces,
  page,
  hasMore,
  mode,
  status,
  onModeChange,
  onStatusChange,
  onPrev,
  onNext,
}: TraceTableProps) {
  const navigate = useNavigate();

  function openTrace(traceId: string) {
    navigate(`/observability/traces/${traceId}`);
  }

  return (
    <div className="card bg-base-200 border border-base-300">
      <div className="card-body p-0">
        <div className="p-4 border-b border-base-300 flex justify-between items-center bg-base-200/50">
          <h2 className="card-title text-lg">Recent Traces</h2>
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="trace-mode-filter">
              Mode
            </label>
            <select
              id="trace-mode-filter"
              aria-label="Mode"
              className="select select-bordered select-sm"
              value={mode}
              onChange={(event) => onModeChange(event.target.value as TraceModeFilter)}
            >
              <option value="all">All Modes</option>
              <option value="realtime">Realtime</option>
              <option value="cascade">Cascade</option>
            </select>
            <label className="sr-only" htmlFor="trace-status-filter">
              Status
            </label>
            <select
              id="trace-status-filter"
              aria-label="Status"
              className="select select-bordered select-sm"
              value={status}
              onChange={(event) => onStatusChange(event.target.value as TraceStatusFilter)}
            >
              <option value="all">All Status</option>
              <option value="error">Errors Only</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="table table-zebra w-full">
            <thead>
              <tr>
                <th>Time</th>
                <th>Mode</th>
                <th>Trace ID</th>
                <th>Latency</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Status</th>
                <th>View</th>
              </tr>
            </thead>
            <tbody>
              {traces.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-base-content/70 py-8">
                    No traces in this window
                  </td>
                </tr>
              ) : (
                traces.map((trace) => (
                  <tr
                    key={trace.traceId}
                    className="hover cursor-pointer"
                    onClick={() => openTrace(trace.traceId)}
                  >
                    <td className="text-base-content/70">{formatLocalTime(trace.timestamp)}</td>
                    <td>
                      <div className="flex flex-col items-start gap-1">
                        <div
                          className={`badge badge-sm ${trace.mode === 'realtime' ? 'badge-info' : 'badge-success'}`}
                        >
                          {trace.mode === 'realtime' ? 'Realtime' : 'Cascade'}
                        </div>
                        {isClientReportedMode(trace.mode) ? (
                          <span className="text-xs text-base-content/50">client-reported</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="font-mono text-xs" title={trace.traceId}>
                      {formatTraceId(trace.traceId)}
                    </td>
                    <td>{formatMs(trace.latencyMs)}</td>
                    <td>{formatTokens(trace.totalTokens)}</td>
                    <td>{formatUsd(trace.costUsd)}</td>
                    <td>
                      <div
                        className={`badge badge-sm ${trace.status === 'error' ? 'badge-error' : 'badge-success'}`}
                      >
                        {trace.status === 'error' ? 'Error' : 'Success'}
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          openTrace(trace.traceId);
                        }}
                      >
                        View →
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-base-300 flex justify-center">
          <div className="join">
            <button
              type="button"
              className="join-item btn btn-sm"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={onPrev}
            >
              «
            </button>
            <button type="button" className="join-item btn btn-sm pointer-events-none">
              Page {page}
            </button>
            <button
              type="button"
              className="join-item btn btn-sm"
              aria-label="Next page"
              disabled={!hasMore}
              onClick={onNext}
            >
              »
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
