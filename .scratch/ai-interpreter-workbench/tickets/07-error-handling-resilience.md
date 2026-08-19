Type: task
Status: blocked
Depends on: [01](01-realtime-mvp.md), [02](02-cascade-mvp.md), [03](03-unified-workbench-shell.md)

# Ticket 7 — Error handling & session resilience (retries, circuit breaker, mic-denied UX, reconnection, memory bounds)

Size check: right-sized (merged) — combines what would otherwise be two thin,
tightly-coupled wayfinder tickets
([10](../issues/10-error-handling-test-strategy.md) and
[13](../issues/13-stability-reconnection-drift-memory.md)). Ticket 13's own
answer found 2 of its 3 sub-questions already solved by earlier decisions
(clock drift reuses Ticket 6's resync design; audio playback drift is a
non-issue given segmented architecture) — the only genuinely new stability
work is reconnection + memory hygiene, which explicitly reuses this ticket's
circuit breaker ("same 'something structurally broken' signal, not a parallel
concept"). Splitting them would produce two overlapping small tickets over
the same failure-handling surface. (~3-3.5 hrs.)

**Includes its own test**: retry/circuit-breaker logic tests (correct attempt
count/backoff timing per failure mode, circuit breaker trips at exactly 5
consecutive failures).

## What to build

**Backend**
- Bounded retries per failure mode (rate limit: 2 retries, 200ms→400ms
  backoff, then drop segment; timeout: 1 retry then drop; empty translation:
  1 retry then drop+log; empty STT: not an error unless `SpeechStarted` fired
  with nothing produced).
- 5-consecutive-segment-failure circuit breaker → "interpretation
  unavailable" hard state.
- Backend↔provider (Deepgram/ElevenLabs) reconnect on drop: backoff
  500ms→1s→2s capped, without tearing down the browser↔backend WebSocket;
  in-flight segment on drop is dropped+logged; exhausted retries reuse the
  same circuit breaker.
- Browser↔backend drop: short grace-window reconnect (a few seconds, backend
  holds session state that long) — beyond that, session ends, manual restart
  (full resumption explicitly out of scope).
- Memory hygiene: release/reset per-segment audio buffers and orchestrator
  state at each boundary; WS queues apply backpressure (growing queue logged
  as a signal).

**Frontend**
- Mic-permission-denied blocking banner (catches `NotAllowedError` by name
  specifically) with a "try again" button re-attempting `getUserMedia()` —
  not a full reload.
- Non-blocking toast for rate-limit/timeout, only if noticeable.
- Silent drop (no UI) for empty-result cases.
- Connection-status badge turns amber ("Reconnecting…") during a reconnect
  attempt.

## Acceptance criteria

- No single provider failure (rate limit, timeout, empty result) ever ends
  the session — only that one segment is affected.
- 5 consecutive segment failures trips the circuit breaker and shows an
  explicit "interpretation unavailable" state.
- Denying mic permission shows a blocking banner with working retry, not a
  crash or silent failure.
- Killing the Deepgram or ElevenLabs connection mid-session triggers a
  visible amber "Reconnecting…" badge, and the session recovers transparently
  once the provider connection is restored, without the user needing to
  restart.
- A brief browser↔backend network blip (a few seconds) recovers without
  ending the session; a longer one ends the session cleanly with a clear
  message, not a hang.
- No automatic runtime provider fallback exists (by design — swappability is
  build-time only, not a failover system).

## API / contract notes

- `error` (server) message type, feeding the above UI states.
- Connection-status badge states: `Connected` (Ticket 3) → `Reconnecting`
  (amber, this ticket) → `Connected` or session-ended.
