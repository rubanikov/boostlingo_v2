Type: research
Status: open

## Question

What can we learn from existing open-source reference implementations of similar
realtime voice-AI / cascade STT→LLM/Translation→TTS pipelines, and (separately) OpenAI
Realtime API voice-to-voice apps? This is prior-art research, not a framework
recommendation — the brief expects the candidate to build and understand both
architectures directly, so the goal is to learn implementation patterns to build on
top of, not to find something to bolt on wholesale.

Specifically look at actual code (not blog-post summaries) from projects such as:

- **Pipecat** (github.com/pipecat-ai/pipecat) — cascade voice-AI pipeline framework:
  how does it structure the STT/LLM/TTS stage abstraction, VAD/turn-taking,
  interruption handling, and audio frame chunking?
- **LiveKit Agents** (github.com/livekit/agents) — voice agent framework supporting
  both cascade and realtime-API-style pipelines: how does it abstract transport, and
  does it have a translation-specific (as opposed to conversational-agent) example?
- **OpenAI's own reference implementations** (e.g. openai/openai-realtime-console and
  any official realtime-agents examples) — how do they structure the browser-side
  WebRTC/ephemeral-token flow and the UI around it?
- **Vocode** (github.com/vocodedev/vocode-python) or similar older cascade frameworks,
  if still relevant.
- Any open-source project specifically doing **live speech translation/interpretation**
  (continuous translation, not turn-based dialogue) — a genuinely different turn-taking
  shape than a conversational voice agent.

For each, extract: provider-abstraction interface shape, turn-taking/endpointing
approach, browser↔backend protocol design, audio chunking/latency-instrumentation
patterns, and frontend audio-handling patterns (React hooks etc., if applicable).

Findings should explicitly flag which patterns are relevant to
[Framework choice](01-framework-choice.md),
[Cascade pipeline architecture](05-cascade-pipeline-architecture.md),
[Provider abstraction interface design](06-provider-abstraction-design.md), and
[Latency instrumentation design](08-latency-instrumentation-design.md).
