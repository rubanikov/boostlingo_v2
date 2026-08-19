Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 08 — Noisy corpus generator + manifest

Type: task · Status: ready · Tier: **2** · Depends on: none

Size check: **right-sized (~2.5 hrs).**

> **Harness-only vertical, and allowed:** script → WAVs + manifest JSON → printed summary table.
> There is no UI or transport side to this story part. Zero dependencies — start it in wave 0.

## What to build

**Harness scope**
- `backend/tests/fixtures/make_noisy_corpus.py` — for each of the 33 clean items produce variants
  for **babble** (several overlaid TTS speakers, same and other language), **street**, and
  **fan/white**, each at **20 / 10 / 5 dB SNR**, all mono 16-bit 16 kHz, via RMS-matched mixing with
  a fixed `seed`. Uses the stdlib `wave` module (matching `stt_replay.py` and the harness's
  hand-written WAV header) — **no `soundfile`**.
- `backend/tests/fixtures/noisy/noisy_manifest.json` writer with the exact shape from the brief
  (`generatedAt` UTC, `seed`, `sampleRate`, per-item `condition` / `snrDb` / `measuredSnrDb` /
  `peakScale` and the inherited reference text/translation and language pair).
- `backend/tests/fixtures/noisy/SCRIPT.md` — how to regenerate, what each condition is, why the audio
  is not committed.
- `.gitignore` gains `backend/tests/fixtures/noisy/*.wav` and `noisy_manifest.json` (the existing
  "generated audio is not committed, the script + SCRIPT.md are" convention).
- Prints a summary table of what it generated (items × conditions × SNRs, measured SNR spread).

**Backend scope**: None. **Frontend scope**: None.

## Acceptance criteria

Story ACs: **2.1** (the full variant set, mono/16-bit/16 kHz, audio git-ignored, script + SCRIPT.md
committed), **2.8** *(partial: per-item skip rather than failing the run)*.

Brief tests: **S15** (measured SNR of each output within ±0.5 dB of its label, asserted on a
synthetic 1 s tone — **no real corpus needed to run the test**), **F16** (a missing or wrong-format
corpus WAV → per-item skip with the printed `ffmpeg` conversion command, run exits 0).

## Out of scope for this ticket

Running anything through STT (09); the Realtime half (10); any `TuningConfig` awareness — this script
only makes audio.
