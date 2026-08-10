Type: grilling
Status: open
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
