Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 14 — Cascade transcript check: off / flag / correct

Type: task · Status: blocked · Tier: **4** · Depends on: 06

Size check: **right-sized (~3.5 hrs).**

## What to build

**Backend scope**
- `backend/app/providers/transcript_check.py` — `TranscriptChecker` / `TranscriptCheckResult`, shaped
  exactly like `segmentation_checker.py` (one client per object, tight explicit timeout
  `httpx.Timeout(6.0, connect=3.0)`, `response_format={"type":"json_object"}`, `max_tokens=200`).
  Any `OpenAIError` or parse failure → `TranscriptCheckResult(flagged=False, corrected_text=None,
  failed=True)` — **never raises**.
- `orchestrator._process_segment`, called **between `_resolve_direction` and the TTS/translation
  kickoff**: `off` ⇒ no call, no latency message, no extra fields; `flag` ⇒ fire the task, let
  translation start immediately with the original text, re-send `source_transcript` with
  `flagged: true` when the verdict lands; `correct` ⇒ `await`, translate
  `result.corrected_text or segment.text`, re-send `source_transcript` with the corrected `text`,
  `flagged: true` and `correctedFrom`. Either way emit
  `{"type":"latency","stage":"transcript_check","ms":<cumulative since speech_end>}`.
  `result.failed` ⇒ the existing non-fatal `retryable: true` error message, original text used.
- `backend/tests/conftest.py`: a **second** autouse fixture stubbing `orchestrator.TranscriptChecker`,
  matching the existing `SegmentationChecker` stub, so legacy tests never hit OpenAI.

**Frontend scope**
- `sessionHandle.ts`: `LatencyStage` gains `'transcript_check'`; `TranscriptSegment` gains
  `flagged?` and `correctedFrom?`.
- `latencyTracking.ts`: `'transcript_check'` in `LATENCY_STAGES`, ordered **after `speech_end`,
  before `translation_first_token`**.
- `WorkbenchPage.tsx` `TranscriptPaneBody`: the flag badge next to the existing trigger annotation —
  `data-testid="segment-suspicious-badge"`, `⚑ check`, `badge badge-warning badge-soft badge-xs`.
  **Badge only, no toast** (Step 3 gate answer 3). The *check-failure* toast is a different event and
  is unchanged.
- `TuningPanel.tsx`: the Cascade **Transcript check** section is now live (`off | flag | correct` +
  check-model select).

**Harness scope**
- `run_tuning_sweep.py` populates the `correctedWer` column when
  `cascade.transcriptCheck.mode == "correct"` (the column is defined in 09).

## Acceptance criteria

Story ACs: **4.1**, **4.3** (flag is non-blocking — translation proceeds with the original text and
does not wait), **4.4** (correct rewrites before translation, displayed transcript updated, dedicated
latency stage), **4.5** (raw **and** corrected WER per item in the report), **4.6** (off ⇒ no call, no
extra latency stage), **4.7** (failure ⇒ original text, session continues, non-fatal toast).

Brief tests: **S26**, **S27**, **F8**, **F9**.

## Out of scope for this ticket

Realtime `flag` (15) — no backend seam exists for it.
