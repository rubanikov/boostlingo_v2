Type: research
Status: open

## Question

How should a browser SPA integrate with OpenAI's Realtime API (model `gpt-realtime`) for
voice-to-voice interpretation?

Specifically:

- (a) Does OpenAI recommend/support a direct browser-to-OpenAI WebRTC connection, and if
  so how does ephemeral token minting work (server mints a short-lived client secret,
  browser connects directly)?
- (b) What's the WebSocket relay alternative (browser → our backend → OpenAI) and its
  latency cost vs (a)?
- (c) What does `gpt-realtime` require/support for a real-time *translation* use case
  specifically (as opposed to open-ended conversation) — system prompt/instructions
  steering it to translate rather than converse, input/output audio format requirements,
  language-pair specification, interim transcript events usable for live captions?
- (d) Known latency characteristics achievable, relevant to the brief's <1.5s end-to-end
  perceived latency target (speech end → first audio out).

Produce a recommendation with citations back to OpenAI's current primary-source docs.
