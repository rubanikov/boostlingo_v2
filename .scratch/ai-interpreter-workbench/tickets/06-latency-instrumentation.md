Type: task
Status: blocked
Depends on: [01](01-realtime-mvp.md), [02](02-cascade-mvp.md), [03](03-unified-workbench-shell.md)

# Ticket 6 — Latency instrumentation, both modes

Size check: right-sized (~2 hrs).

## What to build

**Backend** (Cascade only — server owns every stage)
- Timestamp capture at segment boundary (`speech_end`, reference point 0),
  translation first token, translation complete, TTS first byte; client
  reports playback start back.
- Clock-sync offset ping/pong at session start, **re-run every 30s** and
  after any reconnect (ties to [Ticket 7](07-error-handling-resilience.md)).
- `latency` WS message emitted incrementally as each stage is crossed, `ms`
  cumulative since `speech_end`.

**Frontend**
- Cascade — per-stage running-total table, live-updating per segment, vs. the
  <2s target (biggest inter-stage delta visually flags the bottleneck).
- Realtime — end-to-end number only (client-side only: data-channel
  speech-stopped signal → audio element playback start; no server
  involvement, backend is off the audio path per ticket 03), vs. the <1.5s
  target.

## Acceptance criteria

- Cascade mode UI shows a live per-stage latency breakdown (5 stages) for
  every segment, visible during the session (brief FR7, literal).
- Realtime mode UI shows an end-to-end latency number only — this asymmetry
  is intentional (backend has no sub-stage visibility once the ephemeral
  token is issued), not a bug.
- Clock offset is recomputed every 30s during a session, not just once
  (accounts for drift over the brief's 5-minute stability window).
- Numbers displayed are genuinely measured, not simulated — a real network
  hiccup should visibly show up as inflated latency for that segment.

## API / contract notes

- `latency` message stages: `speech_end` (0), `translation_first_token`,
  `translation_complete`, `tts_first_byte`, `playback_start` (final — the
  brief's actual benchmark number), each cumulative-ms-since-`speech_end`.
- Realtime mode: no `latency` WS message at all — measured and displayed
  purely client-side.
