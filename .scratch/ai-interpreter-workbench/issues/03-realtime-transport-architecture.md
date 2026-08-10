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
