Type: grilling
Status: resolved

## Question

Before building, decide the strategy for: (a) confirming the app is actually capturing
and processing real voice (not silence/a dead device/wrong input), (b) verifying STT and
translation are detecting correct words rather than hallucinating on noise — including
the WER measurement the brief names under Key Impact Metrics, and (c) how far to go on
calibrating across different physical microphones.

## Answer

**Confirming the app is listening:**
- Live audio level meter in the UI (RMS/peak dB via Web Audio `AnalyserNode`) — catches
  wrong input device, OS-level mute, dead hardware; none of which trip a permission
  error. Needed for UX regardless of test strategy.
- Surface Deepgram's `SpeechStarted` VAD event as a "listening... / hearing you" UI
  state — confirms the pipeline, not just raw mic input.
- A short "test mic" preflight at session start (record ~2-3s, play it back) before the
  real session begins.

**STT/translation accuracy testing — full automation, per decision:**
- **Automated WER regression test**: TTS-generate ~10-15 known sentences per language
  (EN, ES), run through the STT stage, compute WER against the known source text via
  edit-distance alignment (`jiwer` or equivalent), assert below a threshold. Repeatable,
  catches regressions cheaply.
- **Playwright fake-mic E2E test**: drive the real browser mic-capture path in an
  automated test using Chrome's `--use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<path>` flags to feed a known WAV file as the
  microphone; assert a transcript containing the expected words appears within a time
  budget. This exercises the actual capture → STT → (translation → TTS) path end to end,
  not just the STT stage in isolation.
- **Noise-rejection case**: feed a silence/background-noise fixture (no speech) through
  the same fake-mic path; assert no spurious transcript is produced (or that VAD/
  endpointing never triggers a send to STT) — catches ASR hallucination on non-speech
  input.
- These count toward the brief's "targeted tests on the cascade pipeline... critical
  paths must be tested" requirement — see
  [Error handling & test strategy](10-error-handling-test-strategy.md), which owns
  pipeline/provider-boundary correctness tests; this ticket owns speech-quality tests
  specifically. Ticket 05 ([Cascade pipeline architecture](05-cascade-pipeline-architecture.md))
  should keep this WER/E2E harness in mind when defining the STT stage's output contract.

**Mic calibration:**
- No per-device acoustic calibration system — not standard practice for consumer STT
  apps; providers are trained on device-diverse data for exactly this reason.
- Rely on browser-level `getUserMedia` constraints: `autoGainControl: true`,
  `noiseSuppression: true`, `echoCancellation: true`.
- The level-meter preflight doubles as calibration UX: warn the user ("having trouble
  hearing you — check your mic or speak up") rather than attempting auto-correction.
- **Device coverage, per decision**: manual pass only, with whatever real devices are on
  hand (laptop built-in mic + one other, e.g. USB or Bluetooth headset — Bluetooth is
  the usual worst case, often capped to 16kHz narrowband). No dedicated automated
  tooling for this; note results/limitations in the comparison write-up.
