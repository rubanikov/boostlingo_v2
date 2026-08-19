Type: task
Status: blocked
Depends on: [01](01-realtime-mvp.md), [02](02-cascade-mvp.md)

# Ticket 3 — Unified workbench shell: mode toggle, language selector, dual-column live transcripts

Size check: right-sized (~2 hrs).

## What to build

**Backend**
- Thin — extend `POST /api/realtime/session` and the Cascade `start_session`
  message to accept a real (not hardcoded) language-pair parameter.

**Frontend**
- Replace both minimal UIs from Tickets 1/2 with the actual winning layout
  (wayfinder [ticket 09](../issues/09-ui-ux-layout.md), variant A): navbar
  with mode tabs (Cascade/Realtime) + language-pair selector
  (`English ↔ Spanish`) + connection-status badge; split dual-column
  source/target transcript panes; mic control with level meter centered at
  bottom (per [ticket 11](../issues/11-stt-audio-quality-mic-calibration.md):
  `AnalyserNode` off the shared `getUserMedia()` stream, RMS/peak level bar).
- Wire mid-session mode switching (cleanly tear down one session type, start
  the other) and pre-session mode selection.
- Reuse the transport/session logic already built in Tickets 1 and 2 — this
  ticket is UI consolidation, not new transport work.

## Acceptance criteria

- Mode can be switched both before a session starts and mid-session (brief
  FR4, literal wording).
- Language pair selector defaults to and supports English ↔ Spanish (brief
  FR5 minimum).
- Both source and target transcripts stream live as they're produced, in both
  modes (brief FR6) — text is appended, not re-rendered per token (ticket 07's
  pinned implementation pitfall).
- Mode-specific transport code (WebRTC vs. WebSocket) is not referenced
  anywhere in shared UI components — the UI only sees a common session
  interface (brief's "clean separation between mode-specific transport and
  mode-agnostic UI" code-quality bar).
- Connection-status badge shows "Connected" once a session is live.

## API / contract notes

Reuses Ticket 1's `/api/realtime/session` and Ticket 2's WS protocol; no new
message types.

## Flagged assumption

The wayfinder never specifies how Realtime-mode transcripts are obtained
(ticket 02's native dual-transcript streams belong to `gpt-realtime-translate`,
which was explicitly *not* chosen). Assumed: standard Realtime API session
config `input_audio_transcription` for the source-language transcript, plus
`response.audio_transcript.delta` events for the target-language spoken
output — both standard `gpt-realtime` session features, just not decided in
any ticket. **Verify against current OpenAI docs before building.**
