Type: grilling
Status: resolved
Blocked by: 06, 10

## Question

Design how the app sustains the brief's 5-minute back-and-forth conversation benchmark
"without disconnection, audio drift, or memory leaks."

Now sharp enough to ticket given
[Cascade pipeline architecture](05-cascade-pipeline-architecture.md) is decided (one
persistent WebSocket per session, `segmentId`-threaded messages, async LLM
clause-checks running alongside continuous Deepgram/ElevenLabs connections):

- **Reconnection**: what happens when the Deepgram or ElevenLabs WebSocket connection
  drops mid-session (not a single failed call — a sustained-session concern, distinct
  from [Error handling & test strategy](10-error-handling-test-strategy.md)'s per-call
  failure modes)? Does the browser↔backend WebSocket need to survive a backend-side
  provider reconnect transparently, or does the user see a visible "reconnecting"
  state?
- **Audio/clock drift**: over a 5-minute session with continuous capture and multiple
  segment-boundary cuts (LLM-triggered or VAD-triggered), how do client and server
  clocks stay reconciled for the latency instrumentation
  ([Latency instrumentation design](08-latency-instrumentation-design.md)) without
  accumulating skew?
- **Memory bounds**: what prevents unbounded growth of the per-session transcript
  buffer, segment history, or audio queues over a long session?

Blocked on [Provider abstraction interface design](06-provider-abstraction-design.md)
(reconnect behavior is naturally part of the provider interface's contract) and
[Error handling & test strategy](10-error-handling-test-strategy.md) (shares
failure-mode vocabulary — should end up as one coherent design, not two overlapping
ones).

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-13-stability-reconnection-drift-memory.html](../../../.lavish/ticket-13-stability-reconnection-drift-memory.html).
**This is the final ticket on the map** — two of its three sub-questions turned out to
already be answered by earlier decisions rather than needing new mechanisms.

**1. Reconnection — the one genuinely new piece.**
- **Backend ↔ provider (Deepgram/ElevenLabs)**: backend detects the drop, retries with
  backoff (500ms → 1s → 2s, capped), without tearing down the browser↔backend
  WebSocket — transparent where possible. Any segment in flight when the drop happens
  is dropped and logged (ticket 10's "scoped to one segment" philosophy, not a new
  rule). Exhausted retries reuse ticket 10's circuit breaker directly — same
  "something structurally broken" signal, not a parallel concept.
- **Browser ↔ backend**: the more realistic real-world failure (wifi handoff, laptop
  sleep) — browser attempts a short-window reconnect (a few seconds, backend keeps
  session state alive that long). **Scoping call, named explicitly**: full session
  resumption beyond that short grace window is out of scope for the time budget — if
  it fails, the session ends and the user restarts manually.
- **UI**: a visible but subtle "Reconnecting…" state — the connection-status badge in
  ticket 09's winning layout (currently "Connected") turns amber during a reconnect
  attempt, without disrupting the rest of the screen.

**2. Audio / clock drift — already solved by earlier decisions.**
- **Clock drift** (for latency display): ticket 08's 30s-resync-plus-after-reconnect
  design already covers this — this ticket's reconnection design (above) is exactly
  one of the resync triggers ticket 08 specified. No new mechanism, just confirming
  the wiring.
- **Audio playback drift**: not actually a risk, thanks to ticket 05's segmented
  architecture — Web Audio API scheduling drift only matters for one continuous
  unbroken playback stream, but segments play in short bursts with natural gaps
  between them, so each segment's `AudioBufferSourceNode` chain (ticket 07) starts
  scheduling fresh from "now." No accumulation within a segment (imperceptible) or
  across segments (each starts clean) — a side-benefit of the segmentation decision,
  not new design work.
- **Realtime mode**: WebRTC's own jitter buffer is engineered specifically for this;
  nothing to add.

**3. Memory bounds** — mostly simple hygiene, not new architecture: transcript text
history is negligible at this scale (a few KB over a 5-minute session); raw audio
buffers and per-segment orchestrator state just need clean release/reset after each
chunk is processed / each segment boundary fires, not accumulation into ever-growing
structures; WebSocket queues should apply backpressure (a growing queue is itself a
signal worth logging). **Testable addition to ticket 10's suite**: a process-memory
sample (e.g. via `psutil`) before/after a simulated 5-minute Playwright E2E run, to
catch leak regressions empirically rather than relying on code review alone.

---

**The AI Interpreter Workbench wayfinder map is now complete — all 14 tickets
resolved.** See [map.md](../map.md) for the full Decisions-so-far index.
