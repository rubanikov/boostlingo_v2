# 05 — Operator dashboard: cards, cursor table, waterfall

**What to build:** A signed-in operator picks a window, hits Refresh (no polling), sees four summary cards and a filterable trace table (cursor Prev/Next, client-side “Page N”, no jump-to-page). Row click navigates to `/observability/traces/:id` (same tab, back works) and renders the pre-flattened waterfall with real span names. Empty Langfuse is `—` / “No traces”, visually distinct from unreachable. Login → dashboard → detail → back is the e2e path.

**Blocked by:** 04 — Operator can open `/observability`, log in, and log out

**Size:** Right-sized — one demoable read path (inspect a session in-app) against the owned JSON contract. Auth/router already exist; this ticket fills Langfuse mapping + cards/table/detail.

**Status:** ready-for-agent

**Backend scope:** `langfuse_api.py` (timeout 10s) behind the owned routes from 04; implement `GET /traces/{id}`; replace 503-when-unconfigured summary/list with real mapping when keys are set.

**Frontend scope:** `DashboardView`, `SummaryCards`, `TraceTable`, `TraceDetailPage`; e2e spec.

## Acceptance criteria

- [ ] `/summary?window=1h|24h|7d`, `/traces` (filters + opaque `cursor`), `/traces/{id}` return the brief shapes from a **faked** Langfuse Metrics API v2 + Observations API v2 (AC10). Windows computed server-side UTC (`datetime.now(timezone.utc)`), never from a client-supplied clock. SPA formats for display in the browser’s local timezone and does no window arithmetic. `null`/`[]` when Langfuse has no data, never `0`.
- [ ] `window` outside the enum → 422. `window` defaults to `24h`. `mode` = `all|cascade|realtime` (default `all`); `status` = `all|error` (default `all`); `limit` 1–100, default 25.
- [ ] Malformed `trace_id` (must match `^[0-9a-f]{16,64}$`) → 422; well-formed unknown → 404 `{"detail": "Trace not found."}`.
- [ ] `spans` pre-ordered depth-first with `depth` and `startOffsetMs`; names are `cascade.session → cascade.segment → stt / llm.translate / tts` or `realtime.session → realtime.turn`. Never tool-call demos. `truncated: true` drives the truncation note. Waterfall renders directly from this array and does no tree-building.
- [ ] ConnectError → 503; unusable 2xx body / non-2xx → 502; neither crashes. Healthy empty → **200** with `[]`/`null` (AC14). Langfuse public/secret keys never leave the backend.
- [ ] UI: 4-col cards (`—` for null) — Latency p50/p95, Error Rate, Cost & Tokens, Sessions (Realtime/Cascade). Zebra table (Time / Mode / Trace ID / Latency / Tokens / Cost / Status / View), mode/status filters, cursor Prev/Next in the `join` control, **manual Refresh** (no polling, no auto-refresh). `/observability/traces/:id` waterfall (indent by `depth`, bar left/width from `startOffsetMs`/`durationMs`) + Prompt/Completion/Metadata tabs (`overflow-auto max-h-64 whitespace-pre-wrap`) + Trace Details sidebar. One-span trace → one-row waterfall.
- [ ] Realtime rows/spans attributed as client-reported in the UI.
- [ ] Playwright: login → dashboard → click row → `/observability/traces/:id` → back (AC10). Component tests: 401 → login, 503 → unreachable+Retry, empty ≠ down, wrong token inline error (rest of AC11/14).
- [ ] Dashboard chrome already in 04 (window select, Refresh, Logout) is wired to real data. Layout: `max-w-6xl`, DaisyUI/Tailwind matching the workbench. Not on the page: evals, datasets, playground, user admin. **No latency badges on `/observability`.**

## Brief anchors

- Brief: `.scratch/briefs/observability-technical-brief.md` — Langfuse read APIs (Metrics API v2 + Observations API v2; do **not** use deprecated v1 `/api/public/traces`); owned JSON response shapes for summary / traces / traces/{id}; Frontend components `DashboardView` / `SummaryCards` / `TraceTable` / `TraceDetailPage`.
- Wireframe: `.scratch/wireframes/observability-wireframe.html` — dashboard, detail, loading, empty vs down. Nits: cursor Prev/Next (not jump-to-page); real span names; trace click is in-place navigation to `/observability/traces/:id`, not a new tab.
- Langfuse calls: HTTP Basic (`public_key:secret_key`), `timeout=10.0`, translate `httpx.HTTPError` → 503, non-2xx or unparseable body → 502.
- Trace list: `GET {LANGFUSE_HOST}/api/public/v2/observations` with `parentObservationId is null` (or fallback: fetch window and group by `traceId` server-side if that filter is rejected). Paginate via `meta.cursor`.
- Trace detail: same endpoint with `traceId=<id>`, `fields=core,basic,io,usage,model,trace_context`, `limit=1000`; backend builds the tree from `parentObservationId`.
- Cards come from Langfuse Metrics API v2 over trace/observation data, **not** from the OTLP metrics pipeline.
- Not blocked by 02/03 (fakes). A live compose demo needs 01+02+03 for real rows. No live Langfuse keys in this build environment — skip tests that need a real key with a message naming the variable; never fabricate.

## Locked substitutions (gate 7)

- Dashboard cards from Langfuse Metrics API v2, not OTLP metrics in Langfuse.
- Owned JSON APIs, not a catch-all proxy.
- Trace table: cursor Prev/Next, no jump-to-page.
