Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 03 — Persistence, presets, export / import, reset

Type: task · Status: blocked · Tier: **1** · Depends on: 02

Size check: **right-sized (~3 hrs).**

> **Single-sided by necessity, and allowed.** Locked decision 10 and story AC 1.8 explicitly forbid
> server-side config storage — there is no backend half of this story part to build. It is still a
> complete, human-exercisable slice: set knobs → save a preset → export JSON → reload → import →
> identical fingerprint.

## What to build

**Frontend scope**
- `frontend/src/pages/tuningPresets.ts` (+ `.test.ts`) — `BUILT_IN_PRESETS`
  (`Provider defaults`, `Tuned turn-taking`, `Max denoise`); read/write for
  `boostlingo.tuning.v1` (`{schemaVersion, draft, applied: {cascade, realtime}}`) and
  `boostlingo.tuning.presets.v1`; schema-version handling (missing/≠1 ⇒ discard the entry with a
  `console.warn` and fall back to server defaults; unknown keys dropped with a warning; missing keys
  filled from server defaults).
- `useTuningConfig.ts` — the persistence effect, preset select/apply, `Save as…` inline name input,
  `Export`, `Import` (file or paste), `Reset to defaults` (restores the **server** defaults, not a
  preset), `Preset modified` marker, and the retired-model fallback.
- `TuningPanel.tsx` header wiring: `tuning-preset`, `tuning-preset-name`, `tuning-preset-save`,
  `tuning-export`, `tuning-import`, `tuning-import-file`, `tuning-reset`.
- `tuningConfig.ts` gains `parseImported()` and `migrate()`.

**Backend scope**: None (by design). **Harness scope**: None.

## Acceptance criteria

Story ACs: **1.8** (survives reload; nothing stored server-side), **1.9** (built-in presets set every
knob in one action; a user preset survives reload), **1.10** (export → import round-trips exactly).

Brief tests: **S10**, **S11**, **S12**, **F10** (malformed JSON → inline
`That file isn't a valid tuning config.`, draft untouched), **F11** (unknown keys → known keys
imported + `Imported. Ignored {n} unknown field(s): {names}.`), **F12** (retired model id →
`{model} is no longer available — using {default}.`), **E13** *(unit half: the "Max denoise" preset
produces a valid config with a distinct fingerprint)*.

## Out of scope for this ticket

Server-side or account preset storage (permanently out of scope); any transport behaviour.
