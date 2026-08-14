# Technical brief: always-on LLM observability (OTel → Langfuse) + operator dashboard

Story: 19 ACs (see request). Wireframe: `.scratch/wireframes/observability-wireframe.html` (approved,
**with the nits below overriding the raw HTML**). Read `AGENTS.md` before starting.

**Wireframe nits that override the HTML file itself.** The committed HTML still shows things the nits
retracted. Builders follow the nits, not the file, on exactly these points:

| HTML shows | Build instead |
|---|---|
| Cascade/Realtime latency badges in the observability header (lines 59-67) | No latency badges anywhere on `/observability`. They stay only on the workbench. |
| Waterfall spans `llm_generation`, `tool_call_weather` (lines 250-262) | `cascade.session → cascade.segment → stt / llm.translate / tts`, or thin `realtime.session → realtime.turn`. Never tool-call demos. |
| "Session valid for 2 hours" (line 367), "Your 2-hour operator session has expired" (line 415) | Browser-session cookie, no fixed lifetime. Copy: "Signed in until you log out or close the browser." The 2h TTL belongs to the Realtime telemetry token, which is never shown here. |
| Numbered pagination "« / Page 1 / »" (lines 198-204) | Same visual `join` control, but Prev/Next driven by an opaque cursor (Langfuse v4 is cursor-paginated). "Page N" is a client-side counter. See Risks. |

Everything else in the HTML is layout truth: `max-w-6xl`, 4-col chart strip, DaisyUI/Tailwind matching
the workbench, `Workbench | Observability` tabs, span text `overflow-auto max-h-64 whitespace-pre-wrap`,
trace click navigating to a dedicated route (not a new tab). Not on the page: evals, datasets,
playground, user admin.

## Architecture

Three separable pieces, each independently no-op-able:

1. **Emit.** OpenTelemetry SDK initialised once in a FastAPI `lifespan` (`backend/app/main.py`, which
   has none today). If `OTEL_EXPORTER_OTLP_ENDPOINT` is empty, **install no provider at all**. The OTel
   *API* then falls back to its built-in no-op tracer/meter, so every `tracer.start_as_current_span(...)`
   in the orchestrator becomes a cheap no-op with zero branching at the call sites. This is what makes
   AC8 (empty `.env` → exporters off, tests green, audio unchanged) fall out for free rather than being
   maintained by hand.
2. **Ship.** `BatchSpanProcessor` only — never `SimpleSpanProcessor`. Export runs on a background
   thread with a bounded queue; a dead collector fills the queue and drops spans instead of blocking
   the audio path (AC9). Langfuse's OTLP endpoint accepts **HTTP protobuf/JSON only, not gRPC**.
3. **Read.** The SPA never talks to Langfuse. `backend/app/api/observability.py` exposes our own JSON
   resources and calls Langfuse's read APIs server-side with the Langfuse keys. Deliberately *not* a
   catch-all proxy: Langfuse v4 deprecated `GET /api/public/traces` and `/traces/{id}` in favour of
   cursor-paginated `GET /api/public/v2/observations`, so an owned resource layer absorbs that churn
   and keeps the SPA contract stable.

Trace shape:

```
cascade.session                     (root; one per /ws/cascade session, survives WS resume)
└── cascade.segment                 (one per segment; segmentId, trigger)
    ├── stt.deepgram                (source text, detected_language, speaker)
    ├── llm.translate               (gen_ai.* generation: prompt, completion, tokens, cost)
    └── tts.elevenlabs              (voice, audio byte count — no audio)

realtime.session                    (root; one per POST /api/realtime/session, incl. mint failures)
└── realtime.turn                   (one per client-reported turn; client-reported latency)
```

**No audio bytes on spans, ever.** Full text (source, translation, prompts, completions, errors) is on
spans by design; there is no kill-switch and no PII redaction (see Risks).

## Data model changes

No database, no tables, no migrations. All telemetry lives in Langfuse; all auth state is derived, not
stored.

Two pieces of in-process state, both deliberately following the existing `orchestrator._detached_sessions`
precedent (in-process dict, not shared across workers or restarts):

- **Telemetry-token signing secret** — `secrets.token_bytes(32)` generated once at process start.
  Tokens minted by one worker are invalid on another and do not survive a restart. Acceptable at 2h TTL
  for a single-process dev/demo deployment; flagged under Risks.
- **Ingest rate-limit buckets** — `dict[str, tuple[float, float]]` keyed by the token's `sid`, evicted
  on expiry.

The observability cookie holds no server-side state at all: its value is
`hmac_sha256(key=OBSERVABILITY_UI_TOKEN, msg=b"observability-ui-session-v1").hexdigest()`, verified with
`secrets.compare_digest`. Rotating or unsetting the token invalidates every outstanding cookie.

**Tenant isolation.** This app has no tenants, users, or per-user data — a single operator token gates a
single Langfuse project. The boundary that matters is therefore: (a) every `/api/observability/*` read
requires the cookie, (b) Langfuse public/secret keys never leave the backend, (c) `/api/telemetry/*`
writes require a signed telemetry token *and* an allow-listed `Origin`. Mic sessions (`/ws/cascade`,
`POST /api/realtime/session`) stay unauthenticated (AC16) — adding observability must not gate them.

**Timezones.** Every timestamp crossing a boundary is UTC ISO-8601 with a trailing `Z`. Window
boundaries (`1h`/`24h`/`7d`) are computed on the **backend** from `datetime.now(timezone.utc)`, never
from a client-supplied clock, and passed to Langfuse as `fromTimestamp`/`toTimestamp` (metrics) or
`fromStartTime`/`toStartTime` (observations). The SPA formats for display in the **browser's local
timezone** and does no window arithmetic. `expires_at` fields are Unix epoch **seconds** (matching the
existing `RealtimeSessionResponse.expires_at`).

## Background flow / process flow

**Cascade (server-side, synchronous with the pipeline, no new scheduler).** Spans are opened and closed
inline on the existing asyncio tasks in `backend/app/orchestrator.py`. Export is the only asynchronous
part, and it is owned by `BatchSpanProcessor`'s own background thread.

1. `_start_new_session` opens the `cascade.session` span and stores its context on the session state.
2. `_cut_segment` opens a `cascade.segment` span; `stt.deepgram` closes with the cut buffer as its text.
3. `_process_segment` opens `llm.translate` and `tts.elevenlabs` as children of that segment's span.
4. **Streaming:** text accumulates in the existing loops and is set as an attribute *immediately before
   the span ends*, never per-delta. `_run_translation_with_retry` already accumulates `translated_text`;
   `_run_tts_with_retry` already tracks `first_chunk`. Attach `translation_first_token` /
   `tts_first_byte` as span events at the points `_emit_latency` is already called, so the waterfall and
   the live latency strip read the same instants without duplicating logic.
5. **Retries:** each attempt gets its own child span (`llm.translate` attempt 0, 1, …) with
   `retry.attempt`. A dropped segment ends its stage span with status `ERROR`.
6. **Partial failure:** an exception anywhere in the telemetry code must never propagate into the audio
   path. Every seam is wrapped so a telemetry bug degrades to "no span", not "dropped segment".
7. **WS resume (AC: same session trace):** `_DetachedSession` gains a field carrying the session's OTel
   context. `_resume_session` re-enters that context, so a reconnect within `GRACE_WINDOW_S` continues
   the same `cascade.session` trace rather than starting a second one. Grace-window expiry ends the
   session span with status `ERROR` and `session.end_reason = "grace_window_expired"`.

**Realtime (thin, client-reported).**

1. `POST /api/realtime/session` opens the `realtime.session` span, mints the OpenAI ephemeral token as
   today, and mints a telemetry token bound to that span's trace/span IDs. A mint failure ends the span
   `ERROR` and increments `realtime.mint.failures`. The session span is ended immediately (its children
   arrive later as independent spans linked by trace ID).
2. The SPA holds the telemetry token in React state only — never `localStorage`/`sessionStorage`.
3. Each completed turn (on `response.output_audio_transcript.delta` settling, reusing the existing
   `realtimeLatency.ts` timestamps) is POSTed to our ingest endpoint. The backend emits one
   `realtime.turn` span into the token's trace.
4. **401 → the SPA drops turns silently and the WebRTC session continues untouched** (AC5). No re-mint
   in v1. No retry queue. No user-visible error.

**Metrics.** `MeterProvider` with a `PeriodicExportingMetricReader` (60s). Instruments recorded inline
at the same seams. 100% sampling (`OTEL_TRACES_SAMPLER=always_on`).

| Instrument | Type | Unit | Attributes |
|---|---|---|---|
| `interpreter.stage.duration` | histogram | ms | `stage` (`stt`/`translate`/`tts`), `mode` |
| `interpreter.turn.duration` | histogram | ms | `mode` |
| `interpreter.llm.tokens` | counter | `{token}` | `direction` (`input`/`output`), `model` |
| `interpreter.llm.cost` | counter | USD | `model` |
| `interpreter.errors` | counter | `{error}` | `provider`, `kind`, `retryable` |
| `interpreter.realtime.mint.failures` | counter | `{failure}` | `reason` |

**Langfuse does not ingest OTLP metrics** — its OTLP endpoint is traces-only. Metrics therefore export
to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` if (and only if) it is set, and are a no-op otherwise. The
dashboard's four cards are computed from Langfuse's **Metrics API v2 over trace/observation data**, not
from this metrics pipeline. See Risks.

## API changes

Everything below is the shared contract. Backend and frontend build against exactly these names.

### Cookie (pinned)

| Property | Value |
|---|---|
| Name | `obs_session` |
| Value | 64-char lowercase hex (HMAC-SHA256, see Data model) |
| `HttpOnly` | yes |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | set **iff** `request.url.scheme == "https"` |
| `Max-Age` / `Expires` | **omitted** — browser-session cookie, dies with the browser |

The SPA must send `credentials: 'include'` on every `/api/observability/*` fetch: dev is
`localhost:5173 → localhost:8000`, which is cross-*origin* (so `credentials` is required) but
same-*site* (so `SameSite=Lax` still permits it). `CORSMiddleware` in `backend/app/main.py` already sets
`allow_credentials=True` against the explicit `settings.cors_origins` list; no change needed.

### Error shape

Every failure is FastAPI's standard `{"detail": "<human-readable string>"}`, matching
`backend/app/api/realtime.py`. **The SPA switches on the status code, not on the string:**

| Status | Meaning | SPA behaviour |
|---|---|---|
| 401 | Missing/invalid/stale `obs_session` cookie | Clear local auth state, show the login card |
| 404 | `OBSERVABILITY_UI_TOKEN` unset — feature disabled | Show the disabled state |
| 413 | Ingest payload over the cap | (ingest only) drop the turn |
| 429 | Ingest rate limit | (ingest only) drop the turn |
| 502 | Langfuse returned an unusable response | Show the "Telemetry Backend Unreachable" state + Retry |
| 503 | Langfuse unreachable / Langfuse keys unset | Show the "Telemetry Backend Unreachable" state + Retry |

Distinguish empty from down: a healthy Langfuse with no data returns **200** with empty arrays and
`null` metrics, never 503.

### `GET /api/observability/config`

No auth. Always 200. This is the SPA's first call on mounting `/observability`.

```json
{ "enabled": true, "authenticated": false }
```

`enabled` is `OBSERVABILITY_UI_TOKEN != ""`. `authenticated` is whether a valid `obs_session` cookie
came in. Never reveals the token or the Langfuse host.

### `POST /api/observability/login`

Request `{"token": "..."}`. Responses:

- `204` + `Set-Cookie: obs_session=...` on match (constant-time compare).
- `401` `{"detail": "Invalid operator token."}` on mismatch — **no `Set-Cookie` header at all** (AC11).
- `404` `{"detail": "Observability is not enabled on this server."}` when the token is unset (AC13).

### `POST /api/observability/logout`

`204` + `Set-Cookie: obs_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`. Idempotent; `204` even
without a cookie. Never 401.

### `GET /api/observability/summary?window=1h|24h|7d`

Cookie required. `window` defaults to `24h`; anything else → `422` (FastAPI enum validation).

```json
{
  "window": "24h",
  "from": "2026-08-12T18:00:00Z",
  "to": "2026-08-13T18:00:00Z",
  "latency": {
    "p50Ms": 145,
    "p95Ms": 320,
    "series": [{ "t": "2026-08-13T17:00:00Z", "p50Ms": 140, "p95Ms": 310 }]
  },
  "errorRate": { "rate": 0.002, "errorCount": 3, "totalCount": 1500,
                 "series": [{ "t": "2026-08-13T17:00:00Z", "rate": 0.001 }] },
  "cost": { "totalUsd": 1.42, "totalTokens": 142000, "inputTokens": 120000, "outputTokens": 22000 },
  "sessions": { "realtime": 42, "cascade": 18 }
}
```

Any metric Langfuse has no data for is `null` (numbers) or `[]` (series) — not `0`.

### `GET /api/observability/traces`

Cookie required. Query: `window` (as above), `mode` = `all|cascade|realtime` (default `all`),
`status` = `all|error` (default `all`), `limit` (1-100, default 25), `cursor` (opaque string, omit for
page 1).

```json
{
  "traces": [
    { "traceId": "0af7651916cd43dd8448eb211c80319c",
      "timestamp": "2026-08-13T15:42:15Z",
      "mode": "realtime",
      "latencyMs": 1200,
      "totalTokens": 4250,
      "costUsd": 0.04,
      "status": "success" }
  ],
  "nextCursor": "eyJ0IjoiMjAyNi0wOC0xM1QxNTo0MDowNVoifQ",
  "hasMore": true
}
```

`mode` ∈ `cascade|realtime`; `status` ∈ `success|error`. `nextCursor` is `null` on the last page.
`costUsd`/`totalTokens` are `null` when the provider reported none.

### `GET /api/observability/traces/{trace_id}`

Cookie required. `trace_id` must match `^[0-9a-f]{16,64}$` → else `422`. Unknown-but-well-formed id →
`404` `{"detail": "Trace not found."}`.

```json
{
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "mode": "cascade",
  "status": "error",
  "timestamp": "2026-08-13T15:42:15Z",
  "totalLatencyMs": 1200,
  "totalTokens": 4250,
  "inputTokens": 3800,
  "outputTokens": 450,
  "costUsd": 0.042,
  "model": "gpt-4o-mini",
  "sessionId": "9f2c...",
  "spans": [
    { "spanId": "b7ad6b71", "parentSpanId": null, "name": "cascade.session",
      "startOffsetMs": 0, "durationMs": 1200, "status": "error", "depth": 0,
      "input": null, "output": null, "truncated": false,
      "metadata": { "mode": "cascade", "languages": "en,es" } },
    { "spanId": "c31e02aa", "parentSpanId": "b7ad6b71", "name": "llm.translate",
      "startOffsetMs": 60, "durationMs": 960, "status": "success", "depth": 2,
      "input": "Where is the station?", "output": "¿Dónde está la estación?",
      "truncated": false,
      "metadata": { "model": "gpt-4o-mini", "inputTokens": 3800, "outputTokens": 450,
                    "costUsd": 0.042, "error.provider": null, "error.kind": null,
                    "error.retryable": null } }
  ]
}
```

`spans` is **pre-ordered depth-first and pre-flattened** by the backend, with `depth` and
`startOffsetMs` (ms from trace start) already computed — the waterfall renders directly from this and
does no tree-building. `truncated: true` drives the wireframe's truncation note.

### `POST /api/realtime/session` (extended, backward compatible)

Request body unchanged. `RealtimeSessionResponse` in `backend/app/api/realtime.py` gains three fields;
existing fields keep their names and meanings, so `useRealtimeSession.ts`'s current happy path is
unaffected:

```json
{
  "client_secret": "ek_...",
  "expires_at": 1999999999,
  "model": "gpt-realtime",
  "voice": "alloy",
  "telemetry_token": "eyJzaWQiOi...",
  "telemetry_expires_at": 1999999999,
  "trace_id": "0af7651916cd43dd8448eb211c80319c"
}
```

All three new fields are `null` when observability is off (no OTLP endpoint configured). TTL is exactly
**7200 seconds (2h)**, from `settings.telemetry_token_ttl_seconds`. Token format:
`base64url(json) + "." + base64url(hmac_sha256)` over `{"sid": "<uuid4 hex>", "tid": "<trace id>",
"exp": <epoch seconds>}`. Opaque to the SPA — it forwards it and never parses it.

### `POST /api/telemetry/realtime/turn`

Auth: `Authorization: Bearer <telemetry_token>`. Also enforced, in this order:

1. **Origin check** — identical rule to `/ws/cascade`: reject with `403` if `Origin` is present and not
   in `settings.cors_origins`; allow if absent. Extract the existing check from
   `orchestrator.run_cascade_session` into `backend/app/origins.py` and call it from both, following the
   `app/languages.py` precedent for shared validation.
2. **Size cap** — `Content-Length` > `16384` bytes → `413`, before reading the body.
3. **Rate limit** — 60 requests/minute per token `sid`, token-bucket → `429`.
4. **Token** — invalid signature, malformed, or `exp` in the past → `401`
   `{"detail": "Invalid or expired telemetry token."}`.

Request:

```json
{
  "turnIndex": 3,
  "startedAt": "2026-08-13T15:42:15.120Z",
  "endedAt": "2026-08-13T15:42:16.320Z",
  "latencyMs": 1200,
  "sourceText": "Where is the station?",
  "targetText": "¿Dónde está la estación?",
  "sourceLanguage": "en",
  "targetLanguage": "es",
  "model": "gpt-realtime",
  "usage": { "inputTokens": 320, "outputTokens": 210 },
  "error": null
}
```

`turnIndex` (int ≥ 0), `latencyMs` (int ≥ 0), `startedAt`/`endedAt` (ISO-8601 with `Z`) required;
everything else optional/nullable. `usage` comes from the WebRTC `response.done` event when present.
Unknown fields rejected (`model_config = ConfigDict(extra="forbid")`) → `422`.

Response: `202` `{"accepted": true}`. When observability is off: still `202`, span dropped — the SPA
never behaves differently.

**No WebSocket protocol changes.** Cascade spans are entirely server-side; `/ws/cascade`'s message set
is untouched, so the live latency strip keeps working exactly as-is (AC17).

## Data / env / compose

`backend/app/config.py` `Settings` gains (all defaulting to off, so an empty `.env` changes nothing):

```python
observability_ui_token: str = ""
langfuse_host: str = ""                       # e.g. http://localhost:3000
langfuse_public_key: str = ""
langfuse_secret_key: str = ""
observability_max_span_text_chars: int = 8000
telemetry_token_ttl_seconds: int = 7200
telemetry_ingest_max_bytes: int = 16384
telemetry_ingest_rate_per_minute: int = 60
```

OTel is configured through the **standard OTel environment variables**, read by the SDK, not through
`Settings` (so nothing has to be re-plumbed if the collector changes). Pinned names, added to
`backend/.env.example` commented out:

```bash
# Observability — all optional. Unset = telemetry disabled, app behaves exactly as before.
OTEL_EXPORTER_OTLP_ENDPOINT=            # e.g. http://localhost:3000/api/public/otel
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf   # Langfuse accepts HTTP protobuf/JSON only, never gRPC
OTEL_EXPORTER_OTLP_HEADERS=             # Authorization=Basic <b64 "pk-lf-...:sk-lf-...">,x-langfuse-ingestion-version=4
OTEL_SERVICE_NAME=ai-interpreter-workbench-backend
OTEL_TRACES_SAMPLER=always_on
OTEL_BSP_MAX_QUEUE_SIZE=2048
OTEL_BSP_SCHEDULE_DELAY=1000            # ms
OTEL_BSP_EXPORT_TIMEOUT=5000            # ms
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=    # separate; Langfuse does NOT ingest OTLP metrics

OBSERVABILITY_UI_TOKEN=                 # unset = /observability disabled entirely
LANGFUSE_HOST=                          # e.g. http://localhost:3000 (dashboard reads)
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

`x-langfuse-ingestion-version=4` is not optional-in-practice: without it, directly ingested OTLP data
can lag the UI by up to 10 minutes, which would look like "the dashboard is broken" in a demo.

**New dependencies** (`backend/pyproject.toml`), pinned to the current majors:

```toml
"opentelemetry-sdk>=1.40.0",
"opentelemetry-exporter-otlp-proto-http>=1.40.0",
```

Only the SDK and the HTTP OTLP exporter. No `opentelemetry-instrumentation-*` auto-instrumentation
packages, no `langfuse` Python SDK — spans are created with the plain OTel API and read through plain
`httpx`, which the repo already depends on. The builder resolves the exact patch version via `uv add`
and commits `uv.lock`.

**Compose pin** (new `docker-compose.yml` at repo root, optional — AC18: the app must run with no
Docker at all):

| Service | Image | Pin rationale |
|---|---|---|
| `langfuse-web` | `langfuse/langfuse:4` | v4 is Langfuse's current stable major as of Aug 2026; the `:4` floating-major tag is what Langfuse's own self-hosting docs use. |
| `langfuse-worker` | `langfuse/langfuse-worker:4` | Must match the web image's major. |
| `postgres` | `postgres:17-alpine` | Langfuse's metadata store. |
| `clickhouse` | `clickhouse/clickhouse-server:25.3-alpine` | Required by Langfuse v3+. |
| `redis` | `redis:7-alpine` | Queue/cache. |
| `minio` | `minio/minio:latest` | S3-compatible event upload target. |

The `:4` tag is deliberately a major-floating pin, not a patch pin: it is what upstream documents, and
patch-pinning a five-service stack we don't operate would rot faster than it would help. Record the
exact resolved digests in the README when it is first brought up. Langfuse's own compose file requires
`ENCRYPTION_KEY` (`openssl rand -hex 32`), `SALT`, and `NEXTAUTH_SECRET`; ship them as `# CHANGEME`
placeholders and say so in the README.

**Langfuse read APIs the backend calls** (verified against Langfuse v4 docs; note the v1 traces
endpoints are deprecated and must not be used):

- Metrics — `GET {LANGFUSE_HOST}/api/public/v2/metrics?query=<url-encoded JSON>`, HTTP Basic auth
  (`public_key:secret_key`). Aggregated fields come back named `{aggregation}_{measure}`.
  - **Latency card:** `{"view":"observations","metrics":[{"measure":"latency","aggregation":"p50"},{"measure":"latency","aggregation":"p95"}],"filters":[{"column":"isRootObservation","operator":"=","value":true,"type":"boolean"}],"fromTimestamp":...,"toTimestamp":...}` → `p50_latency`, `p95_latency`. Repeat with `"timeDimension":{"granularity":"auto"}` for the sparkline (`time_dimension` per row).
  - **Error-rate card:** same shape plus `"dimensions":[{"field":"level"}]`, metric `{"measure":"count","aggregation":"count"}` → `count_count` per `level`; rate = `ERROR / Σ`.
  - **Cost/tokens card:** `"metrics":[{"measure":"totalCost","aggregation":"sum"},{"measure":"totalTokens","aggregation":"sum"},{"measure":"inputTokens","aggregation":"sum"},{"measure":"outputTokens","aggregation":"sum"}]`, **no** `isRootObservation` filter (cost lives on the generation rows) → `sum_totalCost`, `sum_totalTokens`, …
  - **Sessions card:** `"dimensions":[{"field":"traceName"}]`, `"metrics":[{"measure":"count","aggregation":"count"}]`, filtered `isRootObservation = true` → counts keyed by `cascade.session` / `realtime.session`.
  - `sessionId`/`traceId`/`userId` are high-cardinality: filterable, **not** groupable (400 if grouped).
- Trace list — `GET {LANGFUSE_HOST}/api/public/v2/observations` with `fields=core,basic,usage,model,trace_context`, `fromStartTime`/`toStartTime`, `limit`, `cursor`, and `filter=[{"column":"parentObservationId","operator":"is null","type":"null","value":null}]` to get one row per trace. Mode filter → `{"column":"traceName","operator":"=","value":"cascade.session","type":"string"}`. Errors-only → `{"column":"level","operator":"any of","value":["ERROR"],"type":"stringOptions"}`. Always sorted `startTime` desc; paginate via `meta.cursor`.
- Trace detail — same endpoint with `traceId=<id>`, `fields=core,basic,io,usage,model,trace_context`, `limit=1000`; the backend builds the tree from `parentObservationId` (root = `null`).

All Langfuse calls get an explicit `timeout=10.0` (matching `realtime.py`) and translate `httpx.HTTPError`
→ `503`, non-2xx or unparseable body → `502`.

## Cascade instrumentation seams

Named, existing functions in `backend/app/orchestrator.py`. Each is a wrap, not a rewrite:

| Seam | What happens |
|---|---|
| `_start_new_session` | Start `cascade.session`; attributes `mode=cascade`, `session.id`, `languages`, `segmentation.mode`. Stash the context. |
| `_resume_session` | Re-enter the stashed context so a resume stays in the same trace. |
| `_expire_after_grace_window` / `_teardown_session` | End `cascade.session`; set `ERROR` on grace-window expiry. |
| `_cut_segment` | Start `cascade.segment` (`segment.id`, `segment.trigger`, `speaker`, `detected_language`); end `stt.deepgram` with `input.text` = the cut buffer. |
| `_process_segment` | Parent for `llm.translate` and `tts.elevenlabs`; sets `translation.direction`. |
| `_run_translation_with_retry` | `llm.translate` per attempt. `gen_ai.*` attributes so Langfuse renders it as a generation with model/tokens/cost. Text set once, from the accumulated `translated_text`, right before the span ends. |
| `_run_tts_with_retry` | `tts.elevenlabs` per attempt; `voice`, total audio bytes. Never audio content. |
| `_send_error` / `_record_failure_and_maybe_trip` | Set span status `ERROR` + `error.provider`, `error.kind` (the `ProviderErrorKind` name), `error.retryable`, and record the exception. Where the failure has no live stage span (STT connection exhausted in `_run_stt`, circuit-breaker trip), emit a standalone `provider.error` span under the session. Increment `interpreter.errors`. |
| `_emit_latency` | Add a span event named for the stage at the same instant the existing `latency` WS message is sent — one source of truth for both. |

**Token/cost seam.** `backend/app/providers/openai_translation.py` currently streams without usage, so
tokens are unavailable. Add `stream_options={"include_usage": True}` to the
`chat.completions.create(...)` call and read `chunk.usage` off the final chunk. This is safe with the
existing loop: the usage-only chunk has empty `choices`, which `if not chunk.choices: continue` already
skips. Surface the usage to the orchestrator without changing the `TranslationProvider` protocol's
`AsyncIterator[str]` shape — e.g. expose it as an attribute the provider sets on itself for the current
call, or have the orchestrator read it from the provider after the stream drains. Deepgram and
ElevenLabs report no tokens or cost; their spans carry duration and text only.

**Truncation.** One shared helper: any text attribute longer than
`observability_max_span_text_chars` (8000) is cut to that length and the span gains
`<attr>.truncated = true`. The span is always kept.

## Frontend changes

**New dependency:** `react-router-dom` (v7). This is the router introduction the brief calls for. Keep
it to `createBrowserRouter` + `RouterProvider`; no loaders, no data APIs, no code splitting in v1.

Routes:

| Path | Renders |
|---|---|
| `/` | `WorkbenchPage` — unchanged behaviour, including the Cascade latency strip and Realtime badge (AC17) |
| `/observability` | `ObservabilityPage` (login / disabled / dashboard) |
| `/observability/traces/:traceId` | `TraceDetailPage` — a real route, so the row click navigates in place and back/forward work (AC: not a new tab) |

New shell `AppShell` wraps all three: `max-w-6xl` container plus the `Workbench | Observability` tabs,
matching the workbench's existing DaisyUI `navbar`/`tabs` classes. **Latency badges never render inside
`/observability`.**

Components (all under `frontend/src/pages/observability/`):

- `ObservabilityPage` — calls `GET /api/observability/config` on mount and branches:
  - `enabled: false` → **disabled state**: 🔒, "Observability Disabled", the `OBSERVABILITY_UI_TOKEN`
    explanation. No login form, no fetches (AC13).
  - `enabled: true, authenticated: false` → `LoginCard`.
  - `enabled: true, authenticated: true` → `DashboardView`.
  - Any 401 from a later call → drop back to `LoginCard` (AC: cookie expired → login).
- `LoginCard` — password input + "Access Dashboard". On 401: inline `alert alert-error`, form stays,
  field cleared. Footer copy: **"Signed in until you log out or close the browser."** (not "2 hours").
- `DashboardView` — window `select` (Last 1 Hour / Last 24 Hours / Last 7 Days), a **manual Refresh
  button** (no polling, no auto-refresh in v1), Logout button, `SummaryCards`, `TraceTable`.
- `SummaryCards` — the 4-col strip: Latency p50/p95, Error Rate, Cost & Tokens, Sessions
  (Realtime/Cascade). `null` renders as `—`, never `0`.
- `TraceTable` — Time / Mode / Trace ID / Latency / Tokens / Cost / Status / View, `table table-zebra`,
  mode + status filter selects, cursor Prev/Next in the `join` control. Row click → `navigate()`.
- `TraceDetailPage` — back link, `Span Waterfall` from the pre-flattened `spans` array (indent by
  `depth`, bar left/width from `startOffsetMs`/`durationMs`), a span detail card with
  Prompt/Completion/Metadata tabs (`overflow-auto max-h-64 whitespace-pre-wrap`), and the right-hand
  Trace Details sidebar. Shows the truncation note when any selected span has `truncated: true`.
- `observabilityApi.ts` — every call goes through one wrapper that sets `credentials: 'include'` and
  maps status codes to a small discriminated union (`ok | unauthenticated | disabled | unavailable`)
  so no component hand-rolls status handling.
- Shared states: **loading** = DaisyUI `loading-spinner` + "Loading telemetry data…"; **Langfuse down**
  (502/503) = 🔌 "Telemetry Backend Unreachable" + Retry button; **empty** = the table's own "No traces
  in this window" row with the cards showing `—`. Down and empty are visually distinct (AC14).

**Realtime turn reporting** — new `frontend/src/pages/realtimeTelemetry.ts`, wired into
`useRealtimeSession.ts`:

- Keep `telemetry_token` in a `useRef`, never in `localStorage`/`sessionStorage` (AC15).
- Reuse the timestamps `realtimeLatency.ts` already captures (`input_audio_buffer.speech_stopped` →
  first `response.output_audio_transcript.delta`) rather than adding a second clock.
- On `response.done`, POST the turn with any `response.usage` present.
- Every failure path — 401, 413, 429, network error, observability off — is a silent no-op:
  `void fetch(...).catch(() => {})`. **Nothing in this file may ever touch `setStatus`/`fail`.**
  A `console.debug` is the maximum reaction. WebRTC continues regardless (AC5).

## Tests required

### Success

- Cascade session emits `cascade.session → cascade.segment → stt/llm/tts` with the expected parents,
  names, and full text on the LLM span. *Integration, pytest, in-memory span exporter.*
- `llm.translate` carries model, input/output tokens, and cost when the provider reports usage.
  *Unit, fake OpenAI stream ending in a usage-only chunk.*
- A WS drop + `resume_session` within the grace window produces **one** `cascade.session` trace, not
  two. *Integration, pytest.*
- `POST /api/realtime/session` returns a non-null `telemetry_token`, `telemetry_expires_at` exactly
  `now + 7200`, and `trace_id`, alongside the unchanged `client_secret`/`expires_at`/`model`/`voice`.
  *Integration, extends `backend/tests/test_realtime.py`'s existing mock harness.*
- A valid turn POST returns `202` and emits one `realtime.turn` span in the token's trace.
  *Integration, pytest.*
- Correct token → `204` + a `Set-Cookie` carrying `HttpOnly`, `SameSite=lax`, `Path=/`, and **no**
  `Max-Age`/`Expires`; `Secure` present on an `https` request and absent on `http`. *Integration.*
- With a cookie, `/summary`, `/traces`, `/traces/{id}` return the documented shapes from a faked
  Langfuse; `spans` come back depth-first with correct `depth`/`startOffsetMs`. *Integration.*
- `/logout` returns `204` and expires the cookie; the next `/summary` is `401`. *Integration.*
- Every metric instrument records at its seam. *Unit, in-memory metric reader.*
- Login → dashboard → click a row → `/observability/traces/:id` → back. *E2E, Playwright, mocked
  backend.*
- `/` still renders the workbench and its latency strip with the router in place. *Component, Vitest —
  extends `WorkbenchPage.test.tsx`.*

### Failure

- Wrong token → `401`, **no `Set-Cookie` header of any kind**, still locked. *Integration.*
- Every `/api/observability/*` data route without a cookie → `401`. *Integration, parametrised.*
- Tampered cookie value (one hex char flipped) → `401`. *Integration.*
- `OBSERVABILITY_UI_TOKEN` unset → `/config` reports `enabled: false`; login and all data routes → `404`.
  *Integration.*
- Langfuse unreachable (`httpx.ConnectError`) → `503`; malformed 2xx body → `502`; neither crashes.
  *Integration — mirrors `test_realtime.py`'s existing 502 tests.*
- Expired telemetry token (`exp` in the past) → `401`, no span emitted. *Integration.*
- Tampered telemetry-token signature → `401`. *Integration.*
- Turn POST with a disallowed `Origin` → `403`; with no `Origin` → accepted. *Integration.*
- Turn POST over 16 KiB → `413`; 61st request in a minute → `429`. *Integration.*
- A `ProviderError` in translation produces a span with status `ERROR` and `error.provider`,
  `error.kind`, `error.retryable`. *Unit, per `ProviderErrorKind` member.*
- A mint failure ends `realtime.session` `ERROR` and increments `realtime.mint.failures`. *Integration.*
- A telemetry helper raising mid-pipeline does **not** drop the segment or kill the session.
  *Integration — inject a raising exporter/tracer.*
- Frontend: 401 mid-session drops to the login card; 503 shows the unreachable state with Retry; wrong
  token shows the inline error and keeps the form. *Component, Vitest.*
- Frontend: a 401 from the turn-ingest endpoint leaves `useRealtimeSession`'s status `connected` and
  the peer connection open. *Unit, Vitest.*

### Edge cases

- **Empty `.env` (the default CI state): full backend suite green, no OTel provider installed, no
  outbound telemetry connection attempted, `/ws/cascade` behaviour byte-identical.** *Integration —
  this is AC8 and the most important test in the set.* Add an autouse fixture in
  `backend/tests/conftest.py` clearing `OTEL_*` so no developer's shell leaks into the suite.
- Dead collector: with `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at a black-holed port, a Cascade session
  completes within its normal time budget. *Integration, wall-clock assertion — AC9.*
- Span text over 8000 chars is truncated, `.truncated = true` is set, and the span is still exported.
  *Unit.*
- Langfuse healthy but empty → `200` with `[]`/`null`, and the UI shows the empty state, **not** the
  unreachable state. *Integration + component.*
- `window` outside `1h|24h|7d` → `422`. *Integration.*
- Malformed `trace_id` → `422`; well-formed but unknown → `404`. *Integration.*
- Turn POST with an unknown field → `422`. *Integration.*
- A trace whose root span is the only span renders a one-row waterfall. *Component.*
- No secret appears in the built bundle: `npm run build`, then grep `dist/` for
  `OBSERVABILITY_UI_TOKEN`, `LANGFUSE_SECRET_KEY`, and `sk-`. *E2E/CI check — AC15.*
- Mic sessions still work with no cookie present at all. *E2E — AC16.*

## Risks and open questions

- **NEW THIRD-PARTY DEPENDENCY — OpenTelemetry SDK.** `opentelemetry-sdk` +
  `opentelemetry-exporter-otlp-proto-http` in `backend/pyproject.toml`. Justification: there is no
  existing tracing infrastructure in this repo, and OTLP is the only wire format Langfuse ingests. Held
  to two packages; no auto-instrumentation, no vendor SDK.
- **NEW THIRD-PARTY DEPENDENCY — Langfuse.** An external service, self-hosted or cloud. Nothing in the
  audio path depends on it; both the emit and read sides degrade to no-op/`503`.
- **NEW THIRD-PARTY DEPENDENCY — `react-router-dom` v7.** The repo has no router (`App.tsx` renders
  `WorkbenchPage` directly). Two routes could be done with a `useState` switch, but the story explicitly
  calls for a router and a deep-linkable `/observability/traces/:id`, which a state switch can't give.
- **NEW DATASTORE (via compose, optional).** The Langfuse stack brings Postgres, ClickHouse, Redis, and
  MinIO. None of them are *our* datastore — we never connect to them; only `langfuse-web` does. The app
  runs with no Docker at all (AC18). Called out because five new containers is not a small footprint.
- **No new scheduler.** Span export uses `BatchSpanProcessor`'s own thread and metrics use
  `PeriodicExportingMetricReader`'s — both are part of the SDK we're already adding, not new
  infrastructure. Nothing is added to asyncio's task set beyond the existing per-session tasks.
- **Langfuse does not ingest OTLP metrics.** The idea brief says "traces + metrics exported to
  Langfuse"; Langfuse's OTLP endpoint is traces-only. Resolution above: metrics are emitted and
  exported to a *separate* optional OTLP metrics endpoint, and the dashboard's cards are computed from
  Langfuse's Metrics API v2 over trace data. AC6 (metrics recorded, 100% sampling) and AC10 (charts
  through the backend) are both satisfied, but "metrics land in Langfuse" is not literally true.
  **Confirm this substitution is acceptable, or drop the metrics pipeline from v1 entirely.**
- **PII: full text on spans, no kill-switch.** Every source utterance, translation, and prompt lands in
  Langfuse verbatim. That is the locked decision, and it is the right one for a demo, but it means
  Langfuse inherits the full sensitivity of the interpreted conversation. The README's observability
  section must say this in as many words. No audio is ever sent.
- **Client-reported Realtime latency is not trustworthy telemetry.** `realtime.turn` timings come from
  the browser's `Date.now()`, from a client that also holds the token. Unlike Cascade (server-measured),
  these numbers can be wrong or forged. Every Realtime-derived span and metric must be attributed as
  client-reported in both the UI and the README so nobody compares them to Cascade's numbers as if they
  were measured the same way. This mirrors the asymmetry COMPARISON.md §1/§4 already documents.
- **Streaming vs. span lifetime.** Text is attached once, right before a span ends. If a stream fails
  mid-way, the span carries whatever accumulated (plus `ERROR`), never a partial-and-unmarked value. The
  `translation_first_token` / `tts_first_byte` events must be attached at exactly the existing
  `_emit_latency` call sites — a second timing source here would let the waterfall and the live latency
  strip disagree, which is worse than having no waterfall.
- **Wireframe deviation: pagination.** The wireframe shows numbered pages; Langfuse v4 is cursor-only
  (`meta.cursor`, always sorted `startTime` desc, no `orderBy`). The `join` control keeps its look but
  becomes Prev/Next with a client-side page counter. Jump-to-page is not possible without a synthetic
  index. Flagging as an intentional deviation.
- **Langfuse `latency` units.** Langfuse documents trace-level latency in **seconds**. The backend
  converts to integer ms at its boundary, and every SPA-facing field is `...Ms`. **Verify against a live
  Langfuse instance before trusting the number** — a 1000× error here would be invisible in tests
  against a fake and obvious in a demo.
- **`isRootObservation` / `parentObservationId is null` filtering.** `isRootObservation` is documented
  for Metrics API v2; it is not confirmed as a filterable column on Observations API v2. If the
  `parentObservationId is null` filter is rejected, fall back to fetching rows for the window and
  grouping by `traceId` server-side. This affects the trace table only, not the cards. Verify first.
- **In-process telemetry-token secret.** Tokens do not survive a restart and are not shared across
  uvicorn workers, exactly like `orchestrator._detached_sessions`. A restart mid-session means turns
  401 and get dropped — audio is unaffected. If the demo runs multi-worker, add an explicit
  `TELEMETRY_TOKEN_SECRET` env var instead.
- **Cookie in production.** `SameSite=Lax` works in dev because `localhost:5173` and `localhost:8000`
  are same-site. If the SPA and backend are ever served from different registrable domains, the cookie
  will be dropped and `SameSite=None; Secure` (plus a stricter CORS story) becomes necessary. Out of
  scope for v1; noted so it isn't discovered during a deploy.
- **`stream_options={"include_usage": True}` touches the audio path.** It is the only change in this
  ticket that modifies a live provider call. The existing `if not chunk.choices: continue` guard already
  tolerates the extra usage chunk, but this must be verified against a real OpenAI stream, not only
  against the fakes in `backend/tests/test_providers.py`.
- **No live provider or Langfuse keys exist in this build environment** (see `AGENTS.md`). Everything
  here will be built against fakes. Tests needing a real key must **skip with a message naming the
  variable**, never fail and never fabricate a result — same rule the existing suite follows.

**Open questions for the user:**

1. Is the metrics substitution above (metrics to a separate optional OTLP endpoint; dashboard cards
   from Langfuse's Metrics API) acceptable, or should the metrics pipeline be dropped from v1?
2. Should the trace table expose jump-to-page at all, or is Prev/Next final?
3. Should the README's recommended alert rules (AC7) be expressed against Langfuse's own alerting, or
   as generic PromQL-style thresholds a reader adapts? The story says "README only, no paging code",
   which both satisfy.

## Out of scope

Offline/LLM-as-judge evaluation, Langfuse datasets, prompt playground, user administration, per-user
auth or roles, paging/alerting code of any kind, auto-refresh or live-streaming of the dashboard,
telemetry-token re-mint, audio capture into telemetry, PII redaction, changes to the live latency strip
or the Realtime badge, and any change to the `/ws/cascade` wire protocol.

## Files that will change

**Backend**

| Path | Change |
|---|---|
| `backend/app/observability/__init__.py` | **(new)** Package marker. |
| `backend/app/observability/otel.py` | **(new)** `init_telemetry()` / `shutdown_telemetry()`; installs no provider when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. |
| `backend/app/observability/spans.py` | **(new)** Span-name and attribute-name constants, Cascade/Realtime span helpers, the truncation helper. |
| `backend/app/observability/metrics.py` | **(new)** The six instruments and their recording helpers. |
| `backend/app/observability/auth.py` | **(new)** Cookie mint/verify, telemetry token mint/verify, the per-token rate limiter. |
| `backend/app/observability/langfuse_api.py` | **(new)** `httpx` client for Metrics API v2 and Observations API v2; maps Langfuse rows onto our response models. |
| `backend/app/api/observability.py` | **(new)** `/api/observability/{config,login,logout,summary,traces,traces/{id}}`. |
| `backend/app/api/telemetry.py` | **(new)** `POST /api/telemetry/realtime/turn`. |
| `backend/app/origins.py` | **(new)** Shared `Origin` allow-list check extracted from the orchestrator, per the `app/languages.py` precedent. |
| `backend/app/main.py` | Add `lifespan` calling `init_telemetry`/`shutdown_telemetry`; include the two new routers. |
| `backend/app/config.py` | Eight new `Settings` fields, all defaulting to off. |
| `backend/app/orchestrator.py` | Span seams (see Cascade instrumentation seams); `_DetachedSession` carries the OTel context; use `app.origins` for the existing check. |
| `backend/app/api/realtime.py` | Three new `RealtimeSessionResponse` fields; `realtime.session` span; mint-failure metric. |
| `backend/app/providers/openai_translation.py` | `stream_options={"include_usage": True}`; expose usage for the span. |
| `backend/pyproject.toml` / `backend/uv.lock` | Add the two OTel packages. |
| `backend/.env.example` | The commented observability block above. |
| `backend/tests/conftest.py` | Autouse fixture clearing `OTEL_*` so the suite never inherits a developer's shell. |
| `backend/tests/test_telemetry_spans.py` | **(new)** Cascade/Realtime span shape, truncation, error attributes, resume-as-one-trace. |
| `backend/tests/test_telemetry_noop.py` | **(new)** Empty `.env` and dead-collector behaviour (AC8, AC9). |
| `backend/tests/test_telemetry_ingest.py` | **(new)** Turn ingest: auth, Origin, size cap, rate limit. |
| `backend/tests/test_observability_auth.py` | **(new)** Cookie attributes, login/logout, disabled mode. |
| `backend/tests/test_observability_api.py` | **(new)** Summary/traces/detail against a faked Langfuse, plus 502/503. |
| `backend/tests/test_realtime.py` | Extend for the three new response fields. |

**Frontend**

| Path | Change |
|---|---|
| `frontend/src/App.tsx` | Replace the direct `WorkbenchPage` render with `createBrowserRouter` + `RouterProvider`. |
| `frontend/src/pages/AppShell.tsx` | **(new)** `max-w-6xl` shell with the `Workbench \| Observability` tabs. |
| `frontend/src/pages/observability/ObservabilityPage.tsx` | **(new)** Config gate: disabled / login / dashboard. |
| `frontend/src/pages/observability/LoginCard.tsx` | **(new)** Operator-token form and its error state. |
| `frontend/src/pages/observability/DashboardView.tsx` | **(new)** Window select, manual Refresh, Logout, cards, table. |
| `frontend/src/pages/observability/SummaryCards.tsx` | **(new)** The 4-col chart strip. |
| `frontend/src/pages/observability/TraceTable.tsx` | **(new)** Filterable, cursor-paginated trace table. |
| `frontend/src/pages/observability/TraceDetailPage.tsx` | **(new)** Waterfall, span tabs, sidebar. |
| `frontend/src/pages/observability/observabilityApi.ts` | **(new)** Typed fetch wrapper (`credentials: 'include'`) + status→state mapping. |
| `frontend/src/pages/observability/*.test.tsx` | **(new)** Component tests for each state. |
| `frontend/src/pages/realtimeTelemetry.ts` | **(new)** Turn-payload construction and the always-silent POST. |
| `frontend/src/pages/useRealtimeSession.ts` | Hold `telemetry_token` in a ref; report turns; never surface ingest failures. |
| `frontend/src/pages/realtimeConfig.ts` | Add the observability and telemetry-ingest endpoint constants. |
| `frontend/src/pages/WorkbenchPage.test.tsx` | Wrap in the router; confirm the latency strip is unchanged. |
| `frontend/e2e/observability.spec.ts` | **(new)** Login → dashboard → trace detail → logout, against a mocked backend. |
| `frontend/package.json` | Add `react-router-dom`. |

**Root**

| Path | Change |
|---|---|
| `docker-compose.yml` | **(new)** Optional pinned Langfuse stack. |
| `README.md` | Observability section: env vars, the compose quickstart, the recommended alert rules (AC7), the "full text is stored in Langfuse" warning, and the client-reported-Realtime-latency caveat. |
