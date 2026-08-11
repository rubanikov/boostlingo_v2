Type: grilling
Status: claimed
Blocked by: 04, 12

## Question

Given the provider research
([Cascade provider streaming APIs research](04-cascade-provider-research.md)), design the
Cascade mode pipeline: how audio chunks flow browser → backend → STT → translation →
TTS → backend → browser with streaming throughout (no full-utterance blocking, per the
brief).

**Threshold decision, surfaced by
[prior-art research](12-prior-art-reference-implementations.md), that shapes everything
else below:** turn-based endpointing (silence/VAD → STT finalize → translate → speak →
wait for next turn) is the pattern used by every mature framework surveyed (Pipecat,
LiveKit's default `AgentSession`, Vocode) — and multiple independent sources say it's the
*wrong* shape for continuous interpretation specifically: two GitHub issues (LiveKit
agents#3860, Pipecat#1747) are open, unresolved requests for exactly this problem with no
maintainer answer, and OpenAI shipped `gpt-realtime-translate` as a structurally
turn-free model (no `response.create`, no turn boundary) rather than steering
conversational `gpt-realtime` — a deliberate choice that turn-taking doesn't fit
interpretation. The two most transferable continuous-shape patterns found: LiveKit's
`gemini-live-translate` example (persistent session per (speaker, target-language) pair,
250ms-debounced reconciliation, 10s mute grace period, no turn state machine) and the
general "one persistent translation stream per source speaker" shape it shares with
`gpt-realtime-translate`.

Decide, with the time budget in mind (this is one stage of a 15–20hr build that also
needs a working Realtime mode):
- **Segmentation granularity** — full-utterance turn-taking (simple, matches Deepgram's
  `speech_final` directly, but arguably not "real" simultaneous interpretation and the
  thing prior art says is the wrong shape) vs. some form of finer-grained continuous
  chunking closer to the LiveKit/OpenAI pattern (more faithful to genuine live
  interpretation, meaningfully more engineering). Note the brief's own benchmark
  language — "speech end → first audio out" — presupposes *some* discrete
  measurement boundary, so full conversational-turn-taking isn't the only reading; a
  finer per-chunk "speech end" is also consistent with the brief.
- How partial STT transcripts feed the live source-language transcript display before a
  chunk/utterance is finalized.
- How the target-language text is chunked to TTS incrementally (word-by-word streaming
  vs sentence-level — Pipecat names this the SENTENCE-vs-TOKEN tradeoff explicitly) to
  hit the brief's <2s end-to-end target.
- The browser↔backend protocol (WebSocket message shape) for this mode.
