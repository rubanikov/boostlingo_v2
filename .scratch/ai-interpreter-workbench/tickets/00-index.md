# AI Interpreter Workbench — Implementation Tickets

Status: **approved 2026-08-11** via feature-factory Step 9 gate (Lavish review:
`.lavish/step9-ticket-breakdown.html`). Approved as drafted — right-sized, no
cuts, no notes. Sliced from the fully-resolved
[wayfinder map](../map.md) — 9 vertical tracer-bullet tickets, ~21-24hrs
estimated against the brief's 15-20hr soft target.

## Waves

```
Wave 0 (start now, parallel):     [1] Realtime MVP        [2] Cascade MVP
                                          \                    /
Wave 1:                                   [3] Unified shell (mode toggle + transcripts UI)
                                          /        |         \
Wave 2 (parallel):              [4] Diarization  [6] Latency  [7] Error handling + resilience
                                       |
Wave 3:                          [5] LLM-hybrid segmentation
                                       |
Wave 4 (needs 1-7 all done):    [8] Quality validation suite
                                       |
Wave 5:                          [9] Comparison write-up
```

## Tickets

| # | Title | Depends on | Size | Status |
|---|-------|-----------|------|--------|
| [01](01-realtime-mvp.md) | Realtime mode: voice-in/voice-out MVP | none | ~2 hrs | done |
| [02](02-cascade-mvp.md) | Cascade mode: end-to-end MVP with provider abstraction | none | ~4-5 hrs | done |
| [03](03-unified-workbench-shell.md) | Unified workbench shell: mode toggle, language selector, dual-column transcripts | 01, 02 | ~2 hrs | ready |
| [04](04-diarization.md) | Cascade: diarization + per-speaker voice | 02, 03 | ~1.5-2 hrs | done |
| [05](05-llm-hybrid-segmentation.md) | Cascade: LLM-hybrid segmentation upgrade | 02, 04 | ~2-2.5 hrs | done |
| [06](06-latency-instrumentation.md) | Latency instrumentation, both modes | 01, 02, 03 | ~2 hrs | done |
| [07](07-error-handling-resilience.md) | Error handling & session resilience | 01, 02, 03 | ~3-3.5 hrs | done |
| [08](08-quality-validation-suite.md) | Quality validation suite | 01-07 | ~2.5-3 hrs | done |
| [09](09-comparison-writeup.md) | Comparison write-up (1-2 pages) | 06, 08 | ~1.5-2 hrs | ready |

## Cut candidates (if time runs short)

1. Drop Ticket 05's LLM-priority segmentation mode — keep hybrid-race only.
2. Drop Ticket 04 (diarization) entirely.
3. Drop Ticket 08's real-audio supplementary fixtures.

Not selected at approval time — full scope proceeds as drafted.

## Wave 0 build notes (reconciled)

- **Ticket 1 contract**: backend's `POST /api/realtime/session` returns
  `{client_secret, expires_at, model, voice}` (flat, `client_secret` not
  `value`) — frontend reconciled to match.
- **Ticket 2 WS contract**: matches the dictated shape exactly; TTS audio
  landed on 16kHz PCM16 (both sides independently agreed). Backend also emits
  an `{"type":"error","provider","kind","message","retryable"}` message on
  provider failure, not in the original spec — frontend currently logs
  unrecognized message types to console without surfacing them in the UI.
  **Ticket 7 (error handling) should wire this into user-facing state.**
- ElevenLabs TTS provider opens one WS connection per segment (not one
  long-lived connection for the whole session) — a build-time judgment call,
  flagged for a human sanity check once real API keys are available.
- Deepgram auth header format (`Authorization: Token {key}`) is unverified
  against a live key — verify before demo.
- **Ticket 4 design correction (deviates from wayfinder ticket 06's decided
  mechanism)**: Deepgram's `detect_language` does not work on streaming
  connections at all ("not currently supported for streaming" per Deepgram's
  own docs) — verified before building. Per-segment language detection is
  built instead on Nova-3's `language=multi` streaming mode, which tags each
  word with its own `language` field directly in the Results stream — same
  outcome (per-segment direction resolution, no manual toggle), a
  different, verified-working mechanism. `diarize=true` + `language=multi` combined on
  one live connection is unverified — check once real keys are available.

## Assumptions flagged during slicing

1. **Realtime-mode transcript events** (Ticket 03): assumed standard
   `input_audio_transcription` + `response.audio_transcript.delta` — verify
   against current OpenAI docs before building.
2. **Segmentation-mode toggle UI** (Ticket 05): assumed a dev-facing
   toggle/query-param is sufficient, not a polished settings UI.
3. **Cascade WebSocket endpoint path**: not specified by the wayfinder —
   implementers pick one (e.g. `/ws/cascade`) as an implementation detail.
4. **Ticket 01/02 "minimal UI" boundary**: both ship deliberately unstyled
   placeholder UI, fully replaced by Ticket 03.
