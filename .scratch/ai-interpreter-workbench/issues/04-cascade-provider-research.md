Type: research
Status: open

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
