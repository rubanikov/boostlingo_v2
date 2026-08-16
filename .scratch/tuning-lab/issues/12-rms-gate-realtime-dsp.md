Contract: `.scratch/tuning-lab/04-brief.md` (approved) · Story: `02-story.md` · Wireframe notes: `03-wireframe-notes.md` · Research: `01-research.md`

# Ticket 12 — RMS noise gate + Realtime client-DSP re-plumbing

Type: task · Status: blocked · Tier: **3** · Depends on: 05, 06, 11

Size check: **right-sized (~4 hrs).**

## What to build

**Frontend scope**
- `frontend/src/pages/rmsGate.ts` (+ `.test.ts`) — the unit-tested source of truth for the gate math
  exactly as specified in the brief (per-128-sample RMS → dBFS → open/close, `floorGain =
  fullMute ? 0 : 10 ** (-attenuationDb/20)`, attack/hold/release ramps). Boundaries documented and
  safe: `-80 dBFS` = always open, `0 dBFS` = always closed, neither crashes nor divides by zero.
- `frontend/public/gate-processor.js` — **one** shared gate worklet used by **both** modes. Params
  arrive via `processorOptions` at construction and `port.postMessage({type:'gateParams', …})` for
  live adjust. The math is **hand-mirrored** from `rmsGate.ts` (the worklet realm cannot import TS),
  with the header comment saying so — exactly as `floatSampleToInt16` already is. The worklet clamps
  defensively; `clampGateParams()` clamps on the main thread too.
- `useCascadeSession.ts`: insert the gate node at the single insertion point
  (`micSource.connect(workletNode)`); the analyser tap stays pre-processing and unchanged.
- `useRealtimeSession.ts` — **the genuinely new plumbing**: when any client stage is enabled, build
  `getUserMedia → AudioContext → [gate] → MediaStreamAudioDestinationNode`, and
  `pc.addTrack(sentTrack, …)`. **The mute-during-reply logic must target the sent track** — add
  `sentTrackRef` and mute *that*; `mediaStreamRef` stays only for teardown. When no client stage is
  enabled, keep the raw track and **do not create the DSP context**, so the default config's measured
  latency does not move.
- `TuningPanel.tsx`: the **RMS gate** rows in the Denoise chain (threshold range with numeric
  readout, hold / attack / release, attenuation range labelled `0 dB (off) … 60 dB … mute`,
  `Full mute` checkbox).
- `frontend/src/test/mockCascadeApis.ts`: `FakeAudioContext` gains `createMediaStreamDestination()`,
  constructor-honouring `sampleRate` and gain-node stubs; `FakeAudioWorkletNode` gains
  `processorOptions` capture and a **two-way** `port` with `postMessage`.
  `mockRealtimeApis.ts`: `MockRTCPeerConnection` records `addTrack` arguments.

**Backend scope**: None. **Harness scope**: None.

## Acceptance criteria

Story ACs: **3.2** (attenuated by exactly `attenuationDb`, above-threshold passes at unity, full mute
silences), **3.3** (threshold change on a connected session takes effect **without** reconnecting),
**3.5** (the WebRTC track carries processed audio **and** the mute targets the track actually being
sent — the single most likely silent regression in this feature).

Brief tests: **S22**, **S23**, **S24**, **E7** (threshold at `0` and `-80` neither crashes the
worklet nor produces a silence-only transcript), **E8** (`attenuationDb = 0` is a no-op; `fullMute`
overrides `attenuationDb`).

## Out of scope for this ticket

RNNoise and the 48 kHz context switch (13) — the graph built here runs at today's rates.
