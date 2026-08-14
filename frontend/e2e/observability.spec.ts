import { expect, test, type Page } from '@playwright/test';

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

async function mockObservabilityBackend(page: Page) {
  let authenticated = false;
  await page.route('**/api/observability/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path.endsWith('/config') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled: true, authenticated }),
      });
      return;
    }
    if (path.endsWith('/login') && method === 'POST') {
      authenticated = true;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path.endsWith('/logout') && method === 'POST') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    if (path.includes('/summary') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(POPULATED_SUMMARY),
      });
      return;
    }
    if (path.endsWith(`/traces/${TRACE_ID}`) && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(TRACE_DETAIL),
      });
      return;
    }
    if (path.endsWith('/traces') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ traces: [TRACE_ROW], nextCursor: null, hasMore: false }),
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'unmocked' }),
    });
  });
}

test.describe('Observability operator dashboard', () => {
  test('login → dashboard → trace detail → back', async ({ page }) => {
    await mockObservabilityBackend(page);
    await page.goto('/observability');

    await expect(page.getByRole('heading', { name: /observability access/i })).toBeVisible();
    await page.getByLabel(/operator token/i).fill('operator-token');
    await page.getByRole('button', { name: /access dashboard/i }).click();

    await expect(page.getByRole('heading', { name: /observability dashboard/i })).toBeVisible();
    await expect(page.getByText('145ms')).toBeVisible();
    await expect(page.getByText('Recent Traces')).toBeVisible();
    await expect(page.getByText('client-reported')).toBeVisible();
    await expect(page.getByTestId('cascade-latency-strip')).toHaveCount(0);

    await page.getByRole('button', { name: /view/i }).click();

    await expect(page).toHaveURL(new RegExp(`/observability/traces/${TRACE_ID}$`));
    await expect(page.getByRole('heading', { name: /span waterfall/i })).toBeVisible();
    await expect(page.getByTitle('realtime.session')).toBeVisible();
    await expect(page.getByTitle('realtime.turn')).toBeVisible();

    await page.getByRole('link', { name: /back to dashboard/i }).click();
    await expect(page).toHaveURL(/\/observability$/);
    await expect(page.getByRole('heading', { name: /observability dashboard/i })).toBeVisible();
  });
});
