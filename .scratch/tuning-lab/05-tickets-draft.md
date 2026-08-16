# Audio Tuning & Denoise Lab — ticket breakdown (DRAFT)

(ticket-slicer output, feature-factory Step 8, 2026-08-15. Status: **DRAFT pending Step 9 gate**.
Nothing is published as an issue file yet — this single file is the whole deliverable.)

Sliced from the approved chain: `00-idea-brief.md` (locked decisions, priority tiers 1–6) →
`02-story.md` (5 sub-stories, 42 ACs, Step 3 gate) → `03-wireframe-notes.md` (Step 5 gate) →
`04-brief.md` (the contract: `TuningConfig` schema, fingerprint algorithm, API changes, reconnect
flow, frontend design, benchmark flow, tests S1–S31 / F1–F17 / E1–E16, "Files that will change",
Step 7 gate). Format mirrors the previous run's `.scratch/ai-interpreter-workbench/tickets/`.

**18 vertical tickets, ≈56.5 hrs.** Every ticket cuts UI → transport → backend (or
harness → JSON → printed table). Three tickets are deliberately single-sided; each says why.

---

## The cut protocol (read this before cutting anything)

Tiers are cut from the bottom (locked decision 7). A cut must not leave a dead control in the panel,
because locked decision 11 makes the panel the single inventory of processing steps. So:

> **Cutting a ticket flips the knob rows it owns to the panel's `disabled` + visible-reason
> treatment — the same treatment ticket 02 already ships for Demucs / DNS64 ("benchmark only") and
> for the not-installed server denoise stages.** No knob is ever rendered live with nothing behind
> it, and no seam is left half-built.

That treatment is built once, in ticket 02, precisely so every later tier can be dropped cheaply.

---

## Waves (parallel frontier)

```
Wave 0 (start now, parallel):   [01] Fingerprint spine + capabilities      [08] Noisy corpus
                                     + fingerprint chip                          generator
                                          |                        \                 |
Wave 1:                              [02] Tuning panel shell         `------.        |
                                          |                                  \       |
                                          |                              [09] Cascade sweep runner
                                     _____|_____________                       + COMPARISON §7
                                    /      |            \
Wave 2 (parallel):        [03] Persist  [04] Realtime   [06] Cascade start-of-session
                          presets I/O        start          + non-connection-level apply
                                 |    \      |    \             |          \        \
                                 |     \     |     \            |           \        \
Wave 3 (wide, parallel):   [10] Capture  [05] Realtime    [07] Cascade   [11] Mic   [14] Cascade
                             --tuning      live apply      reconnect     constraints  transcript
                                                           + dialog          |          check
                                                                             |            |
                                          [16] Server denoise chain          |            |
                                          [18] Model/voice pickers           |            |
                                                     |                       |            |
Wave 4:                          [17] DeepFilterNet  |          [12] RMS gate + Realtime   |
                                          + torch extra              client-DSP plumbing   |
                                                                             |     [15] Realtime
Wave 5:                                                              [13] RNNoise      flag endpoint
```

Critical path: **01 → 02 → 06 → 07** (tier 1 complete) and **01 → 02 → 04 → 12 → 13** (tier 3
complete). Tier 2 (08 → 09, and 10) runs almost entirely off the critical path — 08 has **no
dependencies at all** and can start on day one alongside 01.

---

## Tickets

| # | Title | Tier | Depends on | Size | Sizing |
|---|-------|------|-----------|------|--------|
| 01 | Fingerprint spine, `/api/tuning/capabilities`, fingerprint chip | 1 | none | ~3.5 hrs | Right-sized |
| 02 | Tuning panel shell: sections, knob primitives, Apply/Revert, disabled inventory rows | 1 | 01 | ~3.5 hrs | Right-sized |
| 03 | Persistence, presets, export/import, reset | 1 | 02 | ~3 hrs | Right-sized |
| 04 | Realtime start-of-session tuning (+ OpenAI `noise_reduction`) | 1 | 01, 02 | ~4 hrs | Right-sized |
| 05 | Realtime live apply (`session.update`, deferral, coalescing) | 1 | 04 | ~2.5 hrs | Right-sized |
| 06 | Cascade start-of-session tuning + non-connection-level live apply | 1 | 01, 02 | ~4.5 hrs | Right-sized |
| 07 | Cascade connection-level apply: deliberate Deepgram reconnect + failure dialog | 1 | 06 | ~4.5 hrs | Right-sized |
| 08 | Noisy corpus generator + manifest | 2 | none | ~2.5 hrs | Right-sized |
| 09 | Cascade tuning sweep runner + paste-ready table + COMPARISON §7 | 2 | 01, 08 | ~3.5 hrs | Right-sized |
| 10 | Realtime capture harness `--tuning` + fingerprint through the report | 2 | 01, 02, 03, 04 | ~2 hrs | Right-sized |
| 11 | Microphone constraint toggles, both modes | 3 | 04, 06 | ~1.5 hrs | Right-sized |
| 12 | RMS noise gate + Realtime client-DSP re-plumbing | 3 | 05, 06, 11 | ~4 hrs | Right-sized |
| 13 | RNNoise (48 kHz contexts, 3:1 decimator) | 3 | 12 | ~3.5 hrs | Right-sized |
| 14 | Cascade transcript check: off / flag / correct | 4 | 06 | ~3.5 hrs | Right-sized |
| 15 | Realtime transcript check `flag` via `POST /api/tuning/transcript-check` | 4 | 04, 05, 14 | ~2 hrs | Right-sized |
| 16 | Server denoise chain: protocol + noisereduce + capability gating | 5 | 02, 06 | ~3.5 hrs | Right-sized |
| 17 | DeepFilterNet stage + optional `denoise` torch extra | 5 | 16 | ~2.5 hrs | Right-sized |
| 18 | Model / voice pickers wired through both transports + allow-list validation | 6 | 02, 04, 06 | ~2.5 hrs | Right-sized |

Every ticket is inside the 1.5–4.5 hr band. **No ticket is Too thin or Too thick.** Two sit at the
top of the band (06, 07) and are flagged individually below with the reason they are not split.

---

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

---

# Ticket 02 — Tuning panel shell: sections, knob primitives, Apply/Revert

Type: task · Status: blocked · Tier: **1** · Depends on: 01

Size check: **right-sized (~3.5 hrs).**

## What to build

The panel as a shell you can open, scroll, mode-switch, and press Apply in — with the section
skeleton and the disabled inventory rows that make it the single inventory (locked decision 11), and
the pending/disabled/failure treatments that every later ticket reuses. **Later tickets add their
own knob rows to their own sections** — that is what keeps them vertical and what makes the cut
protocol work.

**Frontend scope**
- `frontend/src/pages/TuningPanel.tsx` (+ `.test.tsx`) — the `<aside id="tuning-panel">` per
  wireframe §5: header (title + mode badge + applied fingerprint chip + close), **six**
  `<details class="collapse collapse-arrow bg-base-200 rounded-box">` sections in signal order with
  their summary status chips, sticky footer (`Apply` / `Revert` / `role="status" aria-live="polite"`
  line). Split `TuningSection.tsx` out **only if** the file exceeds ~400 lines (wireframe §2).
- Knob primitives: `KnobRow`, `RangeKnob` (always paired with a numeric readout), `NumberKnob`,
  `SegmentedKnob` (real radios in `role="radiogroup"`), `ProviderDefaultKnob` (the checkbox that
  means *the key is omitted entirely*).
- The three-layer **pending treatment** (amber inset left rule + amber dot + `was: <value>` badge)
  and the `reconnects` ghost chip, plus the two **disabled variants** (`not installed` +
  `uv sync --extra denoise` hint; `benchmark only`) — built once here, reused by every later ticket.
- **Disabled inventory rows shipped now**: Demucs, denoiser (DNS64) (`benchmark only`, permanently
  disabled), DeepFilterNet and noisereduce in their `not installed` variant driven by
  `capabilities.stages`. Wave-U-Net is **absent entirely** (story AC 5.5 — verified by absence).
- Models & voices section: curated `select`s populated from `capabilities.allowLists`, **no free
  text** (behaviour wiring is ticket 18).
- Transcript check section: the `off | flag | correct` `join`, with `correct` rendered
  `btn-disabled` + visible explanatory line in Realtime (behaviour is 14/15).
- `frontend/src/pages/useTuningConfig.ts` (+ `.test.ts`) — `draft`, per-mode `applied`, derived
  `pending = diff(applied[mode], projectMode(draft, mode))`, capabilities fetch with **skeleton**
  and **fallback-to-`DEFAULT_TUNING_CONFIG`** states, `applyState: 'idle' | 'applying' | 'failed'`
  + `attempt`. Apply while disconnected commits `draft → applied` locally, stamps a new fingerprint
  and clears pending (wireframe §4 — Apply stays **enabled** while disconnected).
- `WorkbenchPage.tsx` — the `Tuning` toggle in `navbar-end` **before** the connection badge, with
  `aria-expanded` / `aria-controls="tuning-panel"` and the `{n} pending` badge; transcript grid
  drops to one column while open; main column becomes `flex-1 min-w-0`; Escape closes and returns
  focus to the toggle; opening does **not** steal focus.
- All `data-testid`s from wireframe §8 for everything rendered here; all copy verbatim from
  wireframe §7.

**Backend scope**: None. **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.1** *(section skeleton + the inventory rows; the remaining knob rows arrive with
tickets 04, 06, 11, 12, 13, 14, 15, 16, 17, 18 — AC 1.1 is verified complete at the end of the
run)*, **1.11** (display half), **1.13** (mode-scoped rendering, nothing copied across),
**5.4** (offline stages visible, disabled, tagged `benchmark only`), **5.5** (Wave-U-Net absent),
**5.6** (pickers are fixed lists, no free-text entry).

Brief tests: **S3**, **S13**, **S14**, **S25** *(rendering half: Cascade offers off/flag/correct,
Realtime renders `correct` disabled)*, **S30** *(component half)*, **S31**, **F13** (capabilities
fetch failure → `DEFAULT_TUNING_CONFIG` + all server denoise rows `not installed`),
**F14** *(component half)*, **E5** (Apply while disconnected commits, persists intent, clears
pending). Accessibility per wireframe §9 in full.

## Out of scope for this ticket

localStorage / presets / export / import (03); any transport call (`applyTuning` is not wired here —
the footer button commits locally only); the Turn detection, Endpointing, Segmentation, Microphone,
RMS gate and RNNoise **rows** (they arrive with the tickets that make them do something).

---

# Ticket 03 — Persistence, presets, export / import, reset

Type: task · Status: blocked · Tier: **1** · Depends on: 02

Size check: **right-sized (~3 hrs).**

> **Single-sided by necessity, and allowed.** Locked decision 10 and story AC 1.8 explicitly forbid
> server-side config storage — there is no backend half of this story part to build. It is still a
> complete, human-exercisable slice: set knobs → save a preset → export JSON → reload → import →
> identical fingerprint.

## What to build

**Frontend scope**
- `frontend/src/pages/tuningPresets.ts` (+ `.test.ts`) — `BUILT_IN_PRESETS`
  (`Provider defaults`, `Tuned turn-taking`, `Max denoise`); read/write for
  `boostlingo.tuning.v1` (`{schemaVersion, draft, applied: {cascade, realtime}}`) and
  `boostlingo.tuning.presets.v1`; schema-version handling (missing/≠1 ⇒ discard the entry with a
  `console.warn` and fall back to server defaults; unknown keys dropped with a warning; missing keys
  filled from server defaults).
- `useTuningConfig.ts` — the persistence effect, preset select/apply, `Save as…` inline name input,
  `Export`, `Import` (file or paste), `Reset to defaults` (restores the **server** defaults, not a
  preset), `Preset modified` marker, and the retired-model fallback.
- `TuningPanel.tsx` header wiring: `tuning-preset`, `tuning-preset-name`, `tuning-preset-save`,
  `tuning-export`, `tuning-import`, `tuning-import-file`, `tuning-reset`.
- `tuningConfig.ts` gains `parseImported()` and `migrate()`.

**Backend scope**: None (by design). **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.8** (survives reload; nothing stored server-side), **1.9** (built-in presets set every
knob in one action; a user preset survives reload), **1.10** (export → import round-trips exactly).

Brief tests: **S10**, **S11**, **S12**, **F10** (malformed JSON → inline
`That file isn't a valid tuning config.`, draft untouched), **F11** (unknown keys → known keys
imported + `Imported. Ignored {n} unknown field(s): {names}.`), **F12** (retired model id →
`{model} is no longer available — using {default}.`), **E13** *(unit half: the "Max denoise" preset
produces a valid config with a distinct fingerprint)*.

## Out of scope for this ticket

Server-side or account preset storage (permanently out of scope); any transport behaviour.

---

# Ticket 04 — Realtime start-of-session tuning (+ OpenAI `noise_reduction`)

Type: task · Status: blocked · Tier: **1** (carries the `noise_reduction` knob from tier 3 — see
note) · Depends on: 01, 02

Size check: **right-sized (~4 hrs).**

> **Tier-3 rider, stated explicitly:** OpenAI `noise_reduction` is a tier-3 knob (story AC 3.6) but
> it is one more key in the *same* `session.audio.input` payload this ticket already builds and
> validates. Splitting it out would mean touching the same mapping function, the same test file and
> the same panel section twice. It rides along here. If tier 3 is cut, this knob stays (it costs
> nothing) — only the *client-side* stages (11, 12, 13) go.

## What to build

**Backend scope** (`backend/app/api/realtime.py`)
- `RealtimeSessionRequest` gains the optional nested `tuning: ModeTuningConfig` — nested, so the wire
  document is byte-identical to what `fingerprint()` hashes.
- `_turn_detection()` becomes `_turn_detection(tuning: RealtimeTuning | None)`. **With `tuning=None`
  it behaves exactly as today** (reads `settings.realtime_vad_*`) — that is what keeps
  `test_realtime.py:127` and `:130-151` green unchanged. With `tuning` present the request is
  authoritative and `.env` is **not** merged in.
- Mapping per the brief's table: `model` → `session.model`; `voice` →
  `session.audio.output.voice`; `turnDetection.type` always present; `threshold` /
  `prefixPaddingMs` / `silenceDurationMs` only if not `None` **and** `type == "server_vad"`;
  `eagerness` only if not `None` **and** `type == "semantic_vad"`; `interruptResponse` if not
  `None`. `noiseReduction`: absent ⇒ **no key**; `"off"` ⇒ `"noise_reduction": null`; else
  `{"type": "<value>"}`. `client.*` and `transcriptCheck` are **not** sent to OpenAI but are echoed
  and hashed.
- Validation → **explicit `HTTPException(400)` naming the field, before any OpenAI call**, for all
  eight rules in the brief's table (schemaVersion, model, voice, threshold range, prefixPadding /
  silenceDuration ranges, `eagerness` with `server_vad`, `correct` in Realtime, transcript-check
  model). Language validation must still run **first** — `assertServersUp()` in the capture harness
  probes with `sourceLanguage: 'zz'` and expects that exact 400.
- `RealtimeSessionResponse` gains `fingerprint` + `appliedTuning` (camelCase; the four existing
  snake_case fields are untouched because they mirror OpenAI's own names).
  `appliedTuning` preserves the absent-key idiom so
  `fingerprint(appliedTuning) == fingerprint(request.tuning)`.

**Frontend scope**
- `TuningPanel.tsx`: the **Turn detection (Realtime)** section rows — `server_vad | semantic_vad`
  radios, `threshold`, `prefixPaddingMs`, `silenceDurationMs`, `interruptResponse`, `eagerness`
  (greyed with a `semantic_vad only` note while `server_vad` is selected), each with its
  `Provider default` checkbox; plus the **OpenAI noise reduction** segmented control in the Denoise
  chain (`Realtime only` chip when in Cascade). Closing note: a greyed field omits the key.
- `sessionHandle.ts`: `connect: (languages, tuning?) => void`, `appliedFingerprint?: string | null`
  (the `applyTuning?` member arrives in 05).
- `useRealtimeSession.ts`: sends `tuning` in the session POST body; stores the server's
  `fingerprint` / `appliedTuning` as the authoritative applied config.
- `WorkbenchPage.tsx`: passes `appliedForMode` at **all three** `connect()` call sites (mic button,
  error-banner Try again, mode-switch reconnect).

## Acceptance criteria

Story ACs: **1.2** (panel values reach `session.audio.input.turn_detection`), **1.3** (unset stays
unset — key absent from the outbound payload), **3.6** (`noise_reduction` mapping incl. the
three-state + absent semantics), **5.7** *(HTTP half: 400 for out-of-allow-list model/voice)*.

Brief tests: **S4**, **S5**, **F1**, **F2**, **F3**, **F5** *(HTTP half: `schemaVersion: 2` → 400)*.

## Out of scope for this ticket

`session.update` / live apply (05); model & voice **pickers** as UI (18 — the allow-list *validation*
lands here because the schema already carries the fields); the Cascade side (06).

---

# Ticket 05 — Realtime live apply

Type: task · Status: blocked · Tier: **1** · Depends on: 04

Size check: **right-sized (~2.5 hrs).**

> **Single-sided by design, and allowed.** Brief §2 is explicit: *"Live apply — Realtime
> (client-only, no backend involvement)"*. The backend sees nothing after minting the token. Adding
> a backend leg here would be inventing a seam the transport does not have.

## What to build

**Frontend scope**
- `sessionHandle.ts`: `applyTuning?: (config: ModeTuningConfig) => Promise<ApplyResult>` (the
  documented optional-member extension pattern, already used 5×), plus the `ApplyResult` union.
- `useRealtimeSession.ts`:
  - `pc.createDataChannel('oai-events')` gains
    `onopen = () => { dcReadyRef.current = true; flushPendingTuning(); }`; **never `send()` unless
    `readyState === 'open'`** (it is receive-only today).
  - `applyTuning(config)`: if a reply is streaming (between
    `response.output_audio_transcript.delta` and `response.done` + `REALTIME_MUTE_TAIL_MS`) **or**
    the channel isn't open → store in a **single** `pendingTuningRef` slot and return
    `{ok: true, deferred: true}` (last write wins ⇒ **rapid Applies coalesce for free**);
    otherwise send exactly the GA `session.update` shape from the brief (`session.type: "realtime"`,
    only `audio.input` present, absent-key idiom preserved, `"off"` ⇒ `noise_reduction: null`).
  - `response.done`'s existing unmute timeout **and** `dataChannel.onopen` both call
    `flushPendingTuning()`.
  - `model` / `voice` rows are marked **"applies at next connect"** — they are not live-updatable.
- `useTuningConfig.ts` / footer: `Applying…` spinner state, `Applied · cfg:… · HH:MM:SS`,
  `Applying after the current reply…` deferred status.
- `frontend/src/test/mockRealtimeApis.ts`: `MockRTCDataChannel` gains `readyState` and `emitOpen()`.

**Backend scope**: None (by design). **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.5** (a `session.update` with the new value goes out on `oai-events`, the session is
**not** torn down, the panel shows it applied).

Brief tests: **S7**, **E2** (Apply during a streaming reply is queued and fires after
`response.done` + `REALTIME_MUTE_TAIL_MS`), **E3** (Apply while the channel is `connecting` is
flushed by `onopen`).

## Out of scope for this ticket

Anything Cascade; the failure dialog (Realtime `session.update` cannot fail the way a Deepgram
reconnect can — the dialog belongs to 07).

---

# Ticket 06 — Cascade start-of-session tuning + non-connection-level live apply

Type: task · Status: blocked · Tier: **1** · Depends on: 01, 02

Size check: **right-sized (~4.5 hrs, top of the band).** Not split further: the halves would be
`DeepgramParams`-refactor-only and `panel-rows-only`, both of which are layer slices with nothing a
human can exercise. The `_SessionTuning` object and the `update_tuning` branch are the same edit.

## What to build

**Backend scope**
- `backend/app/providers/deepgram_stt.py`: `@dataclass(frozen=True) DeepgramParams` **whose defaults
  are today's module-level `Final` constants**, `from_tuning()`, `stream(..., params=None)`,
  `_url(params)`. **The constants stay** — which is why `test_providers.py:291-320`'s URL-substring
  assertions pass unchanged. *(That is a design constraint, not luck.)*
- `backend/app/orchestrator.py`:
  - `_SessionTuning` (`current` / `previous` / `pending` / `request_id` / `reconnecting`),
    **constructed inside `_start_new_session`** alongside the four providers. **Never mutate the
    module-level constants** — doing so would silently re-parameterise every other concurrent
    session's STT connection. This is the single sharpest hazard in the feature.
  - `_parse_cascade_tuning()` — **tolerant** per the documented asymmetric posture: a field that
    fails to parse or falls outside its allow-list/range keeps the current value and logs a warning.
    The WS never 400s and never closes on a bad tuning field.
  - `start_session` accepts `tuning`; the legacy top-level `segmentationMode` stays supported for
    `?segMode=`, and `tuning.cascade.segmentation.mode` **wins** when both are present.
  - Unsolicited `tuning_applied{requestId: null, fingerprint, reconnectedStt: false}` sent
    immediately after `session_started`.
  - `_pump_client_messages` gains the `update_tuning` branch; **non-connection-level** changes
    (segmentation mode/model, transcript-check mode/model, translation model, TTS voices, server
    denoise params) assign `tuning_state.current = new` and reply `tuning_applied{reconnectedStt:
    false}` immediately — these are read *per segment* or *per frame*, so the next one picks them up.
  - `tuning_failed` message shape defined, drawing `message` from the existing
    `_CLIENT_ERROR_MESSAGES` map (raw provider text never reaches the browser).

**Frontend scope**
- `TuningPanel.tsx`: the **Endpointing (Cascade)** section (`endpointingMs`, `utteranceEndMs`,
  `diarize`, summary carrying the `reconnects STT` chip) and the **Segmentation** section
  (`hybrid | llm_priority` join + segmentation model select).
- `useCascadeSession.ts`: `tuning` inside `start_session` (strictly the first message);
  `applyTuning()` sending `{type:"update_tuning", requestId, tuning}`; handling `tuning_applied` /
  `tuning_failed`; the **client-side playback deferral** — hold the config in one `pendingTuningRef`
  slot while `isPlaybackActiveRef.current` is true, flush when playback clears, status line
  `Applying after the current reply…`. Same slot coalesces rapid Applies before they hit the wire.

## Acceptance criteria

Story ACs: **1.4** (start-of-session values observable in the Deepgram connection URL under test),
**1.6** (non-connection-level live apply: no Deepgram restart, effective for the next segment),
**5.7** *(WS half: fall back to the default and log, never kill the session)*.

Brief tests: **S6**, **S8**, **F4**, **F5** *(WS half)*, **E1** (Apply during Cascade TTS playback is
accepted, queued, sent once playback clears — nothing on the wire while `isPlaybackActiveRef` is
true), **E16** (unknown `update_tuning` fields ignored; unknown server message type warned-and-
ignored client-side), plus new `test_providers.py` cases for non-default `DeepgramParams`.

## Out of scope for this ticket

The deliberate reconnect and everything around it (07); the denoise chain in `audio_iter` (16); the
transcript check in `_process_segment` (14).

---

# Ticket 07 — Cascade connection-level apply: deliberate Deepgram reconnect + failure dialog

Type: task · Status: blocked · Tier: **1** · Depends on: 06

Size check: **right-sized (~4.5 hrs, top of the band, and the riskiest ticket in the run).** Not
split: the backend sentinel and the client's dialog/status states are one user-visible behaviour
("press Apply, watch the badge go amber, watch the transcript survive"), and splitting produces a
backend-only and a frontend-only half with nothing exercisable in either. If it overruns, the
natural spill-out is the failure `<dialog>` (F7) — **not** the frame-preservation work.

## What to build

**Backend scope** (`backend/app/orchestrator.py`)
- `_RECONNECT` sentinel: `_handle_update_tuning` sets `tuning_state.pending = new`,
  `request_id`, then `audio_queue.put_nowait(_RECONNECT)` — an ordinary object in FIFO order behind
  every already-enqueued frame. A second `update_tuning` before the reconnect completes just
  overwrites `pending`; a fresh sentinel is enqueued **only if `pending` was `None`**, so two
  Applies 200 ms apart produce **exactly one** reconnect with the later config.
- `audio_iter()` gains one line: popping `_RECONNECT` `return`s, ending *this* stream's iterator
  only. Frames after the sentinel stay in the queue, in order.
- `_run_stt`'s `StopAsyncIteration` branch gains the `tuning_state.pending is not None` path: park
  any in-flight clause check (`_park_stale`), **flush a non-empty buffer via
  `_cut_segment(..., trigger="tuning_reconnect", ...)`**, rotate
  `previous / current / pending`, set `reconnecting = True`, `continue` the existing outer
  `while True` so a fresh `audio_iter()` over the **same `audio_queue`** is streamed with
  `DeepgramParams.from_tuning(...)`. On the first result from the new connection, send
  `tuning_applied{reconnectedStt: true}`.
- Failure path in the existing `except ProviderError` handler: **every** failed attempt logs
  (`logger.warning("tuning reconnect attempt %d/%d failed …")`) **and** emits
  `tuning_failed{requestId, attempt, maxAttempts, message}`.
  `maxAttempts = 1 + len(retry_backoffs(exc))` — reuses `_resilience.py`'s existing 3-attempt /
  0.5-1-2 s budget, **no new retry mechanism**. On exhaustion: **revert** to `previous` and keep the
  session running. If the reverted reconnect also fails, fall through to today's terminal path
  unchanged.

> **Do not "simplify" the sentinel into `asyncio.wait({queue.get(), event.wait()})`.** That drops an
> item when the losing `get()` is cancelled after a `put_nowait` has handed it one. The
> sentinel-in-the-queue design is what makes "no frame is lost" true.

**Frontend scope**
- `useCascadeSession.ts`: `tuning_failed` → `console.warn` per attempt (the gate addendum requires
  logging on **both** sides), attempt counter surfaced through `ApplyResult`.
- `TuningPanel.tsx` / `useTuningConfig.ts`: the `Apply (reconnects STT)` label + per-row `reconnects`
  chips (driven by `DEEPGRAM_CONNECTION_LEVEL_PATHS`), reuse of the existing
  `CONNECTION_BADGE.reconnecting` amber badge, the
  `Reconnecting STT with the new parameters… (attempt {i} of {n})` status line, and the
  `role="alertdialog" aria-modal="true"` failure `<dialog>` (`tuning-apply-failed-dialog`,
  `tuning-apply-retry`, `tuning-apply-revert`) with the attempt log, no dismiss-by-backdrop, focus
  trapped and restored to `tuning-apply`.
- `segmentation.ts`: `'tuning_reconnect' → 'reconfig'` in `segmentTriggerLabel`.

## Acceptance criteria

Story ACs: **1.7** (every frame sent before, during and after the reconnect appears in the
transcript — no frame dropped, no segment lost), plus the **Step 3 gate addendum** (no confirmation
dialog; reconnect immediately; existing reconnecting badge; log every failure both sides; dialog with
Retry / Revert after the retry budget).

Brief tests: **S9** (two fake sockets: first got A,B, second got C,D, none dropped or duplicated,
second URL carries the new params), **F6**, **F7**, **E4** (two Applies 200 ms apart ⇒ exactly one
reconnect with the later config), **E6** (the in-flight partial is cut with
`trigger: "tuning_reconnect"` and appears; nothing double-cut).

## Out of scope for this ticket

Anything that isn't a Deepgram connection-level parameter (06 handles those).

---

# Ticket 08 — Noisy corpus generator + manifest

Type: task · Status: ready · Tier: **2** · Depends on: none

Size check: **right-sized (~2.5 hrs).**

> **Harness-only vertical, and allowed:** script → WAVs + manifest JSON → printed summary table.
> There is no UI or transport side to this story part. Zero dependencies — start it in wave 0.

## What to build

**Harness scope**
- `backend/tests/fixtures/make_noisy_corpus.py` — for each of the 33 clean items produce variants
  for **babble** (several overlaid TTS speakers, same and other language), **street**, and
  **fan/white**, each at **20 / 10 / 5 dB SNR**, all mono 16-bit 16 kHz, via RMS-matched mixing with
  a fixed `seed`. Uses the stdlib `wave` module (matching `stt_replay.py` and the harness's
  hand-written WAV header) — **no `soundfile`**.
- `backend/tests/fixtures/noisy/noisy_manifest.json` writer with the exact shape from the brief
  (`generatedAt` UTC, `seed`, `sampleRate`, per-item `condition` / `snrDb` / `measuredSnrDb` /
  `peakScale` and the inherited reference text/translation and language pair).
- `backend/tests/fixtures/noisy/SCRIPT.md` — how to regenerate, what each condition is, why the audio
  is not committed.
- `.gitignore` gains `backend/tests/fixtures/noisy/*.wav` and `noisy_manifest.json` (the existing
  "generated audio is not committed, the script + SCRIPT.md are" convention).
- Prints a summary table of what it generated (items × conditions × SNRs, measured SNR spread).

**Backend scope**: None. **Frontend scope**: None.

## Acceptance criteria

Story ACs: **2.1** (the full variant set, mono/16-bit/16 kHz, audio git-ignored, script + SCRIPT.md
committed), **2.8** *(partial: per-item skip rather than failing the run)*.

Brief tests: **S15** (measured SNR of each output within ±0.5 dB of its label, asserted on a
synthetic 1 s tone — **no real corpus needed to run the test**), **F16** (a missing or wrong-format
corpus WAV → per-item skip with the printed `ffmpeg` conversion command, run exits 0).

## Out of scope for this ticket

Running anything through STT (09); the Realtime half (10); any `TuningConfig` awareness — this script
only makes audio.

---

# Ticket 09 — Cascade tuning sweep runner + paste-ready table + COMPARISON §7

Type: task · Status: blocked · Tier: **2** · Depends on: 01, 08

Size check: **right-sized (~3.5 hrs).**

> Harness-only vertical: config JSON + corpus → `tuning_sweep.json` → printed markdown table.

## What to build

**Harness scope**
- `backend/tests/fixtures/stt_replay.py`: add
  `transcribe_wav_detailed(..., tuning=, offline_stages=) -> ReplayResult`; `transcribe_wav`
  delegates and **keeps returning `str`** so existing callers are untouched.
- `backend/tests/fixtures/run_tuning_sweep.py` — the runner: `--config` (repeatable), `--limit`,
  `--only`, `--conditions`, `--snr`, `--out`, `--yes`; one row per (item, condition, SNR) carrying
  the **fingerprint** (computed by `backend/app/tuning/fingerprint.py`, not re-implemented);
  `wer`, `correctedWer` (column defined here, populated by 14), `addedLatencyMs`,
  `providerLatencyMs`, `status`, `skipReason`; **resume by skipping rows already present in
  `--out`**; `_MAX_ROWS_WITHOUT_CONFIRM = 200` refusal with an estimated wall-clock; a
  `condition: "clean", snrDb: null` row per item in **every** run; `offline_stages` honoured
  (applied to the whole WAV before replay) even though the panel shows them disabled.
- Paste-ready markdown table: one row per fingerprint, following the existing `COMPARISON.md`
  row-printing convention.
- `COMPARISON.md` gains **§7 Tuning-config comparisons** as a skeleton: the table
  (`fingerprint / mode / condition / SNR / WER / corrected WER / judge acceptance / added latency /
  provider latency`), a "what each fingerprint is" list, and the exact reproduce commands — following
  the existing per-table provenance convention. *(Prose stays human-written — out of scope by story.)*
- `.gitignore` gains `backend/tests/fixtures/tuning_sweep*.json`. `README.md` documents the command.

**Backend scope**: None beyond importing the tuning package. **Frontend scope**: None.

## Acceptance criteria

Story ACs: **2.2**, **2.5** (clean baseline always shown), **2.6** (paste-ready markdown +
COMPARISON.md section), **2.7** (added latency reported **separately** from provider latency — this
is where AC 2.7 is satisfied; there is deliberately **no live per-frame readout** in the UI),
**2.8** (real-recording manifest absent → friendly message, exit 0).

Brief tests: **S16**, **S19**, **S20**, **S30** *(sweep half: a config naming Demucs/DNS64 is
honoured)*, **F17**, **E12** (over-cap refusal + estimated wall-clock), **E14** (manifest present but
every file missing → zero-result report, exit 0).

Noisy-variant runs are **report-only** — `WER_THRESHOLD = 0.20` in `test_quality_wer.py` stays a
clean-corpus assertion and is not touched (Step 3 gate answer 2).

## Out of scope for this ticket

The Realtime half (10); the actual denoise stage implementations (16/17) — the runner calls whatever
`build_denoise_chain` returns, which is `[]` until then.

---

# Ticket 10 — Realtime capture harness `--tuning` + fingerprint through the report

Type: task · Status: blocked · Tier: **2** · Depends on: 01, 02, 03, 04

Size check: **right-sized (~2 hrs).**

> Kept separate from 09 rather than merged: different language (Node/Playwright vs Python), different
> files, and 09 is already at 3.5 hrs. Merging would produce a Too-thick ticket.

## What to build

**Harness scope**
- `frontend/e2e/realtime-quality-capture.mjs`: `--tuning <file>` in the arg parser; before Connect,
  the harness **imports the whole config through `tuning-import` / `tuning-import-file`** (rather
  than driving 30 controls — this is exactly why that testid exists), then scrapes the applied
  fingerprint from `tuning-fingerprint-latency`; stamps `fingerprint` and `tuningFile` on the output
  envelope and `fingerprint` on **every item**.
- Must still pass `assertServersUp()` — it probes with `sourceLanguage: 'zz'` and expects that 400;
  ticket 04's new validation must not change that error's text or precedence.
- `backend/tests/fixtures/run_realtime_quality_report.py`: `_identity()`, the summary block and the
  printed COMPARISON row all gain the fingerprint.

**Backend scope**: None. **Frontend scope**: None (it consumes ticket 02/03's testids).

## Acceptance criteria

Story ACs: **2.3** (the config is applied in the UI before connecting; captures carry the
fingerprint), **2.4** (every result row and the summary block carry the fingerprint; WER, judge
acceptance and end-to-end latency reported).

Brief tests: **S17** (e2e smoke, no live keys — asserts the import happened and the chip text
matches), **S18**.

## Out of scope for this ticket

Sweeping N configs × M conditions in one command on the Realtime side (one browser launch per clip is
a hard Chromium constraint; the Cascade half in 09 is where bulk sweeping happens).

---

# Ticket 11 — Microphone constraint toggles, both modes

Type: task · Status: blocked · Tier: **3** · Depends on: 04, 06

Size check: **right-sized (~1.5 hrs).** At the low edge of the band but not merged: merging into 12
would make that ticket ~5.5 hrs (Too thick), and this is a genuinely separate user-visible behaviour
(`getUserMedia` constraints) with its own footnote and its own test.

## What to build

**Frontend scope**
- `TuningPanel.tsx`: the **Microphone** section — EC / NS / AGC toggles with the wire field name in
  muted mono on the right, and the inline footnote
  `Applied at getUserMedia time — takes effect on the next connect.` These knobs do **not** trigger a
  reconnect in either mode.
- `useCascadeSession.ts` and `useRealtimeSession.ts`: build the `getUserMedia` constraints from
  `tuning.client.microphone` instead of the current hardcoded `true`s.

**Backend scope**: None (browser constraints never reach the server; they are hashed into the
fingerprint so a run is still identifiable). **Harness scope**: None.

## Acceptance criteria

Story ACs: **3.1** (`getUserMedia` called with exactly those values in both modes).

Brief tests: **S21** (both hooks, via `installMockGetUserMedia`).

## Out of scope for this ticket

Any DSP graph work (12).

---

# Ticket 12 — RMS noise gate + Realtime client-DSP re-plumbing

Type: task · Status: blocked · Tier: **3** · Depends on: 05, 06, 11

Size check: **right-sized (~4 hrs).**

## What to build

**Frontend scope**
- `frontend/src/pages/rmsGate.ts` (+ `.test.ts`) — the unit-tested source of truth for the gate math
  exactly as specified in the brief (per-128-sample RMS → dBFS → open/close, `floorGain =
  fullMute ? 0 : 10 ** (-attenuationDb/20)`, attack/hold/release ramps). Boundaries documented and
  safe: `-80 dBFS` = always open, `0 dBFS` = always closed, neither crashes nor divides by zero.
- `frontend/public/gate-processor.js` — **one** shared gate worklet used by **both** modes. Params
  arrive via `processorOptions` at construction and `port.postMessage({type:'gateParams', …})` for
  live adjust. The math is **hand-mirrored** from `rmsGate.ts` (the worklet realm cannot import TS),
  with the header comment saying so — exactly as `floatSampleToInt16` already is. The worklet clamps
  defensively; `clampGateParams()` clamps on the main thread too.
- `useCascadeSession.ts`: insert the gate node at the single insertion point
  (`micSource.connect(workletNode)`); the analyser tap stays pre-processing and unchanged.
- `useRealtimeSession.ts` — **the genuinely new plumbing**: when any client stage is enabled, build
  `getUserMedia → AudioContext → [gate] → MediaStreamAudioDestinationNode`, and
  `pc.addTrack(sentTrack, …)`. **The mute-during-reply logic must target the sent track** — add
  `sentTrackRef` and mute *that*; `mediaStreamRef` stays only for teardown. When no client stage is
  enabled, keep the raw track and **do not create the DSP context**, so the default config's measured
  latency does not move.
- `TuningPanel.tsx`: the **RMS gate** rows in the Denoise chain (threshold range with numeric
  readout, hold / attack / release, attenuation range labelled `0 dB (off) … 60 dB … mute`,
  `Full mute` checkbox).
- `frontend/src/test/mockCascadeApis.ts`: `FakeAudioContext` gains `createMediaStreamDestination()`,
  constructor-honouring `sampleRate` and gain-node stubs; `FakeAudioWorkletNode` gains
  `processorOptions` capture and a **two-way** `port` with `postMessage`.
  `mockRealtimeApis.ts`: `MockRTCPeerConnection` records `addTrack` arguments.

**Backend scope**: None. **Harness scope**: None.

## Acceptance criteria

Story ACs: **3.2** (attenuated by exactly `attenuationDb`, above-threshold passes at unity, full mute
silences), **3.3** (threshold change on a connected session takes effect **without** reconnecting),
**3.5** (the WebRTC track carries processed audio **and** the mute targets the track actually being
sent — the single most likely silent regression in this feature).

Brief tests: **S22**, **S23**, **S24**, **E7** (threshold at `0` and `-80` neither crashes the
worklet nor produces a silence-only transcript), **E8** (`attenuationDb = 0` is a no-op; `fullMute`
overrides `attenuationDb`).

## Out of scope for this ticket

RNNoise and the 48 kHz context switch (13) — the graph built here runs at today's rates.

---

# Ticket 13 — RNNoise (48 kHz contexts, 3:1 decimator)

Type: task · Status: blocked · Tier: **3** · Depends on: 12

Size check: **right-sized (~3.5 hrs).**

## What to build

**Frontend scope**
- `frontend/package.json`: `@sapphi-red/web-noise-suppressor` (chosen over `@jitsi/rnnoise-wasm`
  because it ships a working AudioWorklet with the 480-sample/48 kHz framing already handled).
  Import the wasm and the worklet with Vite's `?url` suffix and **verify both resolve under
  `vite dev` and `vite build` before building on it.**
- `frontend/src/pages/resample.ts` (+ `.test.ts`) — the unit-tested 48 k→16 k decimator (8-tap FIR
  low-pass + 3:1), source of truth for the worklet.
- `frontend/public/cascade-pcm-processor.js` — the decimator, gated on `sampleRate === 48000`, driven
  by `processorOptions.targetSampleRate`; header comment gains the hand-sync note pointing at
  `resample.ts`.
- `useCascadeSession.ts`: `new AudioContext({ sampleRate: rnnoiseEnabled ? 48000 : 16000 })` — when
  RNNoise is off the graph stays at 16 kHz **exactly as today**.
  `useRealtimeSession.ts`: the DSP context runs at 48 kHz natively.
- `TuningPanel.tsx`: the **RNNoise** row (toggle + voice-probability threshold range) with the
  48 kHz/480-sample footnote.

**Harness scope**
- Confirm the sweep from 09 emits an RNNoise **clean-baseline** row so a 16→48→16 round-trip
  regression is visible.

**Backend scope**: None.

## Acceptance criteria

Story ACs: **3.4** (mic audio passes through RNNoise in both modes and the transcript is non-empty
for a clean clip — i.e. resampling does not destroy the signal), **3.7** (each tier-3 stage has at
least one benchmarked fingerprint on the noisy corpus with its WER delta versus the same config with
the stage disabled — satisfied by running 09's sweep and 10's capture once tier 3 lands; **this
ticket owns making that happen**, as the last tier-3 ticket).

Brief tests: **E9** (the 48 k context + 3:1 decimator still yields 960-byte / 30 ms frames, and
`resample.ts`'s output matches the worklet's), **E10** (the clean-baseline row exists in the sweep).

## Out of scope for this ticket

Server-side denoise (16/17).

---

# Ticket 14 — Cascade transcript check: off / flag / correct

Type: task · Status: blocked · Tier: **4** · Depends on: 06

Size check: **right-sized (~3.5 hrs).**

## What to build

**Backend scope**
- `backend/app/providers/transcript_check.py` — `TranscriptChecker` / `TranscriptCheckResult`, shaped
  exactly like `segmentation_checker.py` (one client per object, tight explicit timeout
  `httpx.Timeout(6.0, connect=3.0)`, `response_format={"type":"json_object"}`, `max_tokens=200`).
  Any `OpenAIError` or parse failure → `TranscriptCheckResult(flagged=False, corrected_text=None,
  failed=True)` — **never raises**.
- `orchestrator._process_segment`, called **between `_resolve_direction` and the TTS/translation
  kickoff**: `off` ⇒ no call, no latency message, no extra fields; `flag` ⇒ fire the task, let
  translation start immediately with the original text, re-send `source_transcript` with
  `flagged: true` when the verdict lands; `correct` ⇒ `await`, translate
  `result.corrected_text or segment.text`, re-send `source_transcript` with the corrected `text`,
  `flagged: true` and `correctedFrom`. Either way emit
  `{"type":"latency","stage":"transcript_check","ms":<cumulative since speech_end>}`.
  `result.failed` ⇒ the existing non-fatal `retryable: true` error message, original text used.
- `backend/tests/conftest.py`: a **second** autouse fixture stubbing `orchestrator.TranscriptChecker`,
  matching the existing `SegmentationChecker` stub, so legacy tests never hit OpenAI.

**Frontend scope**
- `sessionHandle.ts`: `LatencyStage` gains `'transcript_check'`; `TranscriptSegment` gains
  `flagged?` and `correctedFrom?`.
- `latencyTracking.ts`: `'transcript_check'` in `LATENCY_STAGES`, ordered **after `speech_end`,
  before `translation_first_token`**.
- `WorkbenchPage.tsx` `TranscriptPaneBody`: the flag badge next to the existing trigger annotation —
  `data-testid="segment-suspicious-badge"`, `⚑ check`, `badge badge-warning badge-soft badge-xs`.
  **Badge only, no toast** (Step 3 gate answer 3). The *check-failure* toast is a different event and
  is unchanged.
- `TuningPanel.tsx`: the Cascade **Transcript check** section is now live (`off | flag | correct` +
  check-model select).

**Harness scope**
- `run_tuning_sweep.py` populates the `correctedWer` column when
  `cascade.transcriptCheck.mode == "correct"` (the column is defined in 09).

## Acceptance criteria

Story ACs: **4.1**, **4.3** (flag is non-blocking — translation proceeds with the original text and
does not wait), **4.4** (correct rewrites before translation, displayed transcript updated, dedicated
latency stage), **4.5** (raw **and** corrected WER per item in the report), **4.6** (off ⇒ no call, no
extra latency stage), **4.7** (failure ⇒ original text, session continues, non-fatal toast).

Brief tests: **S26**, **S27**, **F8**, **F9**.

## Out of scope for this ticket

Realtime `flag` (15) — no backend seam exists for it.

---

# Ticket 15 — Realtime transcript check `flag` via `POST /api/tuning/transcript-check`

Type: task · Status: blocked · Tier: **4** · Depends on: 04, 05, 14

Size check: **right-sized (~2 hrs).**

## What to build

**Backend scope**
- `backend/app/api/tuning.py` gains `POST /api/tuning/transcript-check`:
  `{text, language, mode, model}` → `{flagged, correctedText, elapsedMs}`. `mode ∈ {flag, correct}`;
  `model ∉ TEXT_MODELS` → 400; `text` over 2000 chars → 400. **A provider failure returns
  `200 {"flagged": false, "correctedText": null, "elapsedMs": …, "failed": true}`** — the caller must
  never break on it. Reuses `TranscriptChecker` from 14. No auth (as everything else).

**Frontend scope**
- `useRealtimeSession.ts`: when a source-transcript turn settles and
  `realtime.transcriptCheck.mode === 'flag'`, call the endpoint best-effort and non-blocking; a
  failure is `console.warn`'d and dropped. Render the same `segment-suspicious-badge` from 14.
- `TuningPanel.tsx`: the Realtime **Transcript check** section is now live — `off | flag` only, with
  `correct` `btn-disabled` plus the visible line
  `correct is unavailable: no seam in Realtime.` (a `title` alone is not accessible on a
  non-focusable element).

**Harness scope**: None.

## Acceptance criteria

Story ACs: **4.2** (Realtime offers only `off` / `flag`; `correct` is not selectable), **4.3**
*(Realtime half: non-blocking)*.

Brief tests: **S25** *(behaviour half)*, plus `test_tuning_api.py` cases for the new route.

## Out of scope for this ticket

`correct` mode in Realtime — permanently out of scope (locked decision 4).

---

# Ticket 16 — Server denoise chain: protocol + noisereduce + capability gating

Type: task · Status: blocked · Tier: **5** · Depends on: 02, 06

Size check: **right-sized (~3.5 hrs).**

## What to build

**Backend scope**
- `backend/app/providers/denoise.py` — `DenoiseStage` Protocol (`name`, `process(frame) -> bytes`
  same byte length, `reset()`), `NoopStage`, `NoisereduceStage`, `build_denoise_chain(tuning)`,
  `find_spec`-based detection and the module-level `_last_init_error`. Fixed chain order (cheap
  first): `noisereduce → deepfilternet`.
- `NoisereduceStage`: `noisereduce` has no streaming API, so keep a `_NR_CONTEXT_MS = 480` ring
  buffer, run `reduce_noise(y, sr=16000, prop_decrease=…, stationary=…)` over the buffer per new
  frame and emit the **last 30 ms**. Zero added algorithmic delay, real CPU cost — measured by
  ticket 09, not optimised here. *(If the measured number is bad, the honest fix is to mark the
  stage benchmark-only, not to optimise it in this slice.)*
- `orchestrator.audio_iter()` applies the chain **before** Deepgram — the single choke point every
  mic frame passes through. Every stage must handle **arbitrary frame lengths** (nothing enforces the
  960-byte size). When nothing is enabled `build_denoise_chain` returns `[]` and the path is skipped
  entirely — **zero cost when off**. Rebuild the chain when `tuning_state.current` changes identity,
  calling `reset()` on the old chain. Offline stages (`demucs`, `dns64`) are **never** constructed
  live: log `"offline-only denoise stage %s ignored in the live path"` once.
- `backend/pyproject.toml`: the first `[project.optional-dependencies]` — the **`bench`** extra
  (`noisereduce`, `numpy`). Per the Step 7 gate these are *not* main deps, so a default install
  correctly shows noisereduce as `not installed`.
- `/api/tuning/capabilities` `stages` now reports `installed: true` when the extra is present.

**Frontend scope**
- `TuningPanel.tsx`: the **noisereduce** row becomes live when `capabilities.stages.noisereduce
  .installed` — toggle + `propDecrease` range + stationary/non-stationary join; otherwise it keeps
  the `not installed` variant built in ticket 02.

**Harness scope**: `run_tuning_sweep.py` already honours the config; verify a noisereduce fingerprint
produces a distinct row.

## Acceptance criteria

Story ACs: **5.1** *(noisereduce half)*, **5.2** (every microphone frame is processed before reaching
Deepgram), **5.3** (capability discovery drives enabled/disabled; **core CI runs without torch**),
**5.4** (offline stages selectable in a benchmark config file while disabled in the panel).

Brief tests: **S28** *(generic half: a fake stage's call count equals the frame count)*, **S29**
(`find_spec` monkeypatched to a spec ⇒ `installed: true` and the panel row enabled), plus
`backend/tests/test_denoise.py` (chain construction, detection, arbitrary frame lengths).

## Out of scope for this ticket

DeepFilterNet and torch (17); GPU anything (permanently out of scope).

---

# Ticket 17 — DeepFilterNet stage + optional `denoise` torch extra

Type: task · Status: blocked · Tier: **5** · Depends on: 16

Size check: **right-sized (~2.5 hrs).**

## What to build

**Backend scope**
- `DeepFilterNetStage` in `denoise.py`: resample 16 k→48 k (`torchaudio.functional.resample`, ships
  with torch), run 3 DFN hops per 30 ms frame, resample back. `init_df()` is **lazy on first use and
  cached** — never called from the capabilities route, which uses `find_spec` only. A load failure
  sets `_last_init_error` and the stage **degrades to `NoopStage` for the rest of the session** with
  one warning log, rather than killing it.
- `backend/pyproject.toml`: the **`denoise`** extra (`torch>=2.4`, `deepfilternet>=0.5.6`) with the
  CPU wheel index pinned (`[[tool.uv.index]]` → `https://download.pytorch.org/whl/cpu` plus
  `[tool.uv.sources] torch = {index = "pytorch-cpu"}`). Installed with `uv sync --extra denoise`.
  **Core CI stays torch-free.**
- Capabilities distinguishes the two failure modes: `installed: false` +
  `torch not installed — run \`uv sync --extra denoise\`` **vs** `installed: true` +
  `model weights unavailable — see the server log.`
- `README.md` documents `uv sync --extra denoise` and `--extra bench`.

**Frontend scope**
- `TuningPanel.tsx`: the **DeepFilterNet** row becomes live when installed — toggle + attenuation
  limit dB + post-filter strength; the two distinct hint strings for the two failure modes (wireframe
  §7), always as **visible text**, never a `title` alone.

**Harness scope**: None beyond the sweep already honouring the config.

## Acceptance criteria

Story ACs: **5.1** *(DeepFilterNet half, with its own parameters visible)*, **5.3** (the "installed"
side of capability discovery).

Brief tests: **S28** (DeepFilterNet selected ⇒ every mic frame passes through
`DeepFilterNetStage.process` before Deepgram), **F15** (torch installed but `init_df()` raises ⇒
`installed: true` + `model weights unavailable…`, and the stage degrades to no-op mid-session rather
than killing it).

## Out of scope for this ticket

Demucs / DNS64 / Wave-U-Net in the live path — permanently out of scope; they exist only as sweep
options (09) and disabled inventory rows (02).

---

# Ticket 18 — Model / voice pickers wired through both transports + allow-list validation

Type: task · Status: blocked · Tier: **6** · Depends on: 02, 04, 06

Size check: **right-sized (~2.5 hrs).**

> The pickers themselves are rendered by ticket 02 (AC 5.6 is a rendering criterion). This ticket
> makes the picked values actually reach the providers, and closes the Cascade side of the asymmetric
> validation posture. **If this ticket is cut**, the Cascade pickers must be flipped to `disabled`
> with a visible reason per the cut protocol — the Realtime model/voice already work via ticket 04.

## What to build

**Backend scope**
- `orchestrator.py`: `tuning.cascade.translationModel`, `segmentation.model`,
  `transcriptCheck.model`, `ttsVoiceA` / `ttsVoiceB` and `deepgram.model` are read from
  `tuning_state.current` **per segment / per stream**, never from module constants. Out-of-allow-list
  values **fall back to the default and log** — the WS never 400s and never closes (asymmetric
  posture, story AC 5.7).
- `allowlists.elevenlabs_voices()` = the two configured voices + `ELEVENLABS_VOICE_IDS_EXTRA`
  (Step 7 gate answer 3); no hard-coded premade list. `.env.example` documents it.

**Frontend scope**
- `TuningPanel.tsx` Models & voices section wired to the draft (it already renders from
  `capabilities.allowLists`); the footnote naming the server-side allow-list; Realtime `model` /
  `voice` rows marked **"applies at next connect"**.

**Harness scope**: None.

## Acceptance criteria

Story ACs: **5.6** (fixed curated lists, no free text — re-asserted end-to-end here), **5.7**
(HTTP rejects with 400 — already covered by 04; **the Cascade WebSocket falls back to the default
rather than killing the session**).

Brief tests: **S31** *(end-to-end half)*, **F4** *(Cascade fallback, extended to every picker)*.

## Out of scope for this ticket

Adding new models or voices beyond the curated constants; free-text entry (explicitly forbidden).

---

## Cut candidates (ordered by tier, cut from the bottom)

Each cut applies **the cut protocol at the top of this file**: the ticket's knob rows flip to the
panel's `disabled` + visible-reason treatment. No dead controls, no half-built seams.

| Order | Cut | Tier | Saves | What is lost |
|---|---|---|---|---|
| 1 | **Ticket 18** | 6 | ~2.5 hrs | Model/voice pickers render but only Realtime model/voice apply; Cascade pickers go disabled. Model constants stay as they are today. |
| 2 | **Ticket 17** | 5 | ~2.5 hrs | No DeepFilterNet; `stages.deepfilternet.installed` stays `false` forever and the row stays in its `not installed` state. No torch anywhere. |
| 3 | **Ticket 16** | 5 | ~3.5 hrs | No server-side denoise at all; both server stage rows permanently disabled (the panel still lists them — locked decision 11). `audio_iter` untouched. |
| 4 | **Ticket 15** | 4 | ~2 hrs | Realtime transcript check disabled (`off` only); Cascade keeps all three modes. No new HTTP endpoint. |
| 5 | **Ticket 14** | 4 | ~3.5 hrs | No transcript check at all; the section goes disabled; no `transcript_check` latency stage; the `correctedWer` column stays empty. |
| 6 | **Ticket 13** | 3 | ~3.5 hrs | No RNNoise; no new npm runtime dependency; both audio contexts stay at today's rates and `cascade-pcm-processor.js` is untouched. |
| 7 | **Ticket 12** | 3 | ~4 hrs | No RMS gate and **no Realtime client-DSP re-plumbing** — the highest-risk frontend change in the run disappears. Cutting 12 forces cutting 13. |
| 8 | **Ticket 11** | 3 | ~1.5 hrs | Mic constraints stay hardcoded `true`; the Microphone section goes disabled with a reason. |

**Not cuttable without losing the feature's point:** tiers 1 and 2 (tickets 01–10). Tier 2 is where
every claim becomes a number; cutting it leaves a panel full of knobs and no evidence, which is the
one outcome the idea brief explicitly rules out.

If the whole slice must shrink hard, the honest minimum is **01–07 + 08–09** (tier 1 + the Cascade
benchmark half, ~29 hrs): a complete tuning panel, both transports, live apply with a safe reconnect,
and per-fingerprint WER numbers on a noisy corpus.

---

## Assumptions made during slicing

1. **AC 1.1 ("panel is the single inventory") is completed collectively**, not by one ticket. Ticket
   02 ships the six sections, the row primitives and the permanently-disabled inventory rows; each
   later ticket adds the rows it makes real. This is what keeps every ticket vertical instead of
   producing one enormous "build the panel" layer ticket, and it is what makes the cut protocol
   cheap. **If you would rather see every row rendered on day one (even inert), say so — it moves
   ~2 hrs of work from tickets 04/06/11–18 into ticket 02 and makes 02 Too thick (~5.5 hrs), so it
   would need re-splitting.**
2. **Three tickets are single-sided** (03 persistence, 05 Realtime live apply, 08 noisy corpus) and
   each states its justification inline: the story part genuinely has no other side (no server-side
   storage by decision 10; no backend seam in a Realtime session; the corpus generator is a script).
3. **Ticket 04 carries a tier-3 knob** (`noise_reduction`), stated explicitly in the ticket, because
   it is one more key in the same payload, mapping function and test file.
4. Sizes assume the builder has the brief open and is not re-deriving decisions — the brief is
   unusually complete (exact fingerprint algorithm, exact wire shapes, exact test list).
5. The uncommitted `_turn_detection()` / `realtime_vad_*` work is **absorbed** in ticket 01, not
   reverted or rebased away (story assumption 5).

## Places the brief leaves the builder a choice (flag before building)

1. **Babble / street / fan noise sources.** The brief says babble is "several overlaid TTS speakers"
   but does not say whether `make_noisy_corpus.py` calls `generate_audio_fixtures.py` (needs an
   ElevenLabs key, so the generator becomes key-gated) or synthesises the noise procedurally
   (filtered/shaped noise, no key, fully reproducible from `seed`). **Recommendation: procedural for
   street/fan/white, reuse of existing generated TTS clips for babble with a self-skip when they are
   absent** — it keeps ticket 08 key-free and deterministic. Ticket 08 must state which it chose in
   `SCRIPT.md`.
2. **Does the Cascade sweep run the LLM judge?** `tuning_sweep.json`'s row shape has no judge column,
   but COMPARISON §7's table has `judge acceptance`. Either the Cascade half fills it (extra cost and
   an extra key dependency) or §7's judge column is Realtime-only and the Cascade rows leave it
   blank. **Recommendation: Realtime-only, blank for Cascade rows, stated in the §7 provenance line.**
3. **`TuningSection.tsx` split** — the brief says "only if `TuningPanel.tsx` exceeds ~400 lines".
   Builder's call at the time; both are pre-approved.
4. **Chain-rebuild trigger.** "Rebuilt whenever `tuning_state.current` changes identity" does not
   specify the mechanism (identity check per frame vs. explicit rebuild at the assignment site).
   **Recommendation: rebuild at the assignment site in `_handle_update_tuning`** — no per-frame cost.
5. **`flag` mode's re-sent `source_transcript`.** The brief says re-send the segment with
   `flagged: true`; it does not say how the client reconciles two messages for the same `segmentId`.
   **Recommendation: merge by `segmentId` in the existing transcript state** — the pane already keys
   on it; confirm no duplicate segment is appended.
6. **`ELEVENLABS_VOICE_IDS_EXTRA` parsing.** pydantic-settings parses `list[str]` from env as JSON by
   default, which surprises people who write a comma-separated list. Ticket 01 must pick one and
   document it in `.env.example`.
7. **`appliedTuning` serialisation.** Preserving the absent-key idiom can be `model_dump(exclude_none
   =True, by_alias=True)` or a hand-rolled emitter; only the *result* is contractual
   (`fingerprint(appliedTuning) == fingerprint(request.tuning)`).
8. **Panel open/closed state across reloads.** Not specified anywhere. **Recommendation: do not
   persist it** — the panel opens closed; one less thing in localStorage.
9. **Number formatting parity** (`Py repr(round(x, 2))` vs `TS String(x)`) is the single most likely
   place for a silent fingerprint mismatch. `shared/tuning-fingerprint-cases.json` must include at
   least one case per float knob at a non-integral step value, or S1 will pass while the real system
   disagrees.
