Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 06 — Cascade start-of-session tuning + non-connection-level live apply

Type: task · Status: blocked · Tier: **1** · Depends on: 01, 02

Size check: **right-sized (~4.5 hrs, top of the band).** Not split further: the halves would be
`DeepgramParams`-refactor-only and `panel-rows-only`, both of which are layer slices with nothing a
human can exercise. The `_SessionTuning` object and the `update_tuning` branch are the same edit.

## What to build

**Backend scope**
- `backend/app/providers/deepgram_stt.py`: `@dataclass(frozen=True) DeepgramParams` **whose defaults
  are today's module-level `Final` constants**, `from_tuning()`, `stream(..., params=None)`,
  `_url(params)`. **The constants stay** — which is why `test_providers.py:291-320`'s URL-substring
  assertions pass unchanged. *(That is a design constraint, not luck.)*
- `backend/app/orchestrator.py`:
  - `_SessionTuning` (`current` / `previous` / `pending` / `request_id` / `reconnecting`),
    **constructed inside `_start_new_session`** alongside the four providers. **Never mutate the
    module-level constants** — doing so would silently re-parameterise every other concurrent
    session's STT connection. This is the single sharpest hazard in the feature.
  - `_parse_cascade_tuning()` — **tolerant** per the documented asymmetric posture: a field that
    fails to parse or falls outside its allow-list/range keeps the current value and logs a warning.
    The WS never 400s and never closes on a bad tuning field.
  - `start_session` accepts `tuning`; the legacy top-level `segmentationMode` stays supported for
    `?segMode=`, and `tuning.cascade.segmentation.mode` **wins** when both are present.
  - Unsolicited `tuning_applied{requestId: null, fingerprint, reconnectedStt: false}` sent
    immediately after `session_started`.
  - `_pump_client_messages` gains the `update_tuning` branch; **non-connection-level** changes
    (segmentation mode/model, transcript-check mode/model, translation model, TTS voices, server
    denoise params) assign `tuning_state.current = new` and reply `tuning_applied{reconnectedStt:
    false}` immediately — these are read *per segment* or *per frame*, so the next one picks them up.
  - `tuning_failed` message shape defined, drawing `message` from the existing
    `_CLIENT_ERROR_MESSAGES` map (raw provider text never reaches the browser).

**Frontend scope**
- `TuningPanel.tsx`: the **Endpointing (Cascade)** section (`endpointingMs`, `utteranceEndMs`,
  `diarize`, summary carrying the `reconnects STT` chip) and the **Segmentation** section
  (`hybrid | llm_priority` join + segmentation model select).
- `useCascadeSession.ts`: `tuning` inside `start_session` (strictly the first message);
  `applyTuning()` sending `{type:"update_tuning", requestId, tuning}`; handling `tuning_applied` /
  `tuning_failed`; the **client-side playback deferral** — hold the config in one `pendingTuningRef`
  slot while `isPlaybackActiveRef.current` is true, flush when playback clears, status line
  `Applying after the current reply…`. Same slot coalesces rapid Applies before they hit the wire.

## Acceptance criteria

Story ACs: **1.4** (start-of-session values observable in the Deepgram connection URL under test),
**1.6** (non-connection-level live apply: no Deepgram restart, effective for the next segment),
**5.7** *(WS half: fall back to the default and log, never kill the session)*.

Brief tests: **S6**, **S8**, **F4**, **F5** *(WS half)*, **E1** (Apply during Cascade TTS playback is
accepted, queued, sent once playback clears — nothing on the wire while `isPlaybackActiveRef` is
true), **E16** (unknown `update_tuning` fields ignored; unknown server message type warned-and-
ignored client-side), plus new `test_providers.py` cases for non-default `DeepgramParams`.

## Out of scope for this ticket

The deliberate reconnect and everything around it (07); the denoise chain in `audio_iter` (16); the
transcript check in `_process_segment` (14).
