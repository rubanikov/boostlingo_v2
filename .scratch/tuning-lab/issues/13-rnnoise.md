Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 13 — RNNoise (48 kHz contexts, 3:1 decimator)

Type: task · Status: blocked · Tier: **3** · Depends on: 12

Size check: **right-sized (~3.5 hrs).**

## What to build

**Frontend scope**
- `frontend/package.json`: `@sapphi-red/web-noise-suppressor` (chosen over `@jitsi/rnnoise-wasm`
  because it ships a working AudioWorklet with the 480-sample/48 kHz framing already handled).
  Import the wasm and the worklet with Vite's `?url` suffix and **verify both resolve under
  `vite dev` and `vite build` before building on it.**
- `frontend/src/pages/resample.ts` (+ `.test.ts`) — the unit-tested 48 k→16 k decimator (8-tap FIR
  low-pass + 3:1), source of truth for the worklet.
- `frontend/public/cascade-pcm-processor.js` — the decimator, gated on `sampleRate === 48000`, driven
  by `processorOptions.targetSampleRate`; header comment gains the hand-sync note pointing at
  `resample.ts`.
- `useCascadeSession.ts`: `new AudioContext({ sampleRate: rnnoiseEnabled ? 48000 : 16000 })` — when
  RNNoise is off the graph stays at 16 kHz **exactly as today**.
  `useRealtimeSession.ts`: the DSP context runs at 48 kHz natively.
- `TuningPanel.tsx`: the **RNNoise** row (toggle + voice-probability threshold range) with the
  48 kHz/480-sample footnote.

**Harness scope**
- Confirm the sweep from 09 emits an RNNoise **clean-baseline** row so a 16→48→16 round-trip
  regression is visible.

**Backend scope**: None.

## Acceptance criteria

Story ACs: **3.4** (mic audio passes through RNNoise in both modes and the transcript is non-empty
for a clean clip — i.e. resampling does not destroy the signal), **3.7** (each tier-3 stage has at
least one benchmarked fingerprint on the noisy corpus with its WER delta versus the same config with
the stage disabled — satisfied by running 09's sweep and 10's capture once tier 3 lands; **this
ticket owns making that happen**, as the last tier-3 ticket).

Brief tests: **E9** (the 48 k context + 3:1 decimator still yields 960-byte / 30 ms frames, and
`resample.ts`'s output matches the worklet's), **E10** (the clean-baseline row exists in the sweep).

## Out of scope for this ticket

Server-side denoise (16/17).
