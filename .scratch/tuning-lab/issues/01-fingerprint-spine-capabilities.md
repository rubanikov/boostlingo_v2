Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 01 — Fingerprint spine, capabilities endpoint, fingerprint chip

Type: task · Status: ready · Tier: **1** · Depends on: none

Size check: **right-sized (~3.5 hrs).**

## What to build

The tracer bullet: *open the app and read `cfg:7f3a9c21` off the navbar; change
`REALTIME_VAD_SILENCE_MS` in `backend/.env`, restart, watch the chip change.* UI → HTTP → backend,
with the hash computed identically in TypeScript and Python.

**Backend scope**
- `backend/app/tuning/__init__.py`, `schema.py` (pydantic mirror of `ClientTuning` /
  `RealtimeTuning` / `CascadeTuning` / `TuningConfig` / `ModeTuningConfig`, camelCase aliases +
  `populate_by_name` + `extra="ignore"`, brief "Data model changes"), `fingerprint.py`
  (`canonicalize()` + `fingerprint()` exactly per the brief's 6-step algorithm), `allowlists.py`
  (`REALTIME_MODELS`, `REALTIME_VOICES`, `DEEPGRAM_MODELS`, `TEXT_MODELS`, `elevenlabs_voices()`,
  `DEEPGRAM_CONNECTION_LEVEL_FIELDS`), `defaults.py` (effective `TuningConfig` from `settings` +
  provider constants).
- `backend/app/api/tuning.py` — **`GET /api/tuning/capabilities` only** (the transcript-check route
  is ticket 15). Returns `{schemaVersion, defaults, allowLists, stages}` exactly as in the brief.
  `stages` uses `importlib.util.find_spec` only — at this point all four report
  `installed: false` with their `reason` strings, which is honest (no extras exist yet).
  Per-stage exception caught → `{"installed": false, "reason": "<ExcClass>"}`; the route is `200`
  always. Registered in `backend/app/main.py`.
- `backend/app/config.py` — `cors_origins` default gains `http://localhost:5183`; new optional
  `elevenlabs_voice_ids_extra: list[str] = []`. Documented in `backend/.env.example`.
- Absorb (do **not** revert) the uncommitted `_turn_detection()` / `realtime_vad_*` work.

**Frontend scope**
- `frontend/src/pages/tuningConfig.ts` (+ `.test.ts`) — types, `TUNING_SCHEMA_VERSION`,
  `DEFAULT_TUNING_CONFIG`, `KNOB_METADATA` (mode, section, connection-level flag, range, step, wire
  field name), `projectMode()`, `canonicalize()` (hand-written emitter — **not**
  `JSON.stringify`), `fingerprint()`, `diff()`, `clampGateParams()`,
  `DEEPGRAM_CONNECTION_LEVEL_PATHS`, allow-list offline fallbacks.
- `frontend/src/pages/tuningCapabilities.ts` — `fetchCapabilities()` using the
  `VITE_API_BASE_URL` idiom duplicated in `cascadeConfig.ts` / `realtimeConfig.ts`.
- `frontend/src/pages/WorkbenchPage.tsx` — the fingerprint chip in `navbar-end`
  (`data-testid="tuning-fingerprint"`) and the one in the latency strip
  (`data-testid="tuning-fingerprint-latency"`), passed as a **plain prop**, rendered as a *sibling*
  of the existing badge content (never inside `realtime-latency-badge`, whose text the capture
  harness regexes with `/(\d+)\s*ms/`).

**Repo root**
- `shared/tuning-fingerprint-cases.json` — the cross-language parity fixture
  (`[{name, config, mode, expectedFingerprint}]`), read **byte-identically** by both test suites.

## Acceptance criteria

Story ACs: **1.12** (fingerprint visible, changes on any knob change, identical under key
reordering), **1.11** (server `.env`-derived defaults are published, not blanks — the display half
lands in 02).

Brief tests: **S1** (TS/Py fingerprint parity over every fixture case), **S2** (canonicalisation:
absent keys omitted, `false`/`0`/`""` kept, keys sorted, integral floats emitted without a decimal
point), **F14** *(backend half)* (`find_spec` → `None` ⇒ `stages.deepfilternet.installed == false`
with the `uv sync --extra denoise` reason), **E11** (a fabricated `schemaVersion: 2` changes every
fingerprint), **E15** (`http://localhost:5183` accepted by the WS origin guard).

Also green, unchanged: `backend/tests/test_realtime.py:127` and `:130-151`.

## Out of scope for this ticket

The panel itself; any knob editing; `POST /api/tuning/transcript-check`; real stage detection with
extras installed (16/17); any change to `POST /api/realtime/session` (04).
