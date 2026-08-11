Type: grilling
Status: claimed
Blocked by: 03, 05

## Question

Design the per-stage latency instrumentation required by the brief (visible in the UI for
both modes).

Given the Realtime transport decision
([Realtime transport architecture](03-realtime-transport-architecture.md)) and the
Cascade pipeline architecture
([Cascade pipeline architecture](05-cascade-pipeline-architecture.md)), decide:

- What timestamps get captured at which boundaries (mic capture end, STT
  first/final transcript, translation complete, TTS first audio byte, playback start) for
  each mode.
- How clocks are synchronized/reconciled across client and server.
- What's actually shown in the UI (per-stage breakdown vs just end-to-end).
- How this maps onto the brief's benchmark definition ("speech end → first audio out").

[Prior-art research](12-prior-art-reference-implementations.md) found Pipecat's
OpenTelemetry span hierarchy (conversation → turn → per-service span, each carrying
provider identity + a `ttfb` attribute) as the most complete working example of this —
worth using as a structural reference, with the caveat that it's built around "turn" as
the aggregation unit and this project needs an equivalent unit for continuous
interpretation (e.g. a chunk/utterance-window ID, once
[Cascade pipeline architecture](05-cascade-pipeline-architecture.md) settles the
segmentation granularity). A stage → measured-contribution → running-total-vs-target
table layout (seen in a companion doc to that research) is a reasonable structural
template for the UI display itself.
