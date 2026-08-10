Type: grilling
Status: open
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
