Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 18 — Model / voice pickers wired through both transports + allow-list validation

Type: task · Status: blocked · Tier: **6** · Depends on: 02, 04, 06

Size check: **right-sized (~2.5 hrs).**

> The pickers themselves are rendered by ticket 02 (AC 5.6 is a rendering criterion). This ticket
> makes the picked values actually reach the providers, and closes the Cascade side of the asymmetric
> validation posture. **If this ticket is cut**, the Cascade pickers must be flipped to `disabled`
> with a visible reason per the cut protocol — the Realtime model/voice already work via ticket 04.

## What to build

**Backend scope**
- `orchestrator.py`: `tuning.cascade.translationModel`, `segmentation.model`,
  `transcriptCheck.model`, `ttsVoiceA` / `ttsVoiceB` and `deepgram.model` are read from
  `tuning_state.current` **per segment / per stream**, never from module constants. Out-of-allow-list
  values **fall back to the default and log** — the WS never 400s and never closes (asymmetric
  posture, story AC 5.7).
- `allowlists.elevenlabs_voices()` = the two configured voices + `ELEVENLABS_VOICE_IDS_EXTRA`
  (Step 7 gate answer 3); no hard-coded premade list. `.env.example` documents it.

**Frontend scope**
- `TuningPanel.tsx` Models & voices section wired to the draft (it already renders from
  `capabilities.allowLists`); the footnote naming the server-side allow-list; Realtime `model` /
  `voice` rows marked **"applies at next connect"**.

**Harness scope**: None.

## Acceptance criteria

Story ACs: **5.6** (fixed curated lists, no free text — re-asserted end-to-end here), **5.7**
(HTTP rejects with 400 — already covered by 04; **the Cascade WebSocket falls back to the default
rather than killing the session**).

Brief tests: **S31** *(end-to-end half)*, **F4** *(Cascade fallback, extended to every picker)*.

## Out of scope for this ticket

Adding new models or voices beyond the curated constants; free-text entry (explicitly forbidden).
