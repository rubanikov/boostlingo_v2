import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { createAppRoutes } from '../appRoutes';

function jsonResponse(status: number, body?: unknown): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pathnameOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, 'http://localhost').pathname;
}

function renderObservability() {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/observability'] });
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ObservabilityPage', () => {
  it('shows the disabled state when config reports enabled: false, with no login form and no further fetches', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { enabled: false, authenticated: false }));
    vi.stubGlobal('fetch', fetchMock);

    renderObservability();

    expect(await screen.findByRole('heading', { name: /observability disabled/i })).toBeInTheDocument();
    expect(screen.getByText(/OBSERVABILITY_UI_TOKEN/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/operator token/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /access dashboard/i })).not.toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/config$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('shows the login card when enabled and unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { enabled: true, authenticated: false })));

    renderObservability();

    expect(await screen.findByRole('heading', { name: /observability access/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/operator token/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /access dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('Signed in until you log out or close the browser.')).toBeInTheDocument();
    expect(screen.queryByText(/session valid for 2 hours/i)).not.toBeInTheDocument();
  });

  it('keeps the form, shows an inline error, and clears the field on a wrong token', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: false });
      if (path.endsWith('/login')) return jsonResponse(401, { detail: 'Invalid operator token.' });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderObservability();
    const field = await screen.findByLabelText(/operator token/i);
    await user.type(field, 'not-the-token');
    await user.click(screen.getByRole('button', { name: /access dashboard/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid operator token/i);
    expect(screen.getByLabelText(/operator token/i)).toHaveValue('');
    expect(screen.getByRole('heading', { name: /observability access/i })).toBeInTheDocument();
    expect(screen.queryByText(/telemetry backend unreachable/i)).not.toBeInTheDocument();
  });

  it('shows a loading spinner, then the unreachable state after a successful login when summary/traces are 503', async () => {
    let resolveSummary: ((value: Response) => void) | undefined;
    const summaryGate = new Promise<Response>((resolve) => {
      resolveSummary = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: false });
      if (path.endsWith('/login')) return jsonResponse(204);
      if (path.includes('/summary') || path.includes('/traces')) return summaryGate;
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderObservability();
    await user.type(await screen.findByLabelText(/operator token/i), 'correct-token');
    await user.click(screen.getByRole('button', { name: /access dashboard/i }));

    expect(await screen.findByText(/loading telemetry data/i)).toBeInTheDocument();
    expect(document.querySelector('.loading-spinner')).not.toBeNull();

    resolveSummary?.(jsonResponse(503, { detail: 'Langfuse keys unset' }));

    expect(await screen.findByRole('heading', { name: /telemetry backend unreachable/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
    expect(screen.queryByText(/latency \(p50/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/recent traces/i)).not.toBeInTheDocument();
  });

  it('drops back to the login card when a later data call returns 401', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.includes('/summary') || path.includes('/traces')) {
        return jsonResponse(401, { detail: 'Unauthorized' });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderObservability();

    expect(await screen.findByRole('heading', { name: /observability access/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /session expired/i })).not.toBeInTheDocument();
  });

  it('retries summary and traces from the unreachable state', async () => {
    let dataStatus = 503;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.includes('/summary') || path.includes('/traces')) {
        return jsonResponse(dataStatus, dataStatus === 503 ? { detail: 'down' } : {
          window: '24h',
          from: '2026-08-12T18:00:00Z',
          to: '2026-08-13T18:00:00Z',
          latency: { p50Ms: null, p95Ms: null, series: [] },
          errorRate: { rate: null, errorCount: null, totalCount: null, series: [] },
          cost: { totalUsd: null, totalTokens: null, inputTokens: null, outputTokens: null },
          sessions: { realtime: null, cascade: null },
          traces: [],
          nextCursor: null,
          hasMore: false,
        });
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderObservability();
    expect(await screen.findByRole('heading', { name: /telemetry backend unreachable/i })).toBeInTheDocument();

    dataStatus = 200;
    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /telemetry backend unreachable/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: /observability dashboard/i })).toBeInTheDocument();
    expect(screen.queryByText(/telemetry backend unreachable/i)).not.toBeInTheDocument();
  });

  it('logs out and returns to the login card', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.includes('/summary') || path.includes('/traces')) {
        return jsonResponse(503, { detail: 'down' });
      }
      if (path.endsWith('/logout') && init?.method === 'POST') return jsonResponse(204);
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderObservability();
    await user.click(await screen.findByRole('button', { name: /logout/i }));

    expect(await screen.findByRole('heading', { name: /observability access/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/logout$/),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('does not render workbench latency badges or the latency strip on /observability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { enabled: true, authenticated: false })));

    renderObservability();
    await screen.findByRole('heading', { name: /observability access/i });

    expect(screen.queryByTestId('cascade-latency-strip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('realtime-latency-badge')).not.toBeInTheDocument();
    expect(screen.queryByText(/cascade:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/realtime:/i)).not.toBeInTheDocument();
  });

  it('renders Workbench | Observability tabs and no 2-hour session copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { enabled: true, authenticated: false })));

    renderObservability();
    await screen.findByRole('heading', { name: /observability access/i });

    const tablist = screen.getByRole('tablist', { name: /primary/i });
    expect(within(tablist).getByRole('tab', { name: 'Workbench' })).toBeInTheDocument();
    expect(within(tablist).getByRole('tab', { name: 'Observability' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows dashes and No traces when Langfuse is healthy but empty, not the unreachable state', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.includes('/summary')) return jsonResponse(200, EMPTY_SUMMARY);
      if (path.endsWith('/traces')) return jsonResponse(200, EMPTY_TRACES);
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderObservability();

    expect(await screen.findByRole('heading', { name: /observability dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('No traces in this window')).toBeInTheDocument();
    expect(screen.getByText('Latency (p50 / p95)')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByRole('heading', { name: /telemetry backend unreachable/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByTestId('cascade-latency-strip')).not.toBeInTheDocument();
  });

  it('after login shows populated cards and opens a trace in the same tab', async () => {
    let authenticated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated });
      if (path.endsWith('/login')) {
        authenticated = true;
        return jsonResponse(204);
      }
      if (path.includes('/summary')) return jsonResponse(200, POPULATED_SUMMARY);
      if (path.endsWith(`/traces/${TRACE_ID}`)) return jsonResponse(200, TRACE_DETAIL);
      if (path.endsWith('/traces')) return jsonResponse(200, { traces: [TRACE_ROW], nextCursor: null, hasMore: false });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    const router = createMemoryRouter(createAppRoutes(), { initialEntries: ['/observability'] });
    render(<RouterProvider router={router} />);

    await user.type(await screen.findByLabelText(/operator token/i), 'correct-token');
    await user.click(screen.getByRole('button', { name: /access dashboard/i }));

    expect(await screen.findByRole('heading', { name: /observability dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('145ms')).toBeInTheDocument();
    expect(screen.getByText('Recent Traces')).toBeInTheDocument();
    expect(screen.getByText('client-reported')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /view/i }));

    expect(router.state.location.pathname).toBe(`/observability/traces/${TRACE_ID}`);
    expect(await screen.findByRole('heading', { name: /span waterfall/i })).toBeInTheDocument();
    expect(screen.getByTitle('realtime.session')).toBeInTheDocument();
    expect(screen.getByTitle('realtime.turn')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: /back to dashboard/i }));
    expect(router.state.location.pathname).toBe('/observability');
    expect(await screen.findByRole('heading', { name: /observability dashboard/i })).toBeInTheDocument();
  });

  it('sends the selected window on Refresh and does not poll', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.includes('/summary')) return jsonResponse(200, EMPTY_SUMMARY);
      if (path.endsWith('/traces')) return jsonResponse(200, EMPTY_TRACES);
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderObservability();
    await screen.findByRole('heading', { name: /observability dashboard/i });

    const callsAfterLoad = fetchMock.mock.calls.length;
    await user.selectOptions(screen.getByLabelText(/time window/i), '1h');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/observability\/summary\?window=1h$/),
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => {
      const summary1hCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/summary?window=1h'),
      );
      expect(summary1hCalls.length).toBeGreaterThanOrEqual(2);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterLoad);
  });
});

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

const EMPTY_SUMMARY = {
  window: '24h',
  from: '2026-08-12T18:00:00Z',
  to: '2026-08-13T18:00:00Z',
  latency: { p50Ms: null, p95Ms: null, series: [] },
  errorRate: { rate: null, errorCount: null, totalCount: null, series: [] },
  cost: { totalUsd: null, totalTokens: null, inputTokens: null, outputTokens: null },
  sessions: { realtime: null, cascade: null },
};

const POPULATED_SUMMARY = {
  ...EMPTY_SUMMARY,
  latency: { p50Ms: 145, p95Ms: 320, series: [] },
  errorRate: { rate: 0.002, errorCount: 3, totalCount: 1500, series: [] },
  cost: { totalUsd: 1.42, totalTokens: 142000, inputTokens: 120000, outputTokens: 22000 },
  sessions: { realtime: 42, cascade: 18 },
};

const EMPTY_TRACES = { traces: [], nextCursor: null, hasMore: false };

const TRACE_ROW = {
  traceId: TRACE_ID,
  timestamp: '2026-08-13T15:42:15Z',
  mode: 'realtime' as const,
  latencyMs: 1200,
  totalTokens: 4250,
  costUsd: 0.04,
  status: 'success' as const,
};

const TRACE_DETAIL = {
  traceId: TRACE_ID,
  mode: 'realtime',
  status: 'success',
  timestamp: '2026-08-13T15:42:15Z',
  totalLatencyMs: 1200,
  totalTokens: 4250,
  inputTokens: 3800,
  outputTokens: 450,
  costUsd: 0.04,
  model: 'gpt-realtime',
  sessionId: '9f2c',
  spans: [
    {
      spanId: 'root',
      parentSpanId: null,
      name: 'realtime.session',
      startOffsetMs: 0,
      durationMs: 1200,
      status: 'success',
      depth: 0,
      input: null,
      output: null,
      truncated: false,
      metadata: { mode: 'realtime' },
    },
    {
      spanId: 'turn',
      parentSpanId: 'root',
      name: 'realtime.turn',
      startOffsetMs: 0,
      durationMs: 1200,
      status: 'success',
      depth: 1,
      input: 'Where is the station?',
      output: '¿Dónde está la estación?',
      truncated: false,
      metadata: {},
    },
  ],
};
