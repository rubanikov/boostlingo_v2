Type: research
Status: resolved

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

## Answer

Full findings: [research/realtime-api-integration.md](../research/realtime-api-integration.md)

- **(a) WebRTC direct connection** — OpenAI explicitly supports and recommends a genuinely
  direct browser↔OpenAI WebRTC path. The backend mints an ephemeral token via
  `POST /v1/realtime/client_secrets` (short validity window to *start* a session, not a
  session-length cap); the browser then POSTs its SDP offer straight to OpenAI. The
  backend is off the audio path entirely once the token is issued.
- **(b) WebSocket** — documented as server-to-server only (standard API key, not meant for
  browser auth). A browser wanting WS transport would force a full-session relay through
  our backend for every audio frame both ways — extra hop, TCP head-of-line blocking,
  base64/JSON framing overhead vs WebRTC's UDP media path. OpenAI states WebRTC gives
  "more consistent performance" but publishes no quantified delta.
- **(c) Translation-specific behavior — a real fork worth flagging for ticket 03** —
  `gpt-realtime` (the model literally named in the brief's Technical Requirements) has no
  native translation mode; it's steered via `instructions`/system-prompt and is
  turn-based (OpenAI's own cookbook notes speakers must pause between utterances).
  Separately, OpenAI ships a **purpose-built `gpt-realtime-translate` model** on a
  dedicated `/v1/realtime/translations` endpoint — non-turn-based "translation" session
  type, structured `audio.output.language` targeting, native dual transcript-delta
  streams (`session.input_transcript.delta` / `session.output_transcript.delta`) built
  for live captions. Architecturally different from `gpt-realtime` conversation sessions.
  **This is a brief-vs-fitness tension, not yet resolved** — the brief names `gpt-realtime`
  specifically; `gpt-realtime-translate` may fit the translation use case better. Ticket
  03 needs to decide/flag this explicitly.
- **(d) Latency** — no OpenAI platform-docs page states an absolute end-to-end latency
  number. Documented levers: transport choice, `reasoning.effort` (lower recommended for
  production), VAD/turn-detection tuning, transcription delay/quality dial. Widely-cited
  "~200-500ms" figures trace to OpenAI blog posts that returned HTTP 403 to automated
  fetch this session — flagged as unverified, not a confirmed primary claim.
