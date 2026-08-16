Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 09 — Cascade tuning sweep runner + paste-ready table + COMPARISON §7

Type: task · Status: blocked · Tier: **2** · Depends on: 01, 08

Size check: **right-sized (~3.5 hrs).**

> Harness-only vertical: config JSON + corpus → `tuning_sweep.json` → printed markdown table.

## What to build

**Harness scope**
- `backend/tests/fixtures/stt_replay.py`: add
  `transcribe_wav_detailed(..., tuning=, offline_stages=) -> ReplayResult`; `transcribe_wav`
  delegates and **keeps returning `str`** so existing callers are untouched.
- `backend/tests/fixtures/run_tuning_sweep.py` — the runner: `--config` (repeatable), `--limit`,
  `--only`, `--conditions`, `--snr`, `--out`, `--yes`; one row per (item, condition, SNR) carrying
  the **fingerprint** (computed by `backend/app/tuning/fingerprint.py`, not re-implemented);
  `wer`, `correctedWer` (column defined here, populated by 14), `addedLatencyMs`,
  `providerLatencyMs`, `status`, `skipReason`; **resume by skipping rows already present in
  `--out`**; `_MAX_ROWS_WITHOUT_CONFIRM = 200` refusal with an estimated wall-clock; a
  `condition: "clean", snrDb: null` row per item in **every** run; `offline_stages` honoured
  (applied to the whole WAV before replay) even though the panel shows them disabled.
- Paste-ready markdown table: one row per fingerprint, following the existing `COMPARISON.md`
  row-printing convention.
- `COMPARISON.md` gains **§7 Tuning-config comparisons** as a skeleton: the table
  (`fingerprint / mode / condition / SNR / WER / corrected WER / judge acceptance / added latency /
  provider latency`), a "what each fingerprint is" list, and the exact reproduce commands — following
  the existing per-table provenance convention. *(Prose stays human-written — out of scope by story.)*
- `.gitignore` gains `backend/tests/fixtures/tuning_sweep*.json`. `README.md` documents the command.

**Backend scope**: None beyond importing the tuning package. **Frontend scope**: None.

## Acceptance criteria

Story ACs: **2.2**, **2.5** (clean baseline always shown), **2.6** (paste-ready markdown +
COMPARISON.md section), **2.7** (added latency reported **separately** from provider latency — this
is where AC 2.7 is satisfied; there is deliberately **no live per-frame readout** in the UI),
**2.8** (real-recording manifest absent → friendly message, exit 0).

Brief tests: **S16**, **S19**, **S20**, **S30** *(sweep half: a config naming Demucs/DNS64 is
honoured)*, **F17**, **E12** (over-cap refusal + estimated wall-clock), **E14** (manifest present but
every file missing → zero-result report, exit 0).

Noisy-variant runs are **report-only** — `WER_THRESHOLD = 0.20` in `test_quality_wer.py` stays a
clean-corpus assertion and is not touched (Step 3 gate answer 2).

## Out of scope for this ticket

The Realtime half (10); the actual denoise stage implementations (16/17) — the runner calls whatever
`build_denoise_chain` returns, which is `[]` until then.
