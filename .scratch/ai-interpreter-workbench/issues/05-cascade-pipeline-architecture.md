Type: grilling
Status: open
Blocked by: 04

## Question

Given the provider research
([Cascade provider streaming APIs research](04-cascade-provider-research.md)), design the
Cascade mode pipeline: how audio chunks flow browser → backend → STT → translation →
TTS → backend → browser with streaming throughout (no full-utterance blocking, per the
brief).

Decide:
- The turn-taking/endpointing strategy — when is an utterance "done" and sent to
  translation (Deepgram endpointing events? client-side VAD? silence threshold?).
- How partial STT transcripts feed the live source-language transcript display before an
  utterance is finalized.
- How the target-language text is chunked to TTS incrementally (word-by-word streaming
  vs sentence-level) to hit the brief's <2s end-to-end target.
- The browser↔backend protocol (WebSocket message shape) for this mode.
