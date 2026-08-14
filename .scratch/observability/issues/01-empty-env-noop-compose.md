# 01 — Empty `.env` is a no-op; optional Langfuse compose comes up

**What to build:** The app boots and the backend suite stays green with an empty `.env` (no OTel provider, no outbound telemetry). Operators can bring up an optional Langfuse stack via compose, or run with no Docker at all. README documents env, compose, generic alert thresholds, the “full text lands in Langfuse” warning, and that Realtime latency is client-reported.

**Blocked by:** None — can start immediately

**Size:** Right-sized — one operator-visible slice (compose + documented sink) plus the CI invariant later tickets rely on. Not a package-only chore: lifespan, settings, deps, compose, README, and the empty-env test all serve that behaviour.

**Status:** ready-for-agent

**Backend scope:** FastAPI lifespan `init_telemetry`/`shutdown_telemetry` (BatchSpanProcessor, HTTP protobuf only); Settings; OTel SDK deps; `.env.example`; compose; README; empty-env tests.

**Frontend scope:** None

## Acceptance criteria

- [ ] Empty `.env` / unset `OTEL_*`: no TracerProvider or MeterProvider installed, no outbound OTLP connection, full backend suite green (AC8). Autouse fixture in `conftest.py` clears `OTEL_*`.
- [ ] `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` unset → metrics export is a no-op; traces still follow `OTEL_EXPORTER_OTLP_ENDPOINT` (Langfuse does not ingest OTLP metrics).
- [ ] `OTEL_TRACES_SAMPLER=always_on` documented; 100% sampling when a provider is installed (AC6, plumbing).
- [ ] Settings fields exist and default off: `observability_ui_token`, `langfuse_*`, span-text cap 8000, telemetry TTL 7200, ingest 16384 / 60 per minute.
- [ ] `docker-compose.yml` at repo root with the pinned Langfuse v4 stack; app runs with no Docker (AC18).
- [ ] README: env vars (incl. `x-langfuse-ingestion-version=4`), compose quickstart, **generic** alert thresholds (p95 stage latency, error rate, mint failures) adaptable to Langfuse or PromQL (AC7), PII warning, client-reported Realtime caveat.
- [ ] `/ws/cascade` and `POST /api/realtime/session` behaviour unchanged in this ticket.

## Brief anchors

- Brief: `.scratch/briefs/observability-technical-brief.md` — Architecture §Emit/Ship; Data/env/compose; AC7/8/18; locked metrics substitution (optional separate `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`; dashboard cards later come from Langfuse Metrics API v2, not OTLP metrics in Langfuse).
- Compose pin: `langfuse/langfuse:4`, `langfuse/langfuse-worker:4`, `postgres:17-alpine`, `clickhouse/clickhouse-server:25.3-alpine`, `redis:7-alpine`, `minio/minio:latest`. Ship `ENCRYPTION_KEY` / `SALT` / `NEXTAUTH_SECRET` as `# CHANGEME` placeholders.
- OTel via standard env vars, not Settings. `x-langfuse-ingestion-version=4` is required in practice or the UI lags ~10 minutes.
- New deps: `opentelemetry-sdk>=1.40.0`, `opentelemetry-exporter-otlp-proto-http>=1.40.0` only. No auto-instrumentation, no Langfuse Python SDK.
- Do **not** instrument the orchestrator here.

## Locked substitutions (gate 7)

- Metrics: optional separate `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`; Langfuse OTLP is traces-only.
- Optional compose Langfuse stack; app must run with no Docker.
