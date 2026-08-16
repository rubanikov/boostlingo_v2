Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 07 — Cascade connection-level apply: deliberate Deepgram reconnect + failure dialog

Type: task · Status: blocked · Tier: **1** · Depends on: 06

Size check: **right-sized (~4.5 hrs, top of the band, and the riskiest ticket in the run).** Not
split: the backend sentinel and the client's dialog/status states are one user-visible behaviour
("press Apply, watch the badge go amber, watch the transcript survive"), and splitting produces a
backend-only and a frontend-only half with nothing exercisable in either. If it overruns, the
natural spill-out is the failure `<dialog>` (F7) — **not** the frame-preservation work.

## What to build

**Backend scope** (`backend/app/orchestrator.py`)
- `_RECONNECT` sentinel: `_handle_update_tuning` sets `tuning_state.pending = new`,
  `request_id`, then `audio_queue.put_nowait(_RECONNECT)` — an ordinary object in FIFO order behind
  every already-enqueued frame. A second `update_tuning` before the reconnect completes just
  overwrites `pending`; a fresh sentinel is enqueued **only if `pending` was `None`**, so two
  Applies 200 ms apart produce **exactly one** reconnect with the later config.
- `audio_iter()` gains one line: popping `_RECONNECT` `return`s, ending *this* stream's iterator
  only. Frames after the sentinel stay in the queue, in order.
- `_run_stt`'s `StopAsyncIteration` branch gains the `tuning_state.pending is not None` path: park
  any in-flight clause check (`_park_stale`), **flush a non-empty buffer via
  `_cut_segment(..., trigger="tuning_reconnect", ...)`**, rotate
  `previous / current / pending`, set `reconnecting = True`, `continue` the existing outer
  `while True` so a fresh `audio_iter()` over the **same `audio_queue`** is streamed with
  `DeepgramParams.from_tuning(...)`. On the first result from the new connection, send
  `tuning_applied{reconnectedStt: true}`.
- Failure path in the existing `except ProviderError` handler: **every** failed attempt logs
  (`logger.warning("tuning reconnect attempt %d/%d failed …")`) **and** emits
  `tuning_failed{requestId, attempt, maxAttempts, message}`.
  `maxAttempts = 1 + len(retry_backoffs(exc))` — reuses `_resilience.py`'s existing 3-attempt /
  0.5-1-2 s budget, **no new retry mechanism**. On exhaustion: **revert** to `previous` and keep the
  session running. If the reverted reconnect also fails, fall through to today's terminal path
  unchanged.

> **Do not "simplify" the sentinel into `asyncio.wait({queue.get(), event.wait()})`.** That drops an
> item when the losing `get()` is cancelled after a `put_nowait` has handed it one. The
> sentinel-in-the-queue design is what makes "no frame is lost" true.

**Frontend scope**
- `useCascadeSession.ts`: `tuning_failed` → `console.warn` per attempt (the gate addendum requires
  logging on **both** sides), attempt counter surfaced through `ApplyResult`.
- `TuningPanel.tsx` / `useTuningConfig.ts`: the `Apply (reconnects STT)` label + per-row `reconnects`
  chips (driven by `DEEPGRAM_CONNECTION_LEVEL_PATHS`), reuse of the existing
  `CONNECTION_BADGE.reconnecting` amber badge, the
  `Reconnecting STT with the new parameters… (attempt {i} of {n})` status line, and the
  `role="alertdialog" aria-modal="true"` failure `<dialog>` (`tuning-apply-failed-dialog`,
  `tuning-apply-retry`, `tuning-apply-revert`) with the attempt log, no dismiss-by-backdrop, focus
  trapped and restored to `tuning-apply`.
- `segmentation.ts`: `'tuning_reconnect' → 'reconfig'` in `segmentTriggerLabel`.

## Acceptance criteria

Story ACs: **1.7** (every frame sent before, during and after the reconnect appears in the
transcript — no frame dropped, no segment lost), plus the **Step 3 gate addendum** (no confirmation
dialog; reconnect immediately; existing reconnecting badge; log every failure both sides; dialog with
Retry / Revert after the retry budget).

Brief tests: **S9** (two fake sockets: first got A,B, second got C,D, none dropped or duplicated,
second URL carries the new params), **F6**, **F7**, **E4** (two Applies 200 ms apart ⇒ exactly one
reconnect with the later config), **E6** (the in-flight partial is cut with
`trigger: "tuning_reconnect"` and appears; nothing double-cut).

## Out of scope for this ticket

Anything that isn't a Deepgram connection-level parameter (06 handles those).
