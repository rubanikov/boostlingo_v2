# AI Interpreter Workbench — Map

## Destination

A working AI Interpreter Workbench (Python backend, TypeScript frontend) implementing
both an OpenAI Realtime API voice-to-voice mode and a streaming STT→Translation→TTS
cascade mode in one browser SPA — meeting all 8 functional requirements and the
latency/stability benchmarks in the Boostlingo brief (`project_1778691544728.pdf`), with
swappable provider abstractions, targeted tests on critical paths, a README, an
AGENTS.md/CLAUDE.md, meaningful commit history, and a 1–2 page comparison write-up.
Built locally first; deployed to AWS once functional. Soft target: 3–4 days / ~15–20 hours
of build effort.

## Notes

- Domain: real-time/streaming speech interpretation — ASR (STT), MT (translation), TTS,
  WebRTC/WebSocket transport, LLM realtime voice APIs.
- Stack decided: Python (backend) + TypeScript (frontend). Framework specifics still open
  ([Framework choice](issues/01-framework-choice.md)).
- Already-held provider accounts: OpenAI (required), Deepgram (STT), ElevenLabs (TTS).
  Translation provider decided: OpenAI (see
  [Cascade pipeline architecture](issues/05-cascade-pipeline-architecture.md)).
- Deployment: local-first; AWS deploy deferred to the end, details not yet specified.
- Timeline: soft target, some flexibility — favor sound, explainable decisions (the brief
  asks the candidate to justify choices) over raw speed, but this is a 15–20hr build —
  don't over-invest in any single ticket.
- Skills to consult: `/grilling` + `/domain-modeling` for grilling tickets, `/research`
  subagent for research tickets, `/prototype` for prototype tickets. The context7 MCP
  server is available for pulling current OpenAI/Deepgram/ElevenLabs API docs.
- This map plans architecture and provider decisions only — implementation happens
  afterward as a normal build (e.g. via `/implement`), not as further wayfinder tickets.
- **Cross-cutting flag from prior-art research**: turn-based endpointing (the pattern
  every mature framework surveyed uses by default) is explicitly the wrong shape for
  continuous interpretation per multiple unresolved community threads and per OpenAI's
  own turn-free `gpt-realtime-translate` design. This affects
  [Cascade pipeline architecture](issues/05-cascade-pipeline-architecture.md) most
  directly but echoes into [Realtime transport architecture](issues/03-realtime-transport-architecture.md),
  [Provider abstraction interface design](issues/06-provider-abstraction-design.md), and
  [Latency instrumentation design](issues/08-latency-instrumentation-design.md) — see
  [Prior-art reference implementations](issues/12-prior-art-reference-implementations.md).

## Decisions so far

- [Realtime API integration research](issues/02-realtime-api-integration-research.md) —
  WebRTC direct-to-OpenAI is the supported/recommended browser path (ephemeral token
  minted server-side via `POST /v1/realtime/client_secrets`); WebSocket is
  server-to-server only. Surfaced a real fork: OpenAI also ships a purpose-built
  `gpt-realtime-translate` model/endpoint distinct from the brief-named `gpt-realtime` —
  left for [Realtime transport architecture](issues/03-realtime-transport-architecture.md)
  to resolve.
- [Cascade provider streaming APIs research](issues/04-cascade-provider-research.md) —
  Deepgram (`speech_final`/`UtteranceEnd`/`SpeechStarted`) and ElevenLabs (`flush`-driven
  chunking, no native "done" signal) integration shapes documented. Translation
  recommendation: use a streaming LLM (OpenAI or Anthropic) over DeepL, since DeepL's
  translate endpoint doesn't stream and would blow the <2s cascade target — OpenAI vs.
  Anthropic left open for
  [Cascade pipeline architecture](issues/05-cascade-pipeline-architecture.md).
- [STT/audio quality assurance & mic calibration strategy](issues/11-stt-quality-assurance-mic-calibration.md)
  — level meter + VAD-state indicator + test-mic preflight in the UI; full automation
  chosen for STT-quality testing: TTS-generated WER regression test (`jiwer`) plus a
  Playwright fake-mic E2E test (Chrome's `--use-file-for-fake-audio-capture`) driving the
  real capture→STT path, plus a noise-rejection case. No per-device calibration system —
  browser-level AGC/noise-suppression + level-meter preflight instead; mic device
  coverage is a manual pass only (laptop + one other device on hand), not automated.
- [Prior-art reference implementations](issues/12-prior-art-reference-implementations.md)
  — surveyed Pipecat, LiveKit Agents, OpenAI's own demo repos, Vocode, and continuous-
  translation examples. Headline finding: turn-based endpointing is the wrong shape for
  continuous interpretation (see Notes flag above) — the two most transferable
  continuous-shape patterns are LiveKit's `gemini-live-translate` (per-speaker-session,
  debounced reconciliation) and the "one persistent stream per speaker, no turn boundary"
  shape it shares with `gpt-realtime-translate`. Also: hand-building beats adopting a
  framework wholesale (neither Pipecat nor LiveKit has solved this shape either);
  provider-abstraction swap points converge on "streaming method in, async event stream
  out" across all three frameworks surveyed; LiveKit deliberately keeps cascade and
  realtime provider interfaces separate; Pipecat's OTel conversation→turn→service span
  hierarchy is the closest prior art for latency instrumentation.
- [Cascade pipeline architecture](issues/05-cascade-pipeline-architecture.md) — resolved
  the turn-based-vs-continuous tension: **LLM-checked early segmentation (hybrid)**.
  Partial transcripts stream live (source direct, target per-segment token-streamed).
  TTS chunking: TOKEN mode + flush at segment boundaries. Protocol: one WebSocket,
  JSON envelope + binary audio frames threaded by `segmentId`. Translation provider:
  **OpenAI**. Judgment call recorded: the hybrid is expected to sound more natural than
  continuous chunking for Boostlingo's two-party-conversation product specifically,
  worth confirming by ear once built. Also recorded: ElevenLabs does not translate in
  this pipeline (its separate "Dubbing" product does, deliberately not used — collapses
  provider-swap points and isn't built for streaming).

_(stack/deadline/deployment-target/held-provider-accounts were settled by direct
conversation before charting and are captured in Notes above, not as tickets)_

## Not yet specified

- AWS deployment specifics (service choice, WebSocket-friendly hosting, secrets/env
  management, HTTPS for mic access) — depends on framework choice and a working app;
  not sharp yet.
- Comparison write-up methodology (test scenarios, trial count, subjective-quality
  rubric) — depends on both pipelines existing and producing data; not sharp yet. WER
  measurement approach itself is now settled, see
  [STT/audio quality assurance & mic calibration strategy](issues/11-stt-quality-assurance-mic-calibration.md).
- Language pairs beyond the required English↔Spanish minimum — not decided whether to
  extend.

_(5-minute stability handling graduated into
[Stability: reconnection, drift, memory](issues/13-stability-reconnection-drift-memory.md)
now that the cascade pipeline architecture is decided)_

## Out of scope

_(none yet)_
