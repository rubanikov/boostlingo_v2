import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SummaryCards } from './SummaryCards';
import type { ObservabilitySummary } from './observabilityApi';

const EMPTY_SUMMARY: ObservabilitySummary = {
  window: '24h',
  from: '2026-08-12T18:00:00Z',
  to: '2026-08-13T18:00:00Z',
  latency: { p50Ms: null, p95Ms: null, series: [] },
  errorRate: { rate: null, errorCount: null, totalCount: null, series: [] },
  cost: { totalUsd: null, totalTokens: null, inputTokens: null, outputTokens: null },
  sessions: { realtime: null, cascade: null },
};

const POPULATED_SUMMARY: ObservabilitySummary = {
  window: '24h',
  from: '2026-08-12T18:00:00Z',
  to: '2026-08-13T18:00:00Z',
  latency: {
    p50Ms: 145,
    p95Ms: 320,
    series: [{ t: '2026-08-13T17:00:00Z', p50Ms: 140, p95Ms: 310 }],
  },
  errorRate: {
    rate: 0.002,
    errorCount: 3,
    totalCount: 1500,
    series: [{ t: '2026-08-13T17:00:00Z', rate: 0.001 }],
  },
  cost: { totalUsd: 1.42, totalTokens: 142000, inputTokens: 120000, outputTokens: 22000 },
  sessions: { realtime: 42, cascade: 18 },
};

describe('SummaryCards', () => {
  it('renders em dashes for a healthy empty summary, not zeros', () => {
    render(<SummaryCards summary={EMPTY_SUMMARY} />);

    expect(screen.getByText('Latency (p50 / p95)')).toBeInTheDocument();
    expect(screen.getByText('Error Rate')).toBeInTheDocument();
    expect(screen.getByText('Cost & Tokens')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0ms')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.queryByText('Telemetry Backend Unreachable')).not.toBeInTheDocument();
  });

  it('renders the four populated cards from the brief example', () => {
    render(<SummaryCards summary={POPULATED_SUMMARY} />);

    expect(screen.getByText('145ms')).toBeInTheDocument();
    expect(screen.getByText('/ 320ms')).toBeInTheDocument();
    expect(screen.getByText('0.2%')).toBeInTheDocument();
    expect(screen.getByText('$1.42')).toBeInTheDocument();
    expect(screen.getByText('142k tokens')).toBeInTheDocument();
    expect(screen.getByText(/42 Realtime/)).toBeInTheDocument();
    expect(screen.getByText(/18 Cascade/)).toBeInTheDocument();
  });
});
