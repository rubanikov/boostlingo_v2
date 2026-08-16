Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 15 — Realtime transcript check `flag` via `POST /api/tuning/transcript-check`

Type: task · Status: blocked · Tier: **4** · Depends on: 04, 05, 14

Size check: **right-sized (~2 hrs).**

## What to build

**Backend scope**
- `backend/app/api/tuning.py` gains `POST /api/tuning/transcript-check`:
  `{text, language, mode, model}` → `{flagged, correctedText, elapsedMs}`. `mode ∈ {flag, correct}`;
  `model ∉ TEXT_MODELS` → 400; `text` over 2000 chars → 400. **A provider failure returns
  `200 {"flagged": false, "correctedText": null, "elapsedMs": …, "failed": true}`** — the caller must
  never break on it. Reuses `TranscriptChecker` from 14. No auth (as everything else).

**Frontend scope**
- `useRealtimeSession.ts`: when a source-transcript turn settles and
  `realtime.transcriptCheck.mode === 'flag'`, call the endpoint best-effort and non-blocking; a
  failure is `console.warn`'d and dropped. Render the same `segment-suspicious-badge` from 14.
- `TuningPanel.tsx`: the Realtime **Transcript check** section is now live — `off | flag` only, with
  `correct` `btn-disabled` plus the visible line
  `correct is unavailable: no seam in Realtime.` (a `title` alone is not accessible on a
  non-focusable element).

**Harness scope**: None.

## Acceptance criteria

Story ACs: **4.2** (Realtime offers only `off` / `flag`; `correct` is not selectable), **4.3**
*(Realtime half: non-blocking)*.

Brief tests: **S25** *(behaviour half)*, plus `test_tuning_api.py` cases for the new route.

## Out of scope for this ticket

`correct` mode in Realtime — permanently out of scope (locked decision 4).
