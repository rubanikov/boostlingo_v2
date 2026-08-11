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
- Stack decided: Python (backend) + TypeScript (frontend). Framework specifics decided:
  FastAPI + React, `uv` + Vite/npm (see
  [Framework choice](issues/01-framework-choice.md)).
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
  provider-swap points and isn't built for streaming). **Amended by ticket 06**: protocol
  now carries a `speaker` field, and `start_session` configures a language *pair* rather
  than a fixed direction (see below). **Amended by ticket 08**: `endpointing` bumped
  300ms → 500ms (natural thinking-pauses were getting cut prematurely); new configurable
  segmentation mode (hybrid race, default, vs. LLM-priority with `UtteranceEnd` as a hard
  ceiling) added for empirical A/B testing in the comparison write-up.
- [Test dataset & translation-quality testing](issues/14-test-dataset-translation-quality.md)
  — extends ticket 11's WER dataset to also cover translation quality, which WER doesn't
  touch. Dataset: ~15-20 varied everyday-conversation items (domain-agnostic — corrected
  an earlier unsupported healthcare/legal assumption mid-session), folding in a few
  long/complex sentences plus 2-3 multi-turn snippets reused for
  [Stability: reconnection, drift, memory](issues/13-stability-reconnection-drift-memory.md).
  Translation quality: manual review + LLM-as-judge (explains *what's* wrong, not just a
  score — more actionable than BLEU/COMET, and those need a hand-written reference
  translation per sentence anyway). One shared dataset runs through both modes for a fair
  comparison in the write-up.
- [Framework choice](issues/01-framework-choice.md) — **FastAPI** (backend, matches the
  async-native shape the whole architecture needs) + **React** (frontend, flagged as
  closer to a toss-up with Svelte on pure technical fit, chosen for ecosystem depth) +
  **uv** (Python) + **Vite/npm** (TypeScript).
- [Realtime transport architecture](issues/03-realtime-transport-architecture.md) —
  **WebRTC direct to OpenAI**, ephemeral token minted server-side; per-stage latency
  measured client-side and reported over the data channel, since the backend is off the
  audio path (feeds
  [Latency instrumentation design](issues/08-latency-instrumentation-design.md)). Model:
  **`gpt-realtime` as literally specified**, not the better-fitting
  `gpt-realtime-translate` — the brief calls it "required" with deliberately different
  wording than cascade providers' "candidate's choice"; `gpt-realtime-translate` gets
  real weight in the comparison write-up instead.
- [Provider abstraction design](issues/06-provider-abstraction-design.md) — prototyped
  `providers/base.py` (STT/Translation/TTS `Protocol` interfaces + structured errors) and
  `providers/deepgram_stt.py` (one concrete implementation). **Significant addition**:
  diarization (`diarize=true`) + per-segment language detection (`detect_language=True`),
  added because the brief's "back-and-forth conversation" stability test implies two
  people alternating in two languages, which the original fixed-direction design (ticket
  05) didn't actually support. `speaker` drives transcript labeling + per-speaker TTS
  voice only; translation *direction* comes from detecting which of the 2 configured
  languages each segment is in. **Cascade mode only** — `gpt-realtime` has no equivalent
  lever, a deliberate named difference for the write-up. Amends ticket 05's protocol;
  carries a new requirement forward into [UI/UX layout](issues/09-ui-ux-layout.md).
- [Audio capture & playback strategy](issues/07-audio-capture-playback-strategy.md) —
  splits cleanly by mode off one shared `getUserMedia()` call. **Realtime**: WebRTC native
  for both capture (`addTrack`) and playback (`pc.ontrack` → `<audio>.srcObject`), no
  manual audio handling at all. **Cascade**: AudioWorklet for raw-PCM capture (Float32→
  Int16, ~20-40ms buffering) and Web Audio API buffer scheduling for gapless playback of
  ElevenLabs' raw-PCM output — MediaSource Extensions rejected as a mismatch (built for
  compressed/adaptive-video streaming, not raw-PCM low-latency voice). Gotchas pinned:
  tie `AudioContext` resume to the mic-permission user gesture; catch `NotAllowedError`
  by name for ticket 10's mic-permission-denied case.
- [Latency instrumentation design](issues/08-latency-instrumentation-design.md) — genuinely
  **asymmetric by mode**: Cascade gets a full per-stage running-total table (server owns
  every stage), Realtime gets end-to-end only (backend off the audio path, no sub-stage
  visibility exists) — framed as a real finding for the controllability comparison, not
  hidden. Clock sync: offset re-computed every 30s (not just once — clocks drift over the
  5-minute stability session) plus after any reconnect (ties into ticket 13). Message
  shape extends ticket 05's protocol example with the full stage set. **Triggered an
  amendment to ticket 05** (see above): `endpointing` 300ms→500ms, plus a new
  hybrid-race-vs-LLM-priority segmentation toggle for empirical testing.

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
