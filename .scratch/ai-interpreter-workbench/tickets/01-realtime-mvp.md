Type: task
Status: ready
Depends on: none — FRONTIER, buildable now in parallel with [02](02-cascade-mvp.md)

# Ticket 1 — Realtime mode: voice-in/voice-out MVP

Size check: right-sized (~2 hrs). WebRTC does the heavy lifting natively
([ticket 07](../issues/07-audio-capture-playback-strategy.md)), so this is
deliberately the thinnest tracer bullet in the set.

## What to build

**Backend**
- `POST /api/realtime/session` — server-to-server call to OpenAI's
  `POST /v1/realtime/client_secrets` using the real API key, returns the
  ephemeral client secret + session config to the browser.
- Session `instructions` steer `gpt-realtime` to translate (turn-based) for a
  hardcoded EN↔ES pair.

**Frontend**
- Minimal SPA shell — a "Connect" button that requests mic permission, drives
  `RTCPeerConnection` directly against OpenAI (SDP offer/answer,
  `pc.addTrack(stream.getTracks()[0])`, data channel `"oai-events"`), and
  `pc.ontrack → <audio>.srcObject` for playback.
- No dual-column UI, language selector, or mode toggle yet — those land in
  [Ticket 3](03-unified-workbench-shell.md).

**Shared one-time setup** (do once, either owner): FastAPI app entrypoint +
`uv` project, Vite/React app shell + npm project. Trivial (~15 min), not worth
its own ticket.

## Acceptance criteria

- Speaking English into the mic produces a spoken Spanish reply audible
  through the browser, and vice versa, using literally `gpt-realtime` (not
  `gpt-realtime-translate` — brief names it "required").
- The real OpenAI API key never reaches the browser; only the short-lived
  ephemeral secret does.
- Perceived speech-end → first-audio-out feels well under the brief's 1.5s
  target by ear (formal instrumentation is [Ticket 6](06-latency-instrumentation.md)
  — this is a manual sanity check, not yet a measured pass/fail).
- Denying mic permission is not required to degrade gracefully yet (deferred
  to [Ticket 7](07-error-handling-resilience.md)) — just shouldn't crash the
  tab.

## API / contract notes

- `POST /api/realtime/session` → mints via `POST /v1/realtime/client_secrets`,
  returns ephemeral secret + session config.
- Browser owns the `RTCPeerConnection` directly against OpenAI once the secret
  is issued — backend is off the audio path from that point on
  ([ticket 03](../issues/03-realtime-transport-architecture.md)).

## Flagged assumption

None for this ticket — see [Ticket 3](03-unified-workbench-shell.md) for the
Realtime-transcript-events assumption that affects this mode's UI wiring.
