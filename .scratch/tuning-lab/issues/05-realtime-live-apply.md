Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 05 — Realtime live apply

Type: task · Status: blocked · Tier: **1** · Depends on: 04

Size check: **right-sized (~2.5 hrs).**

> **Single-sided by design, and allowed.** Brief §2 is explicit: *"Live apply — Realtime
> (client-only, no backend involvement)"*. The backend sees nothing after minting the token. Adding
> a backend leg here would be inventing a seam the transport does not have.

## What to build

**Frontend scope**
- `sessionHandle.ts`: `applyTuning?: (config: ModeTuningConfig) => Promise<ApplyResult>` (the
  documented optional-member extension pattern, already used 5×), plus the `ApplyResult` union.
- `useRealtimeSession.ts`:
  - `pc.createDataChannel('oai-events')` gains
    `onopen = () => { dcReadyRef.current = true; flushPendingTuning(); }`; **never `send()` unless
    `readyState === 'open'`** (it is receive-only today).
  - `applyTuning(config)`: if a reply is streaming (between
    `response.output_audio_transcript.delta` and `response.done` + `REALTIME_MUTE_TAIL_MS`) **or**
    the channel isn't open → store in a **single** `pendingTuningRef` slot and return
    `{ok: true, deferred: true}` (last write wins ⇒ **rapid Applies coalesce for free**);
    otherwise send exactly the GA `session.update` shape from the brief (`session.type: "realtime"`,
    only `audio.input` present, absent-key idiom preserved, `"off"` ⇒ `noise_reduction: null`).
  - `response.done`'s existing unmute timeout **and** `dataChannel.onopen` both call
    `flushPendingTuning()`.
  - `model` / `voice` rows are marked **"applies at next connect"** — they are not live-updatable.
- `useTuningConfig.ts` / footer: `Applying…` spinner state, `Applied · cfg:… · HH:MM:SS`,
  `Applying after the current reply…` deferred status.
- `frontend/src/test/mockRealtimeApis.ts`: `MockRTCDataChannel` gains `readyState` and `emitOpen()`.

**Backend scope**: None (by design). **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.5** (a `session.update` with the new value goes out on `oai-events`, the session is
**not** torn down, the panel shows it applied).

Brief tests: **S7**, **E2** (Apply during a streaming reply is queued and fires after
`response.done` + `REALTIME_MUTE_TAIL_MS`), **E3** (Apply while the channel is `connecting` is
flushed by `onopen`).

## Out of scope for this ticket

Anything Cascade; the failure dialog (Realtime `session.update` cannot fail the way a Deepgram
reconnect can — the dialog belongs to 07).
