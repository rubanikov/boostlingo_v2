import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConfig,
  fetchSummary,
  fetchTrace,
  fetchTraces,
  login,
  logout,
} from './observabilityApi';

function jsonResponse(status: number, body?: unknown): Response {
  if (body === undefined) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('observabilityApi status mapping', () => {
  it('maps a 200 config response to ok and always sends credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { enabled: true, authenticated: false }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchConfig()).resolves.toEqual({
      status: 'ok',
      data: { enabled: true, authenticated: false },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/config$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('maps login 204 to ok and posts {token} with credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await expect(login('operator-secret')).resolves.toEqual({ status: 'ok', data: undefined });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/login$/),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ token: 'operator-secret' }),
      }),
    );
  });

  it('maps login 401 to unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { detail: 'Invalid operator token.' })));
    await expect(login('wrong')).resolves.toEqual({ status: 'unauthenticated' });
  });

  it('maps login 404 to disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { detail: 'Observability is not enabled on this server.' })),
    );
    await expect(login('any')).resolves.toEqual({ status: 'disabled' });
  });

  it('maps logout 204 to ok', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(204));
    vi.stubGlobal('fetch', fetchMock);

    await expect(logout()).resolves.toEqual({ status: 'ok', data: undefined });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/logout$/),
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
  });

  it('maps summary 200 to ok', async () => {
    const body = {
      window: '24h',
      from: '2026-08-12T18:00:00Z',
      to: '2026-08-13T18:00:00Z',
      latency: { p50Ms: null, p95Ms: null, series: [] },
      errorRate: { rate: null, errorCount: null, totalCount: null, series: [] },
      cost: { totalUsd: null, totalTokens: null, inputTokens: null, outputTokens: null },
      sessions: { realtime: null, cascade: null },
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, body)));
    await expect(fetchSummary()).resolves.toEqual({ status: 'ok', data: body });
  });

  it('maps traces 401 to unauthenticated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { detail: 'Unauthorized' })));
    await expect(fetchTraces()).resolves.toEqual({ status: 'unauthenticated' });
  });

  it('maps summary 404 to disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { detail: 'Observability is not enabled on this server.' })),
    );
    await expect(fetchSummary()).resolves.toEqual({ status: 'disabled' });
  });

  it('maps 502 and 503 to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, { detail: 'bad gateway' })));
    await expect(fetchSummary()).resolves.toEqual({ status: 'unavailable' });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { detail: 'Langfuse keys unset' })));
    await expect(fetchTraces()).resolves.toEqual({ status: 'unavailable' });
  });

  it('maps a network failure to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(fetchConfig()).resolves.toEqual({ status: 'unavailable' });
  });

  it('sends window, mode, status, and cursor on the traces query string', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { traces: [], nextCursor: null, hasMore: false }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchTraces({ window: '1h', mode: 'cascade', status: 'error', cursor: 'abc123' });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/api\/observability\/traces\?window=1h&mode=cascade&status=error&cursor=abc123$/,
      ),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('fetches a single trace by id with credentials', async () => {
    const body = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      mode: 'cascade',
      status: 'success',
      timestamp: '2026-08-13T15:42:15Z',
      totalLatencyMs: 1200,
      totalTokens: 4250,
      inputTokens: 3800,
      outputTokens: 450,
      costUsd: 0.042,
      model: 'gpt-4o-mini',
      sessionId: '9f2c',
      spans: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, body));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTrace('0af7651916cd43dd8448eb211c80319c')).resolves.toEqual({
      status: 'ok',
      data: body,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/observability\/traces\/0af7651916cd43dd8448eb211c80319c$/),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('maps a missing trace 404 to disabled (caller distinguishes from feature-off via config)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { detail: 'Trace not found.' })));
    await expect(fetchTrace('0af7651916cd43dd8448eb211c80319c')).resolves.toEqual({
      status: 'disabled',
    });
  });
});
