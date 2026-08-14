const EM_DASH = '—';

export function formatMs(ms: number | null): string {
  if (ms == null) return EM_DASH;
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

export function formatUsd(usd: number | null): string {
  if (usd == null) return EM_DASH;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(count: number | null): string {
  if (count == null) return EM_DASH;
  return count.toLocaleString();
}

export function formatTokens(count: number | null): string {
  return formatCount(count);
}

export function formatCompactTokens(count: number | null): string {
  if (count == null) return EM_DASH;
  if (count >= 1000) {
    const thousands = count / 1000;
    const label = Number.isInteger(thousands) ? `${thousands}` : thousands.toFixed(1);
    return `${label}k tokens`;
  }
  return `${count.toLocaleString()} tokens`;
}

export function formatErrorRate(rate: number | null): string {
  if (rate == null) return EM_DASH;
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatTraceId(traceId: string): string {
  return traceId.length > 12 ? `${traceId.slice(0, 12)}…` : traceId;
}

export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatLocalDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function isClientReportedMode(mode: 'cascade' | 'realtime'): boolean {
  return mode === 'realtime';
}
