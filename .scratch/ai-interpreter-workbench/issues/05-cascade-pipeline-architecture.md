Type: grilling
Status: resolved
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

## Answer

Resolved via a live grilling session, worked through as a Lavish review artifact:
[.lavish/ticket-05-cascade-pipeline-architecture.html](../../../.lavish/ticket-05-cascade-pipeline-architecture.html).

**1. Segmentation granularity — LLM-checked early segmentation (hybrid).** Neither pure
full-turn (ruled out — the shape prior art says is wrong, and it doesn't fit here either)
nor pure continuous chunking (theoretically the most faithful to simultaneous
interpretation, but unsolved even in LiveKit/Pipecat and high time-budget risk). Instead:
as the partial transcript grows, a fast LLM call checks whether the text-so-far forms a
complete, translatable clause; if yes, translate immediately, before any audio pause. If
the LLM says no, is still running, or a check is already in flight, no early cut happens —
Deepgram's `speech_final`/`UtteranceEnd` remain the **guaranteed fallback boundary**, so
worst case this degrades to plain single-utterance segmentation. Concretely: audio
capture and Deepgram STT **never pause** for the LLM check — the check runs as an async
side-channel on a snapshot of the transcript up to word N; a "complete" verdict only ever
applies to that exact word range, so anything the speaker says after the snapshot just
carries into the next window. Checks are debounced so only one is in flight per speaker
at a time. The two boundary signals (LLM verdict, Deepgram endpointing) race
independently; whichever fires first for a given stretch of speech wins.
Closest prior-art parallel: Pipecat's two-stage VAD → "Smart Turn" design, but the
completeness check runs on transcript *text* via an LLM here rather than on raw audio via
a purpose-trained model.

*Naturalness judgment call (not a measured fact, worth confirming by ear once built):*
the hybrid is expected to feel more organic than continuous chunking for this specific
product. True continuous/simultaneous interpretation means the translated voice overlaps
the live speaker — that only sounds smooth when backed by heavy model training (the kind
`gpt-realtime-translate` and LiveKit's `gemini-live-translate` have); a DIY rolling-window
implementation built in this timeframe risks cutting mid-clause, which reads as *more*
jarring, not less. The hybrid produces clean, grammatically complete sentences with brief
pauses — closer to how real human *consecutive* interpretation sounds for a two-party
conversation, which is Boostlingo's actual product (not conference-style simultaneous
interpretation to a passive audience).

**2. Partial transcript display.** Source-language pane streams Deepgram's `is_final`
segments directly to the UI as they arrive (simple live-captioning feel, independent of
segmentation entirely). Target-language pane fills in per translated segment, but streams
the translation LLM's response token-by-token as it generates rather than waiting for the
full segment — reduces perceived latency of the text appearing even though TTS audio lags
slightly behind it.

**3. TTS chunking granularity — TOKEN mode with explicit `flush` at segment boundaries**
(not Pipecat's SENTENCE mode). ElevenLabs' streaming endpoint already buffers internally
via `chunk_length_schedule`, so it doesn't need the caller to pre-batch into sentences;
and since segmentation (decision 1) already cuts at clause boundaries, incoming segments
are already TTS-appropriately sized. Stream translation tokens straight through, call
`flush: true` exactly when a segment completes — gets low latency without adding a
redundant buffering layer on top of one that's already there.

**4. Browser↔backend protocol — one full-duplex WebSocket per Cascade session**, carrying
binary audio frames plus a JSON message envelope (mirrors Pipecat's RTVI pattern from the
prior-art research). Message types: `start_session` (client, sets source/target lang),
binary audio frames (client, continuous mic audio), `source_transcript` /
`target_transcript` (server, both carry a `segmentId` and `isFinal`), `segment_boundary`
(server, carries which mechanism triggered the cut — `llm` or a Deepgram signal — useful
for debugging), `tts_audio_meta` immediately followed by a binary audio frame (server —
binary frames can't carry metadata inline, so a small JSON header precedes each one;
ordering is preserved on a single WebSocket connection), `latency` (server, feeds ticket
08), `error` (server, feeds ticket 10). `segmentId` threads every message belonging to one
translated unit together.
*WebSocket vs. WebRTC, considered and rejected*: WebRTC (what Realtime mode uses) was the
real alternative, not just an oversight. Not chosen because both Deepgram and ElevenLabs
already speak WebSocket themselves — a WebRTC browser↔backend leg would need its own
media-server/transcoding step just to convert back into WebSocket-framed audio before
reaching either provider, adding real infrastructure for no latency/quality benefit. If
mode-transport symmetry with Realtime mode ever mattered more than build time, WebRTC
would be the honest alternative to revisit.

**Translation provider final pick — OpenAI** (over Anthropic). Ticket 04's research called
the two "close to a toss-up" on latency/quality; the tie-breaker is that OpenAI is already
a required dependency for Realtime mode, so using it here too means one fewer distinct
provider/API key to manage within the time budget. The provider abstraction (ticket 06)
keeps this swappable if the comparison write-up later shows Anthropic is meaningfully
better.

**Clarification recorded for future tickets**: ElevenLabs does **not** perform translation
anywhere in this pipeline — Deepgram transcribes, the translation LLM translates,
ElevenLabs only converts already-translated text to speech. ElevenLabs separately sells a
"Dubbing" product that bundles translation + speech generation, deliberately **not** used
here: it would collapse two of the three provider-swap points into one vendor (working
against the brief's provider-abstraction requirement) and isn't built for low-latency
incremental streaming the way the plain TTS endpoint is. (Unverified aside, flagged as
such at the time: Dubbing is almost certainly much higher-latency, since it's built as an
async whole-file workflow rather than a real-time streaming API — not confirmed against
primary sources, and didn't affect the decision either way since Dubbing was already
ruled out on the abstraction-boundary grounds above.)
