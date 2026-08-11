Type: grilling
Status: claimed
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
