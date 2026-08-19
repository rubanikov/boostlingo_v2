Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 02 — Tuning panel shell: sections, knob primitives, Apply/Revert

Type: task · Status: blocked · Tier: **1** · Depends on: 01

Size check: **right-sized (~3.5 hrs).**

## What to build

The panel as a shell you can open, scroll, mode-switch, and press Apply in — with the section
skeleton and the disabled inventory rows that make it the single inventory (locked decision 11), and
the pending/disabled/failure treatments that every later ticket reuses. **Later tickets add their
own knob rows to their own sections** — that is what keeps them vertical and what makes the cut
protocol work.

**Frontend scope**
- `frontend/src/pages/TuningPanel.tsx` (+ `.test.tsx`) — the `<aside id="tuning-panel">` per
  wireframe §5: header (title + mode badge + applied fingerprint chip + close), **six**
  `<details class="collapse collapse-arrow bg-base-200 rounded-box">` sections in signal order with
  their summary status chips, sticky footer (`Apply` / `Revert` / `role="status" aria-live="polite"`
  line). Split `TuningSection.tsx` out **only if** the file exceeds ~400 lines (wireframe §2).
- Knob primitives: `KnobRow`, `RangeKnob` (always paired with a numeric readout), `NumberKnob`,
  `SegmentedKnob` (real radios in `role="radiogroup"`), `ProviderDefaultKnob` (the checkbox that
  means *the key is omitted entirely*).
- The three-layer **pending treatment** (amber inset left rule + amber dot + `was: <value>` badge)
  and the `reconnects` ghost chip, plus the two **disabled variants** (`not installed` +
  `uv sync --extra denoise` hint; `benchmark only`) — built once here, reused by every later ticket.
- **Disabled inventory rows shipped now**: Demucs, denoiser (DNS64) (`benchmark only`, permanently
  disabled), DeepFilterNet and noisereduce in their `not installed` variant driven by
  `capabilities.stages`. Wave-U-Net is **absent entirely** (story AC 5.5 — verified by absence).
- Models & voices section: curated `select`s populated from `capabilities.allowLists`, **no free
  text** (behaviour wiring is ticket 18).
- Transcript check section: the `off | flag | correct` `join`, with `correct` rendered
  `btn-disabled` + visible explanatory line in Realtime (behaviour is 14/15).
- `frontend/src/pages/useTuningConfig.ts` (+ `.test.ts`) — `draft`, per-mode `applied`, derived
  `pending = diff(applied[mode], projectMode(draft, mode))`, capabilities fetch with **skeleton**
  and **fallback-to-`DEFAULT_TUNING_CONFIG`** states, `applyState: 'idle' | 'applying' | 'failed'`
  + `attempt`. Apply while disconnected commits `draft → applied` locally, stamps a new fingerprint
  and clears pending (wireframe §4 — Apply stays **enabled** while disconnected).
- `WorkbenchPage.tsx` — the `Tuning` toggle in `navbar-end` **before** the connection badge, with
  `aria-expanded` / `aria-controls="tuning-panel"` and the `{n} pending` badge; transcript grid
  drops to one column while open; main column becomes `flex-1 min-w-0`; Escape closes and returns
  focus to the toggle; opening does **not** steal focus.
- All `data-testid`s from wireframe §8 for everything rendered here; all copy verbatim from
  wireframe §7.

**Backend scope**: None. **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.1** *(section skeleton + the inventory rows; the remaining knob rows arrive with
tickets 04, 06, 11, 12, 13, 14, 15, 16, 17, 18 — AC 1.1 is verified complete at the end of the
run)*, **1.11** (display half), **1.13** (mode-scoped rendering, nothing copied across),
**5.4** (offline stages visible, disabled, tagged `benchmark only`), **5.5** (Wave-U-Net absent),
**5.6** (pickers are fixed lists, no free-text entry).

Brief tests: **S3**, **S13**, **S14**, **S25** *(rendering half: Cascade offers off/flag/correct,
Realtime renders `correct` disabled)*, **S30** *(component half)*, **S31**, **F13** (capabilities
fetch failure → `DEFAULT_TUNING_CONFIG` + all server denoise rows `not installed`),
**F14** *(component half)*, **E5** (Apply while disconnected commits, persists intent, clears
pending). Accessibility per wireframe §9 in full.

## Out of scope for this ticket

localStorage / presets / export / import (03); any transport call (`applyTuning` is not wired here —
the footer button commits locally only); the Turn detection, Endpointing, Segmentation, Microphone,
RMS gate and RNNoise **rows** (they arrive with the tickets that make them do something).
