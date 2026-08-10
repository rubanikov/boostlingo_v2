Type: prototype
Status: open
Blocked by: 04, 05

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
