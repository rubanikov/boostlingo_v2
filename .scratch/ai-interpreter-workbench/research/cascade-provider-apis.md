# Cascade mode STT -> Translation -> TTS: provider API research

Research input for the AI Interpreter Workbench wayfinder map. This document is **input to a later human "grilling" decision session** — it recommends a translation provider with justification, but does not make the final call, and it does not design the pipeline architecture. All API shapes, latency numbers, and pricing below were fetched from each provider's own current documentation on **2026-08-10**; these APIs and prices change over time, so treat figures as "as researched on this date," not as a permanent contract.

---

## (a) Deepgram streaming STT

### Connection and protocol shape

- WebSocket endpoint: `wss://api.deepgram.com/v1/listen`, authenticated via an `Authorization` header. [Deepgram Streaming (Live Audio) reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- Client-to-server message types: `ListenV1Media` (binary audio payload), `ListenV1Finalize` (flush the stream and force finalization), `ListenV1CloseStream` (terminate), `ListenV1KeepAlive` (keep an idle connection open). [Deepgram Streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- Server-to-client message types: `ListenV1Results` (transcription output), `ListenV1Metadata` (session info), `ListenV1UtteranceEnd` (speech-boundary event), `ListenV1SpeechStarted` (speech-onset event). [Deepgram Streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- Audio is sent as raw binary frames over the open socket (e.g. `connection.sendMedia(...)` / `connection.send_media(...)` in the SDKs) — there is no JSON envelope around audio chunks themselves. [Deepgram Getting Started: Live Streaming Audio](https://developers.deepgram.com/docs/live-streaming-audio)

### Interim vs. final transcripts

- Enable interim transcripts by adding `interim_results=true` to the connection query string. [Deepgram Interim Results docs](https://developers.deepgram.com/docs/interim-results)
- `is_final` (boolean, on every `Results` message): `false` means Deepgram may still revise this segment as more audio arrives; `true` means Deepgram has reached its accuracy ceiling for that segment and it will not change further. [Deepgram Interim Results docs](https://developers.deepgram.com/docs/interim-results)
- `speech_final` (boolean): set to `true` when Deepgram's endpointing detects a natural pause and considers the utterance complete — a distinct signal from `is_final`. [Deepgram Endpointing/Interim Results guide](https://developers.deepgram.com/docs/understand-endpointing-interim-results)
- Recommended client-side reconstruction pattern: append each `is_final: true` segment's transcript to a buffer as it arrives; when `speech_final: true` arrives, the buffer holds the complete utterance — clear it and start the next one. [Deepgram Endpointing/Interim Results guide](https://developers.deepgram.com/docs/understand-endpointing-interim-results)
- Example `Results` message shape (fields relevant to the pipeline: `is_final`, `speech_final`, per-word timing/confidence):

  ```json
  {
    "type": "Results",
    "channel_index": [0],
    "duration": 1.5,
    "start": 0.0,
    "is_final": true,
    "speech_final": true,
    "channel": {
      "alternatives": [
        {
          "transcript": "hello world",
          "confidence": 0.95,
          "words": [
            { "word": "hello", "start": 0.1, "end": 0.5, "confidence": 0.98, "punctuated_word": "Hello" },
            { "word": "world", "start": 0.6, "end": 1.0, "confidence": 0.92, "punctuated_word": "world" }
          ]
        }
      ]
    }
  }
  ```
  [Deepgram Streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)

### Endpointing / VAD support

- Endpointing is **enabled by default**, with a default silence threshold of **10 ms**; it uses an audio-based Voice Activity Detector that watches for a sufficiently long pause and, on detecting one, sets `speech_final: true`. [Deepgram Endpointing docs](https://developers.deepgram.com/docs/endpointing)
- Configurable via `endpointing=<milliseconds>` (e.g. `endpointing=300`) or disabled entirely with `endpointing=false` to fall back on Deepgram's internal chunking. [Deepgram Endpointing docs](https://developers.deepgram.com/docs/endpointing)
- Guidance on values: the 10 ms default suits fast chatbot-style short utterances; 300–500 ms is recommended for natural conversation with mid-thought pauses. [Deepgram Endpointing/Interim Results guide](https://developers.deepgram.com/docs/understand-endpointing-interim-results)
- Separate **UtteranceEnd** feature (`utterance_end_ms=<1000-5000>`) analyzes interim+final results for a gap of the configured length after the *last finalized word* and emits a standalone `UtteranceEnd` event — useful when endpointing alone isn't reliable (noisy audio, speech that doesn't naturally pause). Requires `interim_results=true`; `vad_events=true` and `endpointing=300` are recommended alongside it. [Deepgram UtteranceEnd docs](https://developers.deepgram.com/docs/utterance-end)

  ```json
  { "type": "UtteranceEnd", "channel": [0, 1], "last_word_end": 2.395 }
  ```
  [Deepgram UtteranceEnd docs](https://developers.deepgram.com/docs/utterance-end)

- Independent **SpeechStarted** event (`vad_events=true`) fires as soon as VAD detects speech onset after silence — useful as an early "user started talking" signal, decoupled from transcription timing:

  ```json
  { "type": "SpeechStarted", "channel": [0, 1], "timestamp": 9.54 }
  ```
  [Deepgram SpeechStarted docs](https://developers.deepgram.com/docs/speech-started)

### Audio format requirements

- Supported `encoding` values on the streaming endpoint: `linear16`, `linear32`, `flac`, `alaw`, `mulaw`, `amr-nb`, `amr-wb`, `opus`, `ogg-opus`, `speex`, `g729`; plus `sample_rate` and `channels` (default 1) query params. [Deepgram Streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)
- Model selection is via `model` (e.g. `nova-3`); if omitted, the API falls back to a default (documented as `base`). [Deepgram Getting Started: Live Streaming Audio](https://developers.deepgram.com/docs/live-streaming-audio)
- No single official page pins an exact minimum/maximum audio chunk size for streaming; community/production guidance repeatedly cited across Deepgram's own discussion forum and drive-thru case studies puts **20 ms as a common production chunk size (no smaller), with an upper bound around 250 ms**, trading off latency (smaller chunks) against per-frame overhead (larger chunks). This specific numeric range is reported by secondary sources (Deepgram's own developer community discussions and blog) as of the research date; the primary streaming reference and getting-started pages describe the mechanism (binary frames sent as available) but do not themselves state a required chunk-size number.

---

## (b) ElevenLabs streaming TTS

### Streaming input text -> streaming audio output

- WebSocket endpoint: `GET /v1/text-to-speech/{voice_id}/stream-input`, servers include `wss://api.elevenlabs.io/` (plus regional-residency variants for US/EU/India/Singapore). [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- Client → server message sequence:
  1. **InitializeConnection** (must be first): a single-space `text`, `voice_settings` (stability, similarity_boost, style, speaker_boost, speed), `generation_config.chunk_length_schedule`, optional pronunciation dictionaries; auth via `xi-api-key` header. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
  2. **SendText**: incremental `text` chunks (each ending in a space), optional `flush: true` to force immediate generation of buffered text — the documented pattern for real-time conversational agents is to `flush` at each conversational turn boundary. [ElevenLabs Realtime TTS how-to](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
  3. **CloseConnection**: empty-string `text` to end the stream. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- Server → client messages: **AudioOutput** (`audio`: base64-encoded chunk, default MP3; plus `alignment`/`normalizedAlignment` character-timing data), and a final **FinalOutput** (`isFinal: true`) signaling generation complete. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- Internal buffering: ElevenLabs delays audio generation until enough text accumulates, governed by `chunk_length_schedule` (default `[120, 160, 250, 290]` characters — first chunk triggers at 120 characters, thresholds increase from there); this range is user-configurable between 50–500 characters, and trades "quality through more context" against latency. `flush: true` overrides the schedule to force immediate synthesis of whatever text is buffered. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input); [ElevenLabs Realtime TTS how-to](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
- Idle connections auto-disconnect after 20 seconds; documentation recommends sending periodic space characters to keep long-lived connections alive. [ElevenLabs Realtime TTS how-to](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
- Three integration surfaces exist: a regular (full, non-streaming) endpoint, an HTTP streaming endpoint (SSE-style progressive audio for text that's fully available up front), and the WebSocket endpoint (bidirectional, built for text arriving incrementally — e.g. from an LLM). [ElevenLabs Latency Optimization guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization)

### Latency

- `eleven_flash_v2_5` is ElevenLabs' latency-optimized model, documented at **~75 ms inference/time-to-first-byte** (model processing only, excluding network/application overhead), and is the model the docs explicitly recommend for real-time conversational agents. [ElevenLabs Models overview](https://elevenlabs.io/docs/overview/models)
- Geographic time-to-first-byte figures for Flash + WebSockets: **100–150 ms** for North America/Europe/Southeast Asia, **150–200 ms** for South Asia/Northeast Asia. [ElevenLabs Latency Optimization guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization)
- Flash trades some audio quality and default numeral/date/currency normalization for that latency ("numbers aren't normalized by default... to maintain the low latency"); `apply_text_normalization` can restore this but is gated to Enterprise plans for v2.5-family models. [ElevenLabs Models overview](https://elevenlabs.io/docs/overview/models)
- Turbo v2.5 is functionally equivalent to Flash v2.5 but with somewhat higher latency; ElevenLabs' own docs now recommend Flash in all cases (Turbo is being phased out). [ElevenLabs Models overview](https://elevenlabs.io/docs/overview/models)
- Higher-fidelity output formats increase latency — there is an explicit format-vs-latency tradeoff documented alongside model choice. [ElevenLabs Latency Optimization guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization)

### Audio format / chunking behavior on output

- Output formats are named `<codec>_<sample_rate>_<bitrate>`. Supported families: **MP3** (22.05 kHz/16-bit @ 32 kbps; 44.1 kHz/16-bit @ 32/64/96/128 kbps on Free/Starter, up to 192 kbps on Creator+); **PCM** (8/16/22.05/24 kHz on Free–Creator tiers, 44.1 kHz on Pro+, plus 48 kHz); **Opus** (48 kHz @ 32–192 kbps); **µ-law** and **A-law** (8 kHz, i.e. telephony-grade). [ElevenLabs "What audio formats do you support?" help doc](https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support)
- Default response format is MP3 unless `output_format` is set otherwise on the request/connection. [ElevenLabs "What audio formats do you support?" help doc](https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support)
- Streaming HTTP endpoints deliver raw audio bytes via chunked transfer encoding so a client can start playback before the full response finishes; the WebSocket endpoint delivers the same audio as a sequence of base64 `AudioOutput` messages instead. [ElevenLabs "What audio formats do you support?" help doc](https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support); [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)

### Pricing (for cost context)

- Official per-1,000-character API rates: **Flash/Turbo models: $0.05 / 1K characters**; **Multilingual v2/v3: $0.10 / 1K characters**. [ElevenLabs API pricing page](https://elevenlabs.io/pricing/api)

---

## (c) Translation stage options: OpenAI, Anthropic Claude, DeepL

### Streaming support

| Provider | Streaming? | Protocol / chunk shape |
|---|---|---|
| **OpenAI** | Yes | Set `stream: true` on Chat Completions; server sends `data:`-prefixed SSE events, each a `chat.completion.chunk` object with a `choices[].delta.content` string carrying the incremental text; stream ends when a chunk's `finish_reason` is set (`stop`, `length`, etc.), with `[DONE]` as the terminal SSE marker in the classic Chat Completions transport. [OpenAI Chat Completions streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events); [OpenAI Streaming API guide](https://developers.openai.com/api/docs/guides/streaming-responses) |
| **Anthropic Claude** | Yes | Set `"stream": true` on the Messages API; SSE event sequence is `message_start` → repeated `content_block_start` / `content_block_delta` (`delta.type: "text_delta"`, `delta.text: "..."`) / `content_block_stop` → one or more `message_delta` → `message_stop`, plus periodic `ping` events. [Anthropic Streaming Messages docs](https://platform.claude.com/docs/en/build-with-claude/streaming) |
| **DeepL** | **No, for text translation.** The core `POST /v2/translate` endpoint is strictly request/response: it returns one JSON object (`translations[].text`, `detected_source_language`, `billed_characters`) once the whole translation is complete — no chunked/incremental response. [DeepL Translate Text API reference](https://developers.deepl.com/api-reference/translate); [DeepL API docs quickstart](https://developers.deepl.com/docs) |

  Notably, DeepL does offer a **separate WebSocket "Voice" streaming API** (`/api-reference/voice/websocket-streaming`) — but this is a distinct product for real-time **speech-to-speech** translation (streams audio in, emits source transcription + target transcription + target-language synthesized audio, all in one connection, recommended 50–250 ms audio chunk intervals). It is not a streaming mode of the text-translation endpoint, and using it would mean DeepL replacing the Deepgram+TTS pair rather than sitting in the middle of this cascade's pipeline as designed. [DeepL WebSocket Streaming (Voice) reference](https://developers.deepl.com/api-reference/voice/websocket-streaming) — worth flagging to the human reviewer as an alternative architecture, out of scope for this ticket's cascade design as specified.

- OpenAI's Chat Completions delta granularity is effectively token/sub-word chunks as they're generated — well suited to piping partial translated text into ElevenLabs' `SendText` messages as it arrives. [OpenAI Chat Completions streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- Anthropic's `text_delta` events are likewise incremental text fragments (not sentence- or word-aligned) suitable for the same downstream chunk-forwarding pattern. [Anthropic Streaming Messages docs](https://platform.claude.com/docs/en/build-with-claude/streaming)

### Latency characteristics

- Neither OpenAI's nor Anthropic's official docs publish a fixed "ms to first token" latency number for translation-style prompts — first-token latency is a function of model size, prompt length, and load. No latency claim is asserted here beyond "streaming reduces perceived latency by surfacing partial output before generation completes," which both providers state generically. [OpenAI Streaming API guide](https://developers.openai.com/api/docs/guides/streaming-responses); [Anthropic Streaming Messages docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- DeepL's text endpoint is single-shot request/response with no documented latency SLA on the quickstart/reference pages fetched. [DeepL Translate Text API reference](https://developers.deepl.com/api-reference/translate)
- Practically, for a <2s end-to-end cascade budget, a non-streaming translation call (DeepL) adds one full round-trip of latency in the middle of the pipeline (STT final segment -> full translation response -> TTS start), whereas a streaming LLM call (OpenAI/Anthropic) lets translated-text chunks start flowing into TTS before the full sentence is translated — this is a direct architectural consequence of the streaming-support difference in the table above, not a benchmarked number from any of the three docs.

### Quality signal for EN<->ES

- DeepL positions itself specifically on translation quality and publishes head-to-head blind-test results: in DeepL's **March 2026** evaluation (48,000 blind evaluations, 80 test groups, 16 language pairs, judged by professional native-speaking linguists), DeepL reports a **94% win rate** across those language pairs against GPT-5.2, Gemini 3.1 Pro, and Claude Opus 4.6 combined, and a **100% win rate (16/16 language pairs)** specifically against GPT-5.2 and separately against Google Translate. [DeepL Quality page](https://www.deepl.com/en/quality)
- OpenAI and Anthropic do not publish translation-specific quality benchmarks on their own docs/pricing pages — GPT and Claude models are general-purpose LLMs that translate well when prompted, but neither company makes a quality claim comparable to DeepL's for this specific task; the quality comparison above is DeepL's own (self-reported) benchmark, not an independent third party, and should be read with that caveat.
- DeepL also publishes a **separate** benchmark for its Voice (speech-to-speech) product (96.4 quality score vs. 87–89 for Teams/Meet/Zoom, per a cited 2026 Slator report) — this is a different product from the text-translation endpoint under consideration here and is included only for completeness. [DeepL Quality page](https://www.deepl.com/en/quality)

### Cost (per official pricing pages, as of 2026-08-10)

| Provider / model | Input | Output | Billing unit |
|---|---|---|---|
| OpenAI GPT-4o-mini | $0.15 / MTok | $0.60 / MTok | per token |
| OpenAI GPT-5-mini | $0.25 / MTok | $2.00 / MTok | per token |
| OpenAI GPT-5 | $1.25 / MTok | $10.00 / MTok | per token |
| OpenAI GPT-4o | $2.50 / MTok | $10.00 / MTok | per token |
| Anthropic Claude Haiku 4.5 | $1 / MTok | $5 / MTok | per token |
| Anthropic Claude Sonnet 5 (through 2026-08-31) | $2 / MTok | $10 / MTok | per token |
| Anthropic Claude Sonnet 5 (from 2026-09-01) | $3 / MTok | $15 / MTok | per token |
| DeepL Developer plan | 1,000,000 characters included (evaluation) | — | per character (source text only) |
| DeepL Growth plan | 500,000 input characters/month included, then $5 / million input characters | — | per character (source text only) |

Sources: [OpenAI API pricing (developers.openai.com)](https://developers.openai.com/api/docs/pricing); [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing); DeepL Developer/Growth plan pricing as summarized from DeepL's own plan documentation (accessed via [developers.deepl.com](https://developers.deepl.com/docs); DeepL has retired the old flat-fee API Free/Pro plans as of mid-2026 in favor of Developer/Growth).

For scale intuition: a short interpreter utterance (~15 words, roughly 75–90 characters / ~20 tokens in, ~20–25 tokens out) costs a small fraction of a cent on any of these three providers at these rates — for this workbench's likely usage volume (a take-home demo, not production call-center scale), **the per-call cost difference between OpenAI/Anthropic/DeepL is immaterial**; the streaming-vs-not and quality differences matter far more than the cost differences at this scale.

---

## Recommendation: translation provider

**Recommendation for the human review session: use a streaming LLM (OpenAI or Anthropic) rather than DeepL for the cascade mode's translation stage, with a slight lean toward Anthropic Claude (Haiku or Sonnet) if the team already standardizes on Claude elsewhere in the project, otherwise OpenAI GPT-4o-mini/GPT-5-mini is an equally defensible pick.**

Reasoning to weigh in the grilling session, not a final decision:

1. **Streaming is architecturally decisive for a <2s target.** DeepL's text-translation endpoint is confirmed request/response-only by its own API reference — there is no way to start feeding partial translated text into ElevenLabs' `SendText` WebSocket messages until the *entire* DeepL response returns. [DeepL Translate Text API reference](https://developers.deepl.com/api-reference/translate) Both OpenAI and Anthropic support token-level SSE streaming, which lets the pipeline start TTS synthesis on the first translated words while the rest of the sentence is still being translated — directly shrinking the STT-final -> TTS-first-audio gap that the <2s budget has to fit. [OpenAI Chat Completions streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events); [Anthropic Streaming Messages docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
2. **DeepL's quality edge is real but is being weighed against a hard latency constraint, and DeepL's own benchmark is self-reported.** DeepL's claimed 94–100% win rates against GPT-5.2/Claude Opus 4.6/Google Translate are the strongest quality signal found in this research, but they come from DeepL's own published study, and they say nothing about how DeepL's *streaming-less* endpoint fits a <2s pipeline. [DeepL Quality page](https://www.deepl.com/en/quality) For a short-utterance interpreter use case (not literary or highly ambiguous text), the quality gap between DeepL and a well-prompted GPT/Claude call on common EN<->ES sentence pairs is unlikely to be the deciding factor a human evaluator would notice in a live demo, whereas an added ~200-500ms+ round trip for a non-streaming call is very likely to be noticeable against a 2-second budget.
3. **Cost is a non-issue at this scale** — all three providers charge fractions of a cent per typical utterance; the pricing table above should not drive the decision. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing); [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
4. **OpenAI vs. Anthropic is close to a coin flip** on the evidence gathered here — both offer equivalent SSE streaming shapes, comparable small-model pricing (GPT-4o-mini $0.15/$0.60 per MTok vs. Claude Haiku 4.5 $1/$5 per MTok — OpenAI's small model is cheaper, though the gap is immaterial per point 3), and neither publishes an EN<->ES-specific quality benchmark. The tie-breaker offered here is ecosystem consistency: if the Realtime voice-to-voice mode of this same workbench is already built on OpenAI's Realtime API, using OpenAI for the cascade's translation stage too may reduce the number of SDKs/auth patterns in the codebase — but this is a project-structure argument, not a translation-quality or latency argument, and the human reviewer may reasonably weigh it differently (e.g., prefer Anthropic specifically to diversify vendor risk or because Claude is already the team's default).
5. A DeepL-in-a-chain design could still be made to work under 2s (DeepL is fast in absolute terms, just not chunked), but it forces the pipeline into a strict "wait for full translation, then start TTS" shape rather than the more parallelizable "stream translation, feed TTS incrementally" shape the other two providers enable — this is the crux the human should confirm or overrule.

---

## Implications for pipeline architecture

This section summarizes what the STT and TTS integrations *require or make available*, per the docs above, for whoever designs the cascade pipeline against a <2s end-to-end target — it does not itself propose a design.

**Message shapes the pipeline must handle:**
- From Deepgram: a stream of `Results` messages, each carrying `is_final` and `speech_final` booleans plus word-level timing/confidence; optionally standalone `SpeechStarted` and `UtteranceEnd` events if `vad_events`/`utterance_end_ms` are enabled. [Deepgram Streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming); [Deepgram UtteranceEnd docs](https://developers.deepgram.com/docs/utterance-end); [Deepgram SpeechStarted docs](https://developers.deepgram.com/docs/speech-started)
- To the translation stage: either a one-shot full string (if waiting for `speech_final`/`UtteranceEnd`) or a stream of growing/interim text (if translating on `is_final` segments as they arrive, accepting some rework risk since interim text can still be revised).
- From the translation stage: an SSE/delta stream of text fragments (OpenAI/Anthropic) — the pipeline needs a small buffering/aggregation layer to decide how much translated text to accumulate before forwarding to TTS (word-by-word forwarding to ElevenLabs is possible but works against ElevenLabs' own chunk-length-schedule quality/latency tradeoff).
- To ElevenLabs: `SendText` messages carrying incremental text plus an explicit `flush: true` at the point the pipeline considers the translated utterance complete (e.g., mirroring Deepgram's `speech_final`/`UtteranceEnd` signal) — ElevenLabs' own real-time guide explicitly recommends `flush` at conversational turn boundaries. [ElevenLabs Realtime TTS how-to](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
- From ElevenLabs: a stream of base64 `AudioOutput` chunks terminated by `FinalOutput.isFinal: true`. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)

**Chunking granularity available at each stage:**
- STT input (client mic -> Deepgram): binary audio frames: production guidance points to roughly 20 ms as a common low-latency chunk floor and ~250 ms as a practical ceiling before per-frame overhead / added latency becomes the bigger cost; this specific numeric range comes from Deepgram's own developer community/case-study material rather than the core API reference, which only specifies the encoding/sample-rate parameters and leaves chunk cadence to the client.
- STT output (Deepgram -> translation): word-level granularity available inside each `Results` message; utterance-level granularity available via `speech_final`/`UtteranceEnd`. The pipeline can choose either granularity as its unit of work.
- Translation output (LLM -> TTS): token/sub-word granularity from both OpenAI and Anthropic SSE streams — finer than ElevenLabs' own default buffering unit (~120+ characters per the default `chunk_length_schedule`), so the pipeline will likely want to accumulate a few translation deltas before pushing to ElevenLabs rather than forwarding every token individually.
- TTS input (translation/pipeline -> ElevenLabs): `chunk_length_schedule` (character thresholds, default `[120, 160, 250, 290]`, tunable 50-500) governs when ElevenLabs starts synthesizing; `flush: true` is the override for "synthesize whatever's buffered now," which is the natural mechanism to trigger at utterance end. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- TTS output (ElevenLabs -> playback): base64 audio chunks delivered as generated; output format (MP3/PCM/Opus/µ-law/A-law, at various sample rates/bitrates) is chosen up front via `output_format` and trades fidelity for latency — µ-law/PCM at low sample rates being the lowest-latency choices, consistent with the docs' general "higher-fidelity formats add latency" guidance. [ElevenLabs "What audio formats do you support?" help doc](https://elevenlabs.io/docs/help-center/troubleshooting/what-audio-formats-do-you-support); [ElevenLabs Latency Optimization guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization)

**Endpointing/turn-boundary signals available to drive the pipeline's state machine:**
- Deepgram gives three independent, differently-timed signals the pipeline can use to decide "the speaker is done": `speech_final` (per-segment, tied to the `endpointing` silence threshold, default 10 ms / recommended 300-500 ms for natural conversation), `UtteranceEnd` (a standalone event after a configurable 1000-5000 ms gap following the last finalized word, more robust to noisy/non-pausing speech), and `SpeechStarted` (fires on speech onset, useful for barge-in/interruption handling rather than end-of-turn). [Deepgram Endpointing docs](https://developers.deepgram.com/docs/endpointing); [Deepgram UtteranceEnd docs](https://developers.deepgram.com/docs/utterance-end); [Deepgram SpeechStarted docs](https://developers.deepgram.com/docs/speech-started)
- ElevenLabs offers no equivalent "detect the end of input text" signal — the caller is fully responsible for telling it when an utterance is complete via `flush: true`, which means whichever Deepgram end-of-turn signal the architecture chooses (`speech_final` vs `UtteranceEnd`) is effectively also what schedules the `flush` call on the TTS side, coupling the two integrations' timing directly. [ElevenLabs WebSocket API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input)
- Whichever translation provider is chosen, neither OpenAI's nor Anthropic's streaming API exposes a mid-stream "this sentence is done" signal beyond the final `finish_reason`/`message_stop` for the *whole* response — sentence-boundary detection within a streaming translation, if needed before the full response completes, would have to be done by the pipeline itself (e.g. watching for terminal punctuation in the delta text), not by the provider.
