Type: grilling
Status: resolved

## Question

Given Python (backend) + TypeScript (frontend) is decided, which specific web framework
and frontend framework/tooling should this app use?

Needs to support: WebSocket/WebRTC streaming to two different providers concurrently
(mode toggle between Realtime and Cascade), fast iteration within a 15–20hr budget, and
clean separation between mode-specific transport and mode-agnostic UI (a stated
code-quality requirement in the brief).

Candidates to weigh:
- Backend: FastAPI vs Flask (async WebSocket support, ease of streaming, ecosystem for
  provider SDKs)
- Frontend: React vs Vue vs Svelte vs vanilla+Vite
- Package manager / build tooling: uv/poetry for Python; vite/pnpm (or equivalent) for TS

[Prior-art research](12-prior-art-reference-implementations.md) supports hand-building a
thin pipeline rather than adopting a framework like Pipecat or LiveKit Agents wholesale
(neither has a finished answer for this project's continuous-interpretation shape either
— see [Cascade pipeline architecture](05-cascade-pipeline-architecture.md)) — this isn't
a dependency decision so much as confirmation that no framework needs weighing here as an
alternative to FastAPI/Flask + React/Vue/Svelte. Their code is still worth studying as
design reference (Pipecat's frame/processor vocabulary; LiveKit's transport/provider/
orchestration layering), independent of what gets picked here.

## Answer

Resolved via a live grilling session as a Lavish review artifact:
[.lavish/ticket-01-framework-choice.html](../../../.lavish/ticket-01-framework-choice.html).

- **Backend: FastAPI.** The whole architecture (ticket 05) is fundamentally an
  async-concurrency problem — continuous audio streaming, concurrent calls to
  Deepgram/OpenAI/ElevenLabs, an async LLM clause-check running alongside all of it.
  FastAPI's native async support and first-class WebSocket handling fit that shape
  directly; Flask would need Flask-SocketIO or a switch to Quart to match it, extra
  plumbing for no benefit.
- **Frontend: React.** Flagged as genuinely closer to a toss-up than the backend
  pick — Svelte is arguably the better technical fit for a UI dominated by
  high-frequency streaming updates (live transcript tokens, latency numbers), since
  its reactivity has no virtual-DOM diffing overhead. React chosen as the default
  given the largest ecosystem of WebSocket/audio-hook examples to draw from quickly
  and broadest recognizability for an evaluator skimming the submission — confirmed
  as the pick.
- **Tooling: `uv`** for Python (fast, unified venv/dependency/lockfile tool), **Vite +
  npm** for TypeScript (Vite is the near-universal SPA dev-server/bundler default;
  plain npm over pnpm since the marginal speed/disk edge isn't worth an extra install
  step for a short-lived project).
