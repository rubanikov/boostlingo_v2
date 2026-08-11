Type: prototype
Status: claimed
Blocked by: 04, 05, 12

## Question

Sketch the actual STT/Translation/TTS provider interfaces (Python protocols/ABCs) so
swapping a provider is a contained change, per the brief's code-quality bar.

Should reflect the real shapes learned from the Deepgram/ElevenLabs/translation research
([Cascade provider streaming APIs research](04-cascade-provider-research.md)) and fit the
pipeline architecture
([Cascade pipeline architecture](05-cascade-pipeline-architecture.md)) — e.g.
async-generator-based streaming interfaces, structured error types for
rate-limit/timeout/empty-result. Produce a rough stub/prototype of the interfaces plus one
concrete provider implementation to react to.

[Prior-art research](12-prior-art-reference-implementations.md) found the same swap-point
shape independently in Pipecat, LiveKit, and Vocode — "one streaming method, in: raw
input, out: an async stream of typed events" — which validates this direction. It also
found LiveKit deliberately does **not** unify its cascade provider interfaces with its
realtime speech-to-speech interface (separate object families, sharing only
transport/orchestration) — this cascade-mode interface does not need to (and per that
finding, probably should not try to) also cover the Realtime API. LiveKit's
`STTCapabilities`-style capability-declaration dataclass (a provider self-declares what
it supports) is worth considering if providers turn out to differ on feature support.
