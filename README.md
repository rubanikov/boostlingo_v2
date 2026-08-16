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
There is a narrated demo video, both modes on a real conversation plus the Tuning
panel walkthrough, at [demo/ai-interpreter-workbench-demo.mp4](demo/ai-interpreter-workbench-demo.mp4);
[demo/README.md](demo/README.md) explains how it is recorded from the live app and how
to regenerate it.

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
  - `REALTIME_VAD_SILENCE_MS` / `REALTIME_VAD_INTERRUPT_RESPONSE`: optional Realtime-mode
    server-VAD tuning; unset means OpenAI's defaults. COMPARISON.md §2 measures both
    settings (58% vs 94% acceptable on real speech) and explains the trade.

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

There are two optional extras, one per server-side denoise stage. Neither is needed to
run the app, and the whole test suite passes with or without them — a stage whose extra
is missing reports `installed: false` from `GET /api/tuning/capabilities`, the Tuning
panel disables that row with the install command as the reason, and the audio path is
left untouched.

```bash
uv sync --extra bench      # noisereduce + numpy  -> the "noisereduce" stage
uv sync --extra denoise    # torch, torchaudio, deepfilternet -> the "DeepFilterNet" stage
uv sync --extra bench --extra denoise    # both
```

`--extra denoise` is the large one: **CPU-only torch wheels are pinned** in
`backend/pyproject.toml` (`[[tool.uv.index]] pytorch-cpu` +
`[tool.uv.sources]`), because nothing here uses a GPU and the default PyPI wheels
bundle a CUDA runtime that would be gigabytes of nothing. It is still a ~200 MB
install, which is exactly why it is an extra and why core CI stays torch-free.
DeepFilterNet downloads its model weights on first use, so the first mic frame of the
first session that enables the stage takes a couple of seconds; the model is cached for
the life of the process after that.

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

## The Tuning panel

The **Tuning** button in the header opens a side panel listing every audio processing step
between the microphone and the provider, in signal order: microphone constraints, the
denoise chain (client-side RMS gate and RNNoise, the server-side stages, OpenAI's own
noise reduction), turn detection / endpointing, segmentation (Cascade only), transcript
check, and models & voices. Knobs that nothing sits behind are never shown, so the panel
doubles as the inventory of what is actually adjustable.

Changes are staged until you press **Apply**, and the button says which kind of apply you
are about to get: plain `Apply` for a knob that takes effect live, `Apply (reconnects STT)`
for one of Deepgram's connection-level settings, and `Apply at next connect` for the ones
that can only be set when a session is opened. Applying while disconnected commits locally
and is carried by the next `connect()`. Three built-in presets ship with it (`Provider
defaults`, `Tuned turn-taking`, `Max denoise`) and you can save your own.

Export writes the whole document, both modes, as a `TuningConfig` JSON file; Import reads
one back. That file is the same artifact the benchmark harnesses below take, which is what
makes a measured row reproducible: every config hashes to a **fingerprint** (`cfg:` plus
eight hex digits), shown on a chip in the app and stamped on every row the harnesses emit.
Backend and frontend compute it independently and are held byte-compatible by a shared
golden fixture (`shared/tuning-fingerprint-cases.json`) that both test suites read.

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

### Benchmark harnesses (noisy corpus + tuning sweep)

Neither of these is part of `pytest`: they're manual-tier harnesses that produce the
numbers in [COMPARISON.md](COMPARISON.md) §7. Run from `backend/`.

```bash
# 0. Optional: the denoise extras. Without them the server-side stages report "not
#    installed" in the Tuning panel and pass audio through untouched; the core suite
#    deliberately runs without either. Sweeping a config that enables a stage whose
#    extra is missing measures the unfiltered audio, so install what you sweep.
uv sync --extra bench --extra denoise

# 1. Build the noisy corpus: each clean fixture mixed with babble/street/fan/white
#    noise at 20, 10 and 5 dB SNR. No API key, no network, deterministic from --seed.
uv run python -m tests.fixtures.make_noisy_corpus

# 2. Score one or more TuningConfig files against it (needs a live DEEPGRAM_API_KEY).
uv run python -m tests.fixtures.run_tuning_sweep --config configs/a.json --config configs/b.json
```

That sweep is the Cascade half. The Realtime half runs the same config through a live
session instead: `cd frontend && npm run capture:realtime-quality -- --tuning configs/a.json`
imports the config through the app's Tuning panel before each clip, stamps its fingerprint
on every capture, and `uv run python -m tests.fixtures.run_realtime_quality_report` carries
that fingerprint into the judged report and its COMPARISON §7 rows.

The sweep writes `tests/fixtures/tuning_sweep.json` (git-ignored) and prints paste-ready
COMPARISON §7 rows. It replays audio in real time, so it refuses more than 200 rows
without `--yes` and prints an estimated wall-clock instead; narrow it with
`--limit`/`--only`/`--conditions`/`--snr`. Re-running the same command resumes — rows
already in `--out` are not measured twice. Export a config from the app's Tuning panel,
or hand-write one; `tests/fixtures/noisy/SCRIPT.md` explains what each noise condition
is and why the audio isn't committed.

The panel's model and voice pickers are curated server-side allow-lists served by `GET
/api/tuning/capabilities` (never free text): a config naming anything outside them is
rejected with a 400 by the Realtime route and falls back to the default, with a log line,
on the Cascade WebSocket — add further TTS voice ids with a comma-separated
`ELEVENLABS_VOICE_IDS_EXTRA` in `backend/.env`.

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
| Backend app code | `backend/app/` (`api/` routes, `providers/` vendor boundaries, `orchestrator.py` for Cascade's pipeline, `quality/` for Ticket 8's LLM-judge, `tuning/` for the tuning document's schema, defaults, allow-lists and fingerprint) |
| Backend tests | `backend/tests/` (pytest); shared quality dataset + fixture/report/benchmark scripts at `backend/tests/fixtures/` |
| Frontend app code | `frontend/src/pages/` (`WorkbenchPage.tsx` is the one page for both modes, plus the Tuning panel and shared session/latency/audio logic); audio worklets in `frontend/public/` |
| Frontend tests | co-located `*.test.ts(x)` (Vitest) + `frontend/e2e/` (Playwright) |
| Cross-language fixtures | `shared/` (the fingerprint golden cases both suites read) |
| Comparison write-up | [COMPARISON.md](COMPARISON.md) |
| Agent-usage notes | [AGENTS.md](AGENTS.md) |
| Architecture decision record | `.scratch/ai-interpreter-workbench/` (wayfinder map + 14 resolved decision tickets + 9 implementation tickets); `.scratch/tuning-lab/` (the tuning lab's research, story, brief, 18 tickets and build log) |
