Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 10 — Realtime capture harness `--tuning` + fingerprint through the report

Type: task · Status: blocked · Tier: **2** · Depends on: 01, 02, 03, 04

Size check: **right-sized (~2 hrs).**

> Kept separate from 09 rather than merged: different language (Node/Playwright vs Python), different
> files, and 09 is already at 3.5 hrs. Merging would produce a Too-thick ticket.

## What to build

**Harness scope**
- `frontend/e2e/realtime-quality-capture.mjs`: `--tuning <file>` in the arg parser; before Connect,
  the harness **imports the whole config through `tuning-import` / `tuning-import-file`** (rather
  than driving 30 controls — this is exactly why that testid exists), then scrapes the applied
  fingerprint from `tuning-fingerprint-latency`; stamps `fingerprint` and `tuningFile` on the output
  envelope and `fingerprint` on **every item**.
- Must still pass `assertServersUp()` — it probes with `sourceLanguage: 'zz'` and expects that 400;
  ticket 04's new validation must not change that error's text or precedence.
- `backend/tests/fixtures/run_realtime_quality_report.py`: `_identity()`, the summary block and the
  printed COMPARISON row all gain the fingerprint.

**Backend scope**: None. **Frontend scope**: None (it consumes ticket 02/03's testids).

## Acceptance criteria

Story ACs: **2.3** (the config is applied in the UI before connecting; captures carry the
fingerprint), **2.4** (every result row and the summary block carry the fingerprint; WER, judge
acceptance and end-to-end latency reported).

Brief tests: **S17** (e2e smoke, no live keys — asserts the import happened and the chip text
matches), **S18**.

## Out of scope for this ticket

Sweeping N configs × M conditions in one command on the Realtime side (one browser launch per clip is
a hard Chromium constraint; the Cascade half in 09 is where bulk sweeping happens).
