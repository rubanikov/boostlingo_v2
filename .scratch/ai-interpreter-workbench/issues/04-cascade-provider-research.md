Type: research
Status: resolved

## Question

For the Cascade mode's STT → Translation → TTS pipeline, research current streaming API
shapes, latency characteristics, and integration requirements for:

- (a) **Deepgram streaming STT** (account already held) — interim vs final transcripts,
  endpointing/VAD support, audio format requirements, WebSocket protocol shape.
- (b) **ElevenLabs streaming TTS** (account already held) — streaming input text →
  streaming audio output, latency, audio format/chunking behavior.
- (c) **Translation stage options** — OpenAI (chat/completions streaming), Anthropic
  Claude (streaming), DeepL (does it support streaming, or is it request/response only?)
  — compare streaming support, latency, quality for EN↔ES, and cost per minute/word.

Recommend a translation provider with justification, and summarize what the STT/TTS
integrations require from the pipeline architecture (message shapes, chunking
granularity, endpointing signals available).

## Answer

Full findings: [research/cascade-provider-apis.md](../research/cascade-provider-apis.md)

- **(a) Deepgram STT** — WS at `wss://api.deepgram.com/v1/listen`. `is_final` (per-segment
  accuracy ceiling) and `speech_final` (endpointing-detected pause) are distinct signals;
  buffer `is_final` segments and flush on `speech_final`. Endpointing defaults to 10ms
  silence (300–500ms recommended for natural conversation). A separate `UtteranceEnd`
  event (1000–5000ms gap, requires `interim_results=true`) and a `SpeechStarted` VAD
  event are also available — these three signals are the candidates for driving a
  turn-taking state machine in ticket 05.
- **(b) ElevenLabs TTS** — WS `stream-input` endpoint takes incremental `SendText`
  messages, buffers by `chunk_length_schedule` (default starts ~120 chars) unless
  `flush: true` is sent — docs explicitly recommend flushing at conversational turn
  boundaries. `eleven_flash_v2_5` claims ~75ms inference / 100–200ms geographic
  time-to-first-byte (not the same as time-to-first-audible-output once client buffering
  is added). ElevenLabs has **no "utterance done" signal of its own** — end-of-turn has
  to be driven from the STT side and threaded through to the TTS `flush` call.
- **(c) Translation** — OpenAI and Anthropic both support token-level SSE streaming;
  **DeepL's core `/v2/translate` is confirmed request/response-only, no streaming** for
  text (it has a separate WebSocket "Voice" product, but that's speech-to-speech, a
  different product). DeepL claims a strong self-reported quality edge in its own blind
  study.
- **Recommendation** — use a streaming LLM (OpenAI or Anthropic) over DeepL for
  translation, since DeepL's lack of streaming works directly against the cascade mode's
  <2s target by forcing a full round-trip before TTS can start. DeepL's quality edge is
  real but self-reported and likely not decisive for short interpreter utterances. OpenAI
  vs. Anthropic is close to a toss-up — explicitly left as input to ticket 05's grilling
  session, not settled here.
- **Pipeline architecture implication** — chunking granularity differs by stage: Deepgram
  frames are ~20–250ms of audio, ElevenLabs' default text-buffering unit is 50–500
  chars, and LLM streams are token-granular (finer than ElevenLabs' default buffering
  unit) — ticket 05 needs to reconcile these three granularities into one pipeline.
