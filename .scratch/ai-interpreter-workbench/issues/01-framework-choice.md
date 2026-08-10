Type: grilling
Status: open

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
