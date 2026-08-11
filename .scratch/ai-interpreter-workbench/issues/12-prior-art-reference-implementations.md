Type: research
Status: resolved

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

## Answer

Full findings: [research/prior-art-reference-implementations.md](../research/prior-art-reference-implementations.md)

**Headline finding, folded into ticket 05**: turn-based endpointing (VAD-silence → STT
finalize → respond → speak → wait) is the shape used by Pipecat, LiveKit's default
`AgentSession`, and Vocode — and multiple independent sources say it's the *wrong* shape
for continuous interpretation: LiveKit issue #3860 and Pipecat issue #1747 are open,
unresolved requests for exactly this problem with no maintainer answer; OpenAI's own
`gpt-realtime-translate` ships a structurally turn-free session (no `response.create`,
no turn boundary) specifically because conversational turn-taking doesn't fit
interpretation. The two most transferable continuous-shape patterns found: LiveKit's
`gemini-live-translate` example (one session per (speaker, target-language) pair,
250ms-debounced reconciliation, 10s mute grace period) and the general "one persistent
translation stream per source speaker, no discrete turn" shape shared by that example and
OpenAI's `gpt-realtime-translate`.

**Framework choice**: supports hand-building a thin pipeline rather than adopting
Pipecat/LiveKit Agents wholesale (neither has a finished answer for this project's actual
shape) — but their code is worth studying as design reference: Pipecat's
frame/`FrameProcessor` vocabulary (data/system/control frames, priority-queue
interruption handling) and LiveKit's clean separation of transport
(`AudioInput`/`AudioOutput`) from provider (`STT`/`TTS`/`LLM`) from orchestration
(`AgentSession`).

**Provider abstraction design**: three independently-built frameworks converge on the
same swap point — "one streaming method, in: raw input, out: an async stream of typed
events/frames" — which validates ticket 06's async-generator-based interface direction.
Also notable: **LiveKit deliberately does not unify its cascade STT/TTS/LLM interfaces
with its realtime speech-to-speech (`RealtimeModel`) interface** — they're separate
object families sharing only the outer transport/orchestrator layers. That's evidence
against trying to force this project's cascade and realtime modes into one shared
provider interface; the brief's actual requirement ("clean separation between
mode-specific transport and mode-agnostic UI") doesn't call for that anyway. LiveKit's
`STTCapabilities`-style capability-declaration dataclass (providers self-declare what
they support) is a lightweight pattern worth considering for ticket 06.

**Latency instrumentation**: Pipecat's OpenTelemetry span hierarchy
(conversation → turn → per-service span, each carrying provider identity + a `ttfb`
attribute) is the most complete working example of per-stage latency tracing found —
directly relevant to ticket 08, with the caveat that it's built around "turn" as the
aggregation unit and this project needs an equivalent unit for continuous interpretation
(e.g. a translation-chunk/utterance-window ID). A companion doc's numeric per-stage
latency budget table (stage → measured contribution → running total vs. target) is a
useful structural template for ticket 08's UI, though the actual numbers are specific to
a different, turn-based system and shouldn't be reused as-is.
