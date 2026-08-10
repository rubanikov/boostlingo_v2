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
- Already-held provider accounts: OpenAI (required), Deepgram (STT), ElevenLabs (TTS) —
  prefer these unless a research ticket surfaces a strong reason otherwise, to avoid
  signup friction. Translation provider still open.
- Deployment: local-first; AWS deploy deferred to the end, details not yet specified.
- Timeline: soft target, some flexibility — favor sound, explainable decisions (the brief
  asks the candidate to justify choices) over raw speed, but this is a 15–20hr build —
  don't over-invest in any single ticket.
- Skills to consult: `/grilling` + `/domain-modeling` for grilling tickets, `/research`
  subagent for research tickets, `/prototype` for prototype tickets. The context7 MCP
  server is available for pulling current OpenAI/Deepgram/ElevenLabs API docs.
- This map plans architecture and provider decisions only — implementation happens
  afterward as a normal build (e.g. via `/implement`), not as further wayfinder tickets.

## Decisions so far

_(none yet — stack/deadline/deployment-target/held-provider-accounts were settled by
direct conversation before charting and are captured in Notes above, not as tickets)_

## Not yet specified

- AWS deployment specifics (service choice, WebSocket-friendly hosting, secrets/env
  management, HTTPS for mic access) — depends on framework choice and a working app;
  not sharp yet.
- Comparison write-up methodology (test scenarios, trial count, subjective-quality
  rubric, WER measurement approach) — depends on both pipelines existing and producing
  data; not sharp yet.
- 5-minute stability requirement handling (reconnection strategy, drift/memory-leak
  prevention specifics) — will sharpen once the cascade pipeline architecture exists.
- Language pairs beyond the required English↔Spanish minimum — not decided whether to
  extend.

## Out of scope

_(none yet)_
