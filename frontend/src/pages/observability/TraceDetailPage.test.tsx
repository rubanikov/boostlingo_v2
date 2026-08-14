import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceDetailPage } from './TraceDetailPage';
import type { ObservabilitySpan, ObservabilityTraceDetail } from './observabilityApi';

function jsonResponse(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pathnameOf(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw, 'http://localhost').pathname;
}

function span(overrides: Partial<ObservabilitySpan> & Pick<ObservabilitySpan, 'spanId' | 'name' | 'depth'>): ObservabilitySpan {
  return {
    parentSpanId: null,
    startOffsetMs: 0,
    durationMs: 100,
    status: 'success',
    input: null,
    output: null,
    truncated: false,
    metadata: {},
    ...overrides,
  };
}

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

function cascadeDetail(spans: ObservabilitySpan[]): ObservabilityTraceDetail {
  return {
    traceId: TRACE_ID,
    mode: 'cascade',
    status: 'error',
    timestamp: '2026-08-13T15:42:15Z',
    totalLatencyMs: 1200,
    totalTokens: 4250,
    inputTokens: 3800,
    outputTokens: 450,
    costUsd: 0.042,
    model: 'gpt-4o-mini',
    sessionId: '9f2c',
    spans,
  };
}

function renderDetail(traceId = TRACE_ID) {
  const router = createMemoryRouter(
    [
      { path: '/observability', element: <div>dashboard</div> },
      { path: '/observability/traces/:traceId', element: <TraceDetailPage /> },
    ],
    { initialEntries: [`/observability/traces/${traceId}`] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TraceDetailPage', () => {
  it('renders waterfall rows in array order without rebuilding a tree', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = pathnameOf(input);
      if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
      if (path.endsWith(`/traces/${TRACE_ID}`)) {
        return jsonResponse(
          200,
          cascadeDetail([
            span({
              spanId: 'child',
              parentSpanId: 'root',
              name: 'llm.translate',
              depth: 2,
              startOffsetMs: 60,
              durationMs: 960,
              input: 'Where is the station?',
              output: '¿Dónde está la estación?',
            }),
            span({
              spanId: 'root',
              parentSpanId: null,
              name: 'cascade.session',
              depth: 0,
              startOffsetMs: 0,
              durationMs: 1200,
            }),
          ]),
        );
      }
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderDetail();

    expect(await screen.findByRole('heading', { name: /span waterfall/i })).toBeInTheDocument();
    const names = screen.getAllByTitle(/cascade\.session|llm\.translate/).map((el) => el.getAttribute('title'));
    expect(names).toEqual(['llm.translate', 'cascade.session']);
    expect(screen.queryByText(/tool_call/i)).not.toBeInTheDocument();
  });

  it('renders a one-span trace as a one-row waterfall', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        if (path.endsWith(`/traces/${TRACE_ID}`)) {
          return jsonResponse(
            200,
            cascadeDetail([
              span({ spanId: 'only', name: 'realtime.session', depth: 0, durationMs: 50 }),
            ]),
          );
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderDetail();
    await screen.findByRole('heading', { name: /span waterfall/i });
    expect(screen.getByTitle('realtime.session')).toBeInTheDocument();
    expect(screen.getAllByTitle(/session|turn|stt|llm|tts/).length).toBe(1);
  });

  it('shows the truncation note only when the selected span is truncated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        if (path.endsWith(`/traces/${TRACE_ID}`)) {
          return jsonResponse(
            200,
            cascadeDetail([
              span({
                spanId: 'a',
                name: 'cascade.session',
                depth: 0,
                truncated: false,
              }),
              span({
                spanId: 'b',
                name: 'stt.deepgram',
                depth: 1,
                truncated: true,
                input: 'cut off…',
              }),
            ]),
          );
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    const user = userEvent.setup();

    renderDetail();
    await screen.findByTitle('cascade.session');
    expect(screen.queryByText(/oversized span text is truncated/i)).not.toBeInTheDocument();

    await user.click(screen.getByTitle('stt.deepgram'));
    expect(screen.getByText(/oversized span text is truncated/i)).toBeInTheDocument();
  });

  it('attributes realtime traces as client-reported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        if (path.endsWith(`/traces/${TRACE_ID}`)) {
          return jsonResponse(200, {
            ...cascadeDetail([
              span({ spanId: 's', name: 'realtime.session', depth: 0 }),
              span({ spanId: 't', name: 'realtime.turn', depth: 1, parentSpanId: 's' }),
            ]),
            mode: 'realtime',
            status: 'success',
          });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );

    renderDetail();
    expect((await screen.findAllByText('client-reported')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTitle('realtime.session')).toBeInTheDocument();
    expect(screen.getByTitle('realtime.turn')).toBeInTheDocument();
  });

  it('goes back to the dashboard without opening a new tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        if (path.endsWith(`/traces/${TRACE_ID}`)) {
          return jsonResponse(200, cascadeDetail([span({ spanId: 's', name: 'cascade.session', depth: 0 })]));
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    const user = userEvent.setup();
    const { router } = renderDetail();

    await user.click(await screen.findByRole('link', { name: /back to dashboard/i }));
    expect(router.state.location.pathname).toBe('/observability');
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('shows trace-not-found for a well-formed unknown id when the feature is enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        return jsonResponse(404, { detail: 'Trace not found.' });
      }),
    );

    renderDetail();
    expect(await screen.findByRole('heading', { name: /trace not found/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /observability disabled/i })).not.toBeInTheDocument();
  });

  it('prompts for login when the detail request is 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = pathnameOf(input);
        if (path.endsWith('/config')) return jsonResponse(200, { enabled: true, authenticated: true });
        return jsonResponse(401, { detail: 'Unauthorized' });
      }),
    );

    renderDetail();
    expect(await screen.findByRole('heading', { name: /observability access/i })).toBeInTheDocument();
  });
});
