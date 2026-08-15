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

## Why Python + TypeScript (and not .NET)

The brief prefers .NET/C# for the backend and asks for the choice to be explained. This
build uses Python (FastAPI) + TypeScript (React) deliberately:

- **The backend is an async-streaming problem, not a throughput problem.** Cascade mode
  holds one browser WebSocket plus concurrent streaming connections to Deepgram, OpenAI,
  and ElevenLabs, with an LLM clause-checker racing alongside. Python's `asyncio` +
  FastAPI's first-class WebSocket support fit that shape directly, and every provider in
  play ships a first-party or well-maintained async Python SDK. ASP.NET Core could do
  the same, but with more ceremony per provider and thinner streaming examples to draw
  from for these specific vendors.
- **A 15–20 hour budget rewards iteration speed over runtime performance.** The backend
  is I/O-bound glue between vendor APIs; nothing here needs .NET's performance profile.
- **TypeScript on the frontend is exactly the brief's preference**, kept as-is.

The FastAPI-vs-Flask and React-vs-Svelte depth is in the framework decision ticket
(`.scratch/ai-interpreter-workbench/issues/01-framework-choice.md`).

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

These are exactly the variables in `backend/.env.example`.

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
uv run uvicorn app.main:app --reload --ws-ping-interval 20 --ws-ping-timeout 20

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

Verified in this repo: **119 passed** (with live provider keys in `backend/.env`, so the
key-gated tests ran for real). Without keys, the tests that need a live provider (WER
regression against real Deepgram, the LLM-judge plumbing tests that don't inject a fake
client, etc.) self-skip with a message explaining exactly which env var to set, rather
than failing. See [COMPARISON.md](COMPARISON.md) §2 for the exact commands to run the
quality-validation suite for real.

### Frontend (Vitest, unit/component)

```bash
cd frontend
npm test
```

Verified in this repo: **11 test files, 137 passed**.

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
| Frontend app code | `frontend/src/pages/` (one page per mode, plus shared session/latency/audio logic) |
| Frontend tests | co-located `*.test.ts(x)` (Vitest) + `frontend/e2e/` (Playwright) |
| Comparison write-up | [COMPARISON.md](COMPARISON.md) |
| Agent-usage notes | [AGENTS.md](AGENTS.md) |
| Architecture decision record | `.scratch/ai-interpreter-workbench/` (wayfinder map + 14 resolved decision tickets + 8 implementation tickets) |
