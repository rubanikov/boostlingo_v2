Type: grilling
Status: resolved
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

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-08-latency-instrumentation-design.html](../../../.lavish/ticket-08-latency-instrumentation-design.html).

**Clarification first**: there's no distinct "mic capture end" event — capture never
stops (ticket 05). The only meaningful "end" is the segmentation boundary firing (LLM
verdict or Deepgram's `speech_final`/`UtteranceEnd`, whichever wins the race) — that
*is* "speech end" for measurement purposes. Also distinguished explicitly from **session
end** (the user's stop button, one-time, out of scope here).

**1. What gets timestamped, per mode — genuinely asymmetric, and that's the point.**
Cascade (backend owns every stage): segment boundary → translation first token →
translation complete → TTS first byte → client-reported playback start, all computed
server-side. Realtime (backend off the audio path, ticket 03): only two measurable
points exist — the data-channel's speech-stopped signal, and the browser's audio element
starting to play. No sub-stage visibility is possible for Realtime mode; this is a direct
consequence of the architecture, not a shortcoming, and is itself a useful data point for
the brief's controllability comparison (cascade's "more control" made concrete).

**2. Clock synchronization — periodic offset, not one-time.** Original recommendation
(one NTP-style ping/pong offset at session start, server computes all "official" numbers
in one consistent clock frame) was **amended after a good question about network
issues**: clocks drift over the brief's 5-minute stability-test session length, so the
offset is **re-run every 30s**, and always after any reconnect (ties into
[Stability: reconnection, drift, memory](13-stability-reconnection-drift-memory.md),
which owns the reconnect trigger; this ticket owns re-running the offset calc when it
fires). A transient network hiccup mid-segment correctly shows up as inflated latency
(the instrumentation working as intended); a lost `latency` message is acceptable
graceful degradation since these are diagnostic-only, not on the interpretation
pipeline's critical path. Realtime mode needs no clock reconciliation at all — both its
measurable timestamps happen in the same browser clock.

**3. UI display.** Cascade: per-stage running-total table (cumulative ms since
speech-end per stage), live-updating per segment, vs. the <2s target — the biggest
delta between consecutive stages visually flags the bottleneck. Realtime: end-to-end
number only, vs. the <1.5s target. The aggregation-unit question ticket 12's research
flagged as needed is already solved — `segmentId` (ticket 05's protocol) is that unit,
no new concept required. Message shape extends ticket 05's example directly: stage
values `speech_end` (0, reference point), `translation_first_token`,
`translation_complete`, `tts_first_byte`, `playback_start` (final — the brief's
benchmark number), sent incrementally as each is crossed so the UI populates live, each
`ms` cumulative since `speech_end` rather than a delta from the prior stage.

**Follow-up amendment triggered for ticket 05**: a genuine, validated concern surfaced
mid-session — Deepgram's 300ms `endpointing` threshold is too aggressive for natural
"thinking pauses" mid-utterance, and a toggle to compare segmentation behavior was
requested for testing. Resolved as: bump `endpointing` to 500ms (the top of ticket 04's
own researched range, zero added risk), plus add a configurable segmentation mode —
today's hybrid race (default) vs. an "LLM-priority" mode where the LLM verdict is
preferred and Deepgram's fast `speech_final` is ignored, but the slower `UtteranceEnd`
stays as a hard fallback ceiling so segments can never hang indefinitely. Full detail in
ticket 05's amendment.
