Type: grilling
Status: claimed

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
