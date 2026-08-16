Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 17 — DeepFilterNet stage + optional `denoise` torch extra

Type: task · Status: blocked · Tier: **5** · Depends on: 16

Size check: **right-sized (~2.5 hrs).**

## What to build

**Backend scope**
- `DeepFilterNetStage` in `denoise.py`: resample 16 k→48 k (`torchaudio.functional.resample`, ships
  with torch), run 3 DFN hops per 30 ms frame, resample back. `init_df()` is **lazy on first use and
  cached** — never called from the capabilities route, which uses `find_spec` only. A load failure
  sets `_last_init_error` and the stage **degrades to `NoopStage` for the rest of the session** with
  one warning log, rather than killing it.
- `backend/pyproject.toml`: the **`denoise`** extra (`torch>=2.4`, `deepfilternet>=0.5.6`) with the
  CPU wheel index pinned (`[[tool.uv.index]]` → `https://download.pytorch.org/whl/cpu` plus
  `[tool.uv.sources] torch = {index = "pytorch-cpu"}`). Installed with `uv sync --extra denoise`.
  **Core CI stays torch-free.**
- Capabilities distinguishes the two failure modes: `installed: false` +
  `torch not installed — run \`uv sync --extra denoise\`` **vs** `installed: true` +
  `model weights unavailable — see the server log.`
- `README.md` documents `uv sync --extra denoise` and `--extra bench`.

**Frontend scope**
- `TuningPanel.tsx`: the **DeepFilterNet** row becomes live when installed — toggle + attenuation
  limit dB + post-filter strength; the two distinct hint strings for the two failure modes (wireframe
  §7), always as **visible text**, never a `title` alone.

**Harness scope**: None beyond the sweep already honouring the config.

## Acceptance criteria

Story ACs: **5.1** *(DeepFilterNet half, with its own parameters visible)*, **5.3** (the "installed"
side of capability discovery).

Brief tests: **S28** (DeepFilterNet selected ⇒ every mic frame passes through
`DeepFilterNetStage.process` before Deepgram), **F15** (torch installed but `init_df()` raises ⇒
`installed: true` + `model weights unavailable…`, and the stage degrades to no-op mid-session rather
than killing it).

## Out of scope for this ticket

Demucs / DNS64 / Wave-U-Net in the live path — permanently out of scope; they exist only as sweep
options (09) and disabled inventory rows (02).
