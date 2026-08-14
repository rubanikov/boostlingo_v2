import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { TraceTable } from './TraceTable';
import type { ObservabilityTraceRow } from './observabilityApi';

const CASCADE_ROW: ObservabilityTraceRow = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  timestamp: '2026-08-13T15:42:15Z',
  mode: 'cascade',
  latencyMs: 850,
  totalTokens: 1120,
  costUsd: 0.01,
  status: 'success',
};

const REALTIME_ROW: ObservabilityTraceRow = {
  traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  timestamp: '2026-08-13T15:40:05Z',
  mode: 'realtime',
  latencyMs: 1200,
  totalTokens: 4250,
  costUsd: 0.04,
  status: 'error',
};

function renderTable(
  traces: ObservabilityTraceRow[],
  extras?: Partial<Parameters<typeof TraceTable>[0]>,
) {
  const router = createMemoryRouter(
    [
      { path: '/observability', element: <TraceTable traces={traces} page={1} hasMore={false} mode="all" status="all" onModeChange={() => {}} onStatusChange={() => {}} onPrev={() => {}} onNext={() => {}} {...extras} /> },
      { path: '/observability/traces/:traceId', element: <div>trace detail</div> },
    ],
    { initialEntries: ['/observability'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('TraceTable', () => {
  it('shows an empty-window row, not the unreachable state', () => {
    renderTable([]);

    expect(screen.getByText('No traces in this window')).toBeInTheDocument();
    expect(screen.queryByText(/telemetry backend unreachable/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next page/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /page 1/i })).toBeInTheDocument();
  });

  it('labels realtime rows as client-reported and cascade rows without that attribution', () => {
    renderTable([REALTIME_ROW, CASCADE_ROW]);

    const realtimeBadge = screen.getByText('Realtime', { selector: '.badge' });
    expect(realtimeBadge.closest('td')).toHaveTextContent('client-reported');
    const cascadeBadge = screen.getByText('Cascade', { selector: '.badge' });
    expect(cascadeBadge.closest('td')).not.toHaveTextContent('client-reported');
  });

  it('renders null latency/tokens/cost as dashes', () => {
    renderTable([
      {
        ...CASCADE_ROW,
        latencyMs: null,
        totalTokens: null,
        costUsd: null,
      },
    ]);

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('navigates in-place to the trace detail route when a row is clicked', async () => {
    const { router } = renderTable([CASCADE_ROW]);
    const user = userEvent.setup();

    await user.click(screen.getByText('View →'));

    expect(router.state.location.pathname).toBe(
      '/observability/traces/0af7651916cd43dd8448eb211c80319c',
    );
    expect(screen.getByText('trace detail')).toBeInTheDocument();
  });

  it('uses cursor Prev/Next and a client-side page label, not jump-to-page', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    renderTable([CASCADE_ROW], { page: 2, hasMore: true, onNext, onPrev });
    const user = userEvent.setup();

    expect(screen.getByRole('button', { name: /page 2/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^2$/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await user.click(screen.getByRole('button', { name: /previous page/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });
});
