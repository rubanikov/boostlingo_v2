Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

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
