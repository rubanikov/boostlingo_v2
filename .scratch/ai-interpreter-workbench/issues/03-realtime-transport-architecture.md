Type: grilling
Status: resolved
Blocked by: 02

## Question

Given the research on OpenAI Realtime API integration patterns
([Realtime API integration research](02-realtime-api-integration-research.md)), decide:
direct browser↔OpenAI WebRTC vs backend-relayed WebSocket for Realtime mode.

Weigh: latency, API key/secret exposure, ability to instrument per-stage latency
server-side, and consistency with the Cascade mode's transport (for the "clean
separation between mode-specific transport and mode-agnostic UI" code-quality
requirement). Decide how the ephemeral token flow (if WebRTC) fits into the Python
backend.

**Also decide, surfaced by the research:** the brief's Technical Requirements names the
model `gpt-realtime` specifically. The research found OpenAI also ships a purpose-built
`gpt-realtime-translate` model on a dedicated `/v1/realtime/translations` endpoint —
non-turn-based, structured language targeting, native dual transcript-delta streams
built for live captions — architecturally a better fit for a translation use case than
steering general-purpose `gpt-realtime` via a system prompt. Decide whether to use the
literally-named model as a strict reading of the requirement, or use
`gpt-realtime-translate` with the deviation explicitly justified in the write-up (the
brief already asks candidates to explain their choices).

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-03-realtime-transport-architecture.html](../../../.lavish/ticket-03-realtime-transport-architecture.html).

**1. Transport — WebRTC direct to OpenAI.** Backend mints a short-lived ephemeral token
via `POST /v1/realtime/client_secrets`; browser connects straight to OpenAI over UDP
media + a data channel (`"oai-events"`). This is the path OpenAI actually documents —
WebSocket is server-to-server only, not meant for browser auth. Avoids a relay hop
against the brief's <1.5s target; the permanent API key never leaves the backend.
**Tradeoff accepted**: the backend is off the audio path once the token is issued, so
per-stage latency has to be measured client-side and reported back over the data channel
for [Latency instrumentation design](08-latency-instrumentation-design.md) to build on,
rather than timestamped server-side the way Cascade mode gets for free. "Transport
consistency with Cascade mode" is satisfied by UI abstraction (a common session interface
the UI doesn't need to know the transport behind), not by forcing both modes onto the
same protocol — matches ticket 05's/12's finding that mature frameworks (LiveKit) keep
cascade and realtime transports separate too.

Ephemeral token flow → Python backend: a `POST /api/realtime/session` endpoint does the
server-to-server call to OpenAI with the real API key and returns the ephemeral secret +
session config to the browser, which then drives the `RTCPeerConnection` itself
(SDP offer/answer, mic track, data channel) directly against OpenAI.

**2. Model — `gpt-realtime` as literally specified**, not `gpt-realtime-translate`
despite it being architecturally the better fit for continuous interpretation (turn-free,
structured language targeting, native dual-transcript streams — see ticket 02's
research). Reasoning: the brief's Technical Requirements calls `gpt-realtime` "**required**"
for Realtime mode, meaningfully different wording from "Cascade mode providers are
**candidate's choice**" a few lines later in the same document — a deliberate
distinction, not an oversight. Deviating from an explicit "required" spec is a real risk
in an evaluated take-home, not an ambiguous judgment call, so the architectural merit of
`gpt-realtime-translate` doesn't offset that risk on its own.

**Recorded for the write-up, not the code**: give `gpt-realtime-translate` real weight in
the comparison write-up — "if this were a production decision rather than a specified
requirement, `gpt-realtime-translate` would likely be the better choice, because
[turn-free design / structured language targeting / native dual transcripts]." Satisfies
the brief's Problem Statement ask to "form a defensible opinion on when each architecture
fits" without betting the submission on a reading of "required" the text doesn't support.
