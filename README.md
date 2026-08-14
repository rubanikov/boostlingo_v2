# AI Interpreter Workbench

A Boostlingo take-home project: a browser SPA that does live speech interpretation two
different ways, side by side, so the trade-offs between them can be measured instead of
assumed.

- **Realtime mode**: voice-in, voice-out via OpenAI's Realtime API (`gpt-realtime`) over
  a direct browser↔OpenAI WebRTC connection.
- **Cascade mode**: a streaming STT → Translation → TTS pipeline (Deepgram → OpenAI →
  ElevenLabs) over one WebSocket to this repo's own backend, with diarization,
  per-speaker voices, LLM-hybrid segmentation, full per-stage latency instrumentation,
  and retry/circuit-breaker resilience.

See [COMPARISON.md](COMPARISON.md) for the full latency/quality/cost/controllability
write-up, and [AGENTS.md](AGENTS.md) for how this was built with an AI coding agent.

## Architecture at a glance

```
Browser SPA (React + TypeScript, Vite)
 ├─ Realtime mode: RTCPeerConnection ── WebRTC (audio + "oai-events" data channel) ──▶ OpenAI directly
 │                      ▲
 │                      └── POST /api/realtime/session (mints a short-lived ephemeral
 │                          token; the real OPENAI_API_KEY never reaches the browser)
 │
 └─ Cascade mode:  WebSocket /ws/cascade ──▶ FastAPI backend (Python)
                                                 ├─ Deepgram (streaming STT, diarized)
                                                 ├─ OpenAI gpt-4o-mini (translation +
                                                 │   LLM segmentation-checker)
                                                 └─ ElevenLabs (streaming TTS)
```

The backend is only ever in the audio path for Cascade mode. For Realtime mode it mints
one ephemeral token per session and is otherwise off the critical path entirely (see
COMPARISON.md §1 for why that matters for latency instrumentation).

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/) (Python package/venv manager), verified against
  `uv 0.10.10` in this repo.
- Node.js + npm, verified against `node v26.2.0` / `npm 11.13.0` in this repo.
- API keys for the providers you want to exercise for real (the app runs and its test
  suites pass with **no keys at all**: provider-touching tests skip gracefully; see
  "Running the test suites" below):
  - `OPENAI_API_KEY`: required for both modes (Realtime's `gpt-realtime` session, and
    Cascade's translation + LLM segmentation-checker, both `gpt-4o-mini`).
  - `DEEPGRAM_API_KEY`: required for Cascade mode's STT stage.
  - `ELEVENLABS_API_KEY`: required for Cascade mode's TTS stage.
  - `ELEVENLABS_VOICE_ID`: optional, defaults to a premade ElevenLabs voice ("Rachel")
    if unset.

These are exactly the provider-key variables in `backend/.env.example`. Optional
observability variables live in the same file, commented out; leaving them unset
is the default and changes nothing about audio or session behaviour.

## Setup

### Backend (`backend/`)

```bash
cd backend
cp .env.example .env      # then fill in your real API keys
uv sync
```

`uv sync` installs the locked dependency set (FastAPI, the `openai`/`websockets`/`httpx`
clients, `jiwer` for WER, `psutil` for the memory-stability test, etc.) into
`backend/.venv/`. Verified working from a clean checkout in this repo.

### Frontend (`frontend/`)

```bash
cd frontend
npm install
```

## Running the dev servers

Two terminals, both from repo root:

```bash
# Terminal 1: backend, http://localhost:8000
cd backend
uv run uvicorn app.main:app --reload

# Terminal 2: frontend, http://localhost:5173
cd frontend
npm run dev
```

Both were started and smoke-tested against this repo while writing this README
(`GET /health` → `{"status":"ok"}`; the Vite dev server serves the SPA on
`http://localhost:5173`). The frontend defaults to `http://localhost:8000` for the
backend; override with `VITE_API_BASE_URL` if you run the backend elsewhere.

Open `http://localhost:5173`, grant microphone access, pick a mode (Realtime/Cascade) and
a language pair (minimum EN↔ES), and start a session.

## Running the test suites

### Backend (pytest)

```bash
cd backend
uv run pytest -v
```

Verified in this repo: **223 passed, 1 skipped**. Tests that need a live
provider key self-skip with a message naming the env var, rather than failing.
See [COMPARISON.md](COMPARISON.md) §2 for the quality-validation suite.

### Frontend (Vitest, unit/component)

```bash
cd frontend
npm test
```

Verified in this repo: **18 test files, 183 passed**.

### Frontend (Playwright: E2E, fake-mic)

```bash
cd frontend
npx playwright install chromium   # one-time
npm run test:e2e
```

Drives the real capture → session-negotiation path in both modes using Chrome's
`--use-fake-device-for-media-stream` / `--use-file-for-fake-audio-capture` flags. See
`frontend/e2e/README.md` for exactly what's real vs. still placeholder in this harness
without a live backend + real speech fixtures.

## Observability (optional)

Telemetry is off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`. With an empty
`.env`, the backend installs no OpenTelemetry TracerProvider or MeterProvider
and opens no outbound OTLP connection. Cascade and Realtime sessions still
run. You do not need Docker to run the app.

The operator UI is at `/observability`. Without `OBSERVABILITY_UI_TOKEN` that
page shows a disabled state. With the token set, operators log in; the SPA
never talks to Langfuse. The backend maps Metrics API v2 and Observations
API v2 onto owned JSON under `/api/observability/*`.

### Environment

Copy the commented block in `backend/.env.example`. The names that matter:

| Variable | Role |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Traces. Example for local Langfuse: `http://localhost:3000/api/public/otel`. Empty = no tracer. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Must be `http/protobuf`. Langfuse does not accept gRPC. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Basic <base64 of pk-lf-...:sk-lf-...>` **and** `x-langfuse-ingestion-version=4`. Without the ingestion-version header, OTLP data can lag the UI by up to ~10 minutes. |
| `OTEL_SERVICE_NAME` | `ai-interpreter-workbench-backend` |
| `OTEL_TRACES_SAMPLER` | `always_on` (100% sampling when a provider is installed) |
| `OTEL_BSP_MAX_QUEUE_SIZE` / `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BSP_EXPORT_TIMEOUT` | BatchSpanProcessor bounds (2048 / 1000ms / 5000ms). A dead collector fills the queue and drops spans instead of blocking audio. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional, **separate** from the traces endpoint. Langfuse's OTLP ingest is traces-only; leave this empty unless you have a collector that wants metrics. |
| `OBSERVABILITY_UI_TOKEN` | Operator login for `/observability`. Unset = that UI is disabled. |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Backend-only reads for the dashboard. Never sent to the browser. |

Span text is truncated at `OBSERVABILITY_MAX_SPAN_TEXT_CHARS` (default 8000).
Realtime ingest uses a 2-hour HMAC token (`TELEMETRY_TOKEN_TTL_SECONDS`), a
16 KiB body cap, and 60 requests/minute per session id. Those three have
working defaults; they are commented in `.env.example`.

**Full text is stored in Langfuse.** Source utterances, translations, prompts, completions, and error strings are span attributes by design. There is no kill-switch and no PII redaction. Audio bytes are never attached to a span.

**Realtime latency is client-reported.** `realtime.turn` timings come from the browser's `Date.now()`, not from the backend. Do not compare them to Cascade's server-measured stage latencies as if they were the same clock.

### Local Langfuse via Compose

`docker-compose.yml` at the repo root is an optional Langfuse v4 stack
(`langfuse/langfuse:4`, `langfuse/langfuse-worker:4`, `postgres:17-alpine`,
`clickhouse/clickhouse-server:25.3-alpine`, `redis:7-alpine`, `minio/minio:latest`).
The workbench process is not in that file.

Before the first start, replace the `# CHANGEME` values for `ENCRYPTION_KEY`
(`openssl rand -hex 32`), `SALT`, and `NEXTAUTH_SECRET`. Then:

```bash
docker compose up -d
```

Langfuse UI: `http://localhost:3000`. Worker is bound to `127.0.0.1:3030`;
Postgres `127.0.0.1:5432`; ClickHouse `127.0.0.1:8123` / `9000`; Redis
`127.0.0.1:6379`; MinIO S3 API `9090` (console `127.0.0.1:9091`). Record the
resolved image digests on first bring-up. The `:4` tags are major-floating
pins, matching Langfuse's own compose file.

### Alert thresholds

No paging code ships in this repo. Use these as starting points in Langfuse's
own alerts or as PromQL against an OTLP metrics collector, whichever you have:

- **p95 stage latency:** `interpreter.stage.duration` (ms, attribute `stage` =
  `stt` / `translate` / `tts`). Alert if p95 for any stage stays above 2000ms
  for 5 minutes.
- **Error rate:** `interpreter.errors` over completed turns. Alert if the rate
  stays above 1% for 5 minutes.
- **Mint failures:** `interpreter.realtime.mint.failures`. Alert if more than
  3 failures land in 5 minutes (`POST /api/realtime/session` could not mint an
  OpenAI ephemeral token).

Tune the numbers to the demo; they are not SLOs.

## Provider abstractions

Cascade mode's STT/Translation/TTS providers are each a `Protocol`-typed interface
(`backend/app/providers/base.py`) with one concrete implementation apiece
(`deepgram_stt.py`, `openai_translation.py`, `elevenlabs_tts.py`). Swapping any one of
them for a different vendor is a contained, one-class change. Nothing upstream or
downstream of the `Protocol` needs to change. Realtime mode has no equivalent swap point;
`gpt-realtime` *is* the pipeline (see [COMPARISON.md](COMPARISON.md) §4).

## Where things live

| | |
|---|---|
| Backend app code | `backend/app/` (`api/` routes, `providers/` vendor boundaries, `orchestrator.py` for Cascade's pipeline, `quality/` for Ticket 8's LLM-judge) |
| Backend tests | `backend/tests/` (pytest); shared quality dataset + fixture/report scripts at `backend/tests/fixtures/` |
| Frontend app code | `frontend/src/pages/` (unified workbench, `/observability` dashboard, shared session/latency/audio logic) |
| Frontend tests | co-located `*.test.ts(x)` (Vitest) + `frontend/e2e/` (Playwright) |
| Comparison write-up | [COMPARISON.md](COMPARISON.md) |
| Agent-usage notes | [AGENTS.md](AGENTS.md) |
| Architecture decision record | `.scratch/ai-interpreter-workbench/` (wayfinder map + 14 resolved decision tickets + 8 implementation tickets) |
