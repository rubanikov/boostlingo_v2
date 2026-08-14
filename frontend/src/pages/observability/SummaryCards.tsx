import type { ObservabilitySummary } from './observabilityApi';
import { formatCompactTokens, formatCount, formatErrorRate, formatMs, formatUsd } from './formatTelemetry';

function Sparkline({ values, label }: { values: Array<number | null>; label: string }) {
  const points = values.filter((value): value is number => value != null);
  if (points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const width = 120;
  const height = 32;
  const d = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-12 w-full mt-2 text-primary"
      role="img"
      aria-label={label}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

interface SummaryCardsProps {
  summary: ObservabilitySummary;
}

export function SummaryCards({ summary }: SummaryCardsProps) {
  const latency = summary.latency;
  const errorRate = summary.errorRate;
  const cost = summary.cost;
  const sessions = summary.sessions;
  const errorRateValue = errorRate?.rate ?? null;
  const errorClass =
    errorRateValue == null
      ? ''
      : errorRateValue > 0
        ? 'text-error'
        : 'text-success';

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4">
          <h3 className="card-title text-sm text-base-content/70">Latency (p50 / p95)</h3>
          <div className="text-2xl font-bold">
            {formatMs(latency?.p50Ms ?? null)}{' '}
            <span className="text-lg font-normal text-base-content/50">
              / {formatMs(latency?.p95Ms ?? null)}
            </span>
          </div>
          <Sparkline
            values={(latency?.series ?? []).map((point) => point.p50Ms)}
            label="Latency p50 sparkline"
          />
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4">
          <h3 className="card-title text-sm text-base-content/70">Error Rate</h3>
          <div className={`text-2xl font-bold ${errorClass}`}>{formatErrorRate(errorRateValue)}</div>
          <Sparkline
            values={(errorRate?.series ?? []).map((point) => point.rate)}
            label="Error rate sparkline"
          />
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4">
          <h3 className="card-title text-sm text-base-content/70">Cost & Tokens</h3>
          <div className="text-2xl font-bold">{formatUsd(cost?.totalUsd ?? null)}</div>
          <div className="text-sm text-base-content/70">{formatCompactTokens(cost?.totalTokens ?? null)}</div>
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4">
          <h3 className="card-title text-sm text-base-content/70">Sessions</h3>
          <div className="flex justify-between items-end h-full">
            <div>
              <div className="text-xl font-bold text-info">
                {formatCount(sessions?.realtime ?? null)} Realtime
              </div>
              <div className="text-xl font-bold text-success">
                {formatCount(sessions?.cascade ?? null)} Cascade
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
