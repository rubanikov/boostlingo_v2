Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 16 — Server denoise chain: protocol + noisereduce + capability gating

Type: task · Status: blocked · Tier: **5** · Depends on: 02, 06

Size check: **right-sized (~3.5 hrs).**

## What to build

**Backend scope**
- `backend/app/providers/denoise.py` — `DenoiseStage` Protocol (`name`, `process(frame) -> bytes`
  same byte length, `reset()`), `NoopStage`, `NoisereduceStage`, `build_denoise_chain(tuning)`,
  `find_spec`-based detection and the module-level `_last_init_error`. Fixed chain order (cheap
  first): `noisereduce → deepfilternet`.
- `NoisereduceStage`: `noisereduce` has no streaming API, so keep a `_NR_CONTEXT_MS = 480` ring
  buffer, run `reduce_noise(y, sr=16000, prop_decrease=…, stationary=…)` over the buffer per new
  frame and emit the **last 30 ms**. Zero added algorithmic delay, real CPU cost — measured by
  ticket 09, not optimised here. *(If the measured number is bad, the honest fix is to mark the
  stage benchmark-only, not to optimise it in this slice.)*
- `orchestrator.audio_iter()` applies the chain **before** Deepgram — the single choke point every
  mic frame passes through. Every stage must handle **arbitrary frame lengths** (nothing enforces the
  960-byte size). When nothing is enabled `build_denoise_chain` returns `[]` and the path is skipped
  entirely — **zero cost when off**. Rebuild the chain when `tuning_state.current` changes identity,
  calling `reset()` on the old chain. Offline stages (`demucs`, `dns64`) are **never** constructed
  live: log `"offline-only denoise stage %s ignored in the live path"` once.
- `backend/pyproject.toml`: the first `[project.optional-dependencies]` — the **`bench`** extra
  (`noisereduce`, `numpy`). Per the Step 7 gate these are *not* main deps, so a default install
  correctly shows noisereduce as `not installed`.
- `/api/tuning/capabilities` `stages` now reports `installed: true` when the extra is present.

**Frontend scope**
- `TuningPanel.tsx`: the **noisereduce** row becomes live when `capabilities.stages.noisereduce
  .installed` — toggle + `propDecrease` range + stationary/non-stationary join; otherwise it keeps
  the `not installed` variant built in ticket 02.

**Harness scope**: `run_tuning_sweep.py` already honours the config; verify a noisereduce fingerprint
produces a distinct row.

## Acceptance criteria

Story ACs: **5.1** *(noisereduce half)*, **5.2** (every microphone frame is processed before reaching
Deepgram), **5.3** (capability discovery drives enabled/disabled; **core CI runs without torch**),
**5.4** (offline stages selectable in a benchmark config file while disabled in the panel).

Brief tests: **S28** *(generic half: a fake stage's call count equals the frame count)*, **S29**
(`find_spec` monkeypatched to a spec ⇒ `installed: true` and the panel row enabled), plus
`backend/tests/test_denoise.py` (chain construction, detection, arbitrary frame lengths).

## Out of scope for this ticket

DeepFilterNet and torch (17); GPU anything (permanently out of scope).
