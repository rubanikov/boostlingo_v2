# Audio Tuning & Denoise Lab — user story

(story-writer output, feature-factory Step 2, 2026-08-15. Status: DRAFT pending Step 3 gate.)

## Epic narrative

**As** the single developer/researcher running the AI Interpreter Workbench as a lab,
**I want** every audio, turn-taking, segmentation, denoise and transcript-check processing step exposed as a selection in an in-app Tuning panel, applied both at session start and live mid-session, and measurable against a noisy corpus,
**so that** I can answer "does this processing step improve WER, judge score or latency?" with a number per configuration instead of a guess.

The feature has three natural parts, split below into five sub-stories. **Priority is cut from the bottom**: tier 1 and 2 are must-have; tiers 3 and 4 are should-have; tiers 5 and 6 are the first things dropped if the slice is too big.

**Fingerprint** (used throughout): a short, stable hash of the canonical `TuningConfig` JSON, computed by shared code so the UI, backend and harnesses all derive the same string from the same config. It is the join key between a run and its numbers.

---

## Story 1 — Tuning panel and config plumbing (Tier 1, must-have)

**As** the researcher, **I want** a Tuning panel in `WorkbenchPage` that owns every existing knob and pushes it into the session at start and live mid-session, **so that** I can change one variable at a time without editing `.env` or restarting the server.

### Acceptance criteria

1. **[T1] Panel is the single inventory.** Given the workbench is open, when I open the Tuning panel, then it shows a section per processing step — Microphone constraints, Denoise chain, Turn detection, Segmentation, Transcript check, Models — and every knob listed in locked decision 5 for the currently selected mode appears there. No knob that the app reads is settable only via `.env` or a query parameter.
2. **[T1] Realtime start-of-session apply.** Given no session is connected and I set turn detection to `server_vad` with `silence_duration_ms` = 300 in the panel, when I press Connect microphone, then the `POST /api/realtime/session` request body carries those values and the backend includes them under `session.audio.input.turn_detection` in the payload it sends to OpenAI.
3. **[T1] Unset stays unset.** Given a turn-detection field is left at "Provider default" in the panel, when the session is created, then that key is absent from the outbound OpenAI payload (matching the existing `_turn_detection()` idiom), not sent as an explicit restatement of a default.
4. **[T1] Cascade start-of-session apply.** Given I set segmentation mode to `llm_priority` and Deepgram `endpointing` to 300 ms, when I connect in Cascade mode, then those values ride inside the first `start_session` WebSocket message and the session's Deepgram connection is built with them (observable in the connection URL under test).
5. **[T1] Realtime live apply.** Given a Realtime session is connected, when I change `silence_duration_ms` and press Apply, then a `session.update` message containing the new value is sent on the `oai-events` data channel, the session is not torn down, and the panel shows the config as applied.
6. **[T1] Cascade live apply, non-connection-level.** Given a Cascade session is connected, when I change a knob that is not part of the Deepgram connection (e.g. segmentation mode), then a new WS control message carries it, the Deepgram connection is not restarted, and the change takes effect for the next segment.
7. **[T1] Cascade live apply, connection-level.** Given a Cascade session is connected and mid-utterance audio is in flight, when I change a Deepgram connection-level parameter (`endpointing`, `utterance_end_ms`, `diarize`, model) and press Apply, then the backend deliberately reconnects Deepgram, and every audio frame the client sent before, during and after the reconnect appears in the transcript — no frame is dropped and no segment is lost.
8. **[T1] Persistence.** Given I set a config and reload the page, when the panel opens, then it shows the same values (localStorage), and no config is stored server-side.
9. **[T1] Presets.** Given the panel is open, when I select the built-in preset "Provider defaults", "Tuned turn-taking" or "Max denoise", then every knob takes that preset's value in one action; when I save a preset under my own name, it appears in the preset list after reload.
10. **[T1] Export / import.** Given a config is set, when I press Export, then I get the `TuningConfig` JSON; when I import that same JSON, the panel returns to exactly that config.
11. **[T1] Backend defaults still apply.** Given a fresh browser with no stored config, when I connect, then the session uses the server's `.env`-derived defaults, and the panel displays those same values rather than blanks.
12. **[T1] Fingerprint is visible.** Given any config, when I view the panel, then the fingerprint string for that config is displayed, and it changes when any knob changes and is identical for two configs that differ only in field ordering.
13. **[T1] Mode-scoped.** Given I switch between the Realtime and Cascade tabs, when the panel re-renders, then it shows only that mode's knobs, and switching tabs does not silently apply the other mode's values.

---

## Story 2 — Noisy corpus and per-config benchmark report (Tier 2, must-have)

**As** the researcher, **I want** a noisy version of the existing 33-item corpus and harnesses that run any `TuningConfig` end to end, **so that** every knob claim is backed by WER, judge score and latency numbers keyed by fingerprint.

### Acceptance criteria

1. **[T2] Noise synthesis.** Given the clean 33-item corpus, when I run the noise-generation script, then for each item I get variants for babble (several overlaid TTS speakers, same and other language), street, and fan/white noise, each at 20 dB, 10 dB and 5 dB SNR, all mono 16-bit 16 kHz, and the generated audio is git-ignored while the script and its SCRIPT.md are committed.
2. **[T2] Cascade STT sweep.** Given a `TuningConfig` file and the noisy corpus, when I run the extended `stt_replay.py` harness, then it produces one row per (item, noise condition, SNR) with WER and the config fingerprint.
3. **[T2] Realtime sweep.** Given a `TuningConfig` file, when I run `realtime-quality-capture.mjs`, then it applies that config in the UI before connecting, and each captured item and the output envelope carry the config fingerprint.
4. **[T2] Report.** Given capture output, when I run `run_realtime_quality_report.py`, then every result row and the summary block carry the fingerprint, and the report includes WER, LLM-judge acceptance and end-to-end latency.
5. **[T2] Clean baseline always shown.** Given any benchmark run, when the report is produced, then the clean (no added noise) condition appears alongside the noisy conditions so regressions on clean audio are visible.
6. **[T2] Comparison output.** Given two or more fingerprints have been benchmarked, when I run the report, then it prints a ready-to-paste markdown table with one row per fingerprint (following the existing `COMPARISON.md` row-printing convention), and `COMPARISON.md` gains a new section for tuning-config comparisons.
7. **[T2] Added latency is attributed.** Given a config that enables one or more processing stages, when the report is produced, then it reports latency added by processing separately from provider latency, so "this stage cost N ms" is readable off the report.
8. **[T2] Real-recording set self-skips.** Given no user-supplied real-recording manifest exists, when I run the benchmark, then it prints a friendly message and exits with success (same pattern as `run_real_audio_report.py`), not an error.

---

## Story 3 — Client-side denoise stages (Tier 3, should-have)

**As** the researcher, **I want** browser constraint toggles, an RMS noise gate, RNNoise and the OpenAI input noise reduction selectable per session, **so that** I can measure whether live-path denoising improves WER.

### Acceptance criteria

1. **[T3] Mic constraints.** Given I turn echo cancellation, noise suppression and auto gain control off in the panel, when I connect in either mode, then `getUserMedia` is called with exactly those values instead of the current hardcoded `true`s.
2. **[T3] RMS gate parameters.** Given the RMS gate is enabled with threshold −45 dBFS, hold 200 ms, attack 5 ms, release 80 ms and attenuation 12 dB, when audio below the threshold is captured, then it is attenuated by 12 dB (not muted) and audio above the threshold passes unchanged; when attenuation is set to full mute, sub-threshold audio is silenced.
3. **[T3] Gate is live-adjustable.** Given a connected session with the gate on, when I change the threshold and press Apply, then the new threshold takes effect without reconnecting the session.
4. **[T3] RNNoise.** Given RNNoise is enabled, when I connect, then microphone audio passes through RNNoise before reaching the transcript path in both modes, and the resulting transcript is non-empty for a clean speech clip (i.e. resampling to RNNoise's 48 kHz / 480-sample frame requirement does not destroy the signal).
5. **[T3] Realtime client DSP plumbing.** Given any client-side stage is enabled in Realtime mode, when I connect, then the WebRTC track carries the processed audio, and the existing mic-mute-during-reply behaviour still mutes the track that is actually being sent.
6. **[T3] OpenAI noise reduction.** Given I select `off`, `near_field` or `far_field`, when the Realtime session is created, then `input_audio_noise_reduction` is sent under `session.audio.input` with that value; when `off` is selected, the behaviour matches decision 3's "unset means provider default" rule as stated in the panel.
7. **[T3] Measured, not asserted.** Given each of these stages, when the tier-2 benchmark runs, then each stage has at least one benchmarked fingerprint on the noisy corpus with its WER delta versus the same config with the stage disabled.

---

## Story 4 — Transcript-check LLM stage (Tier 4, should-have)

**As** the researcher, **I want** a per-session transcript check that can flag or correct the source transcript before translation, **so that** I can measure whether an LLM sanity pass reduces effective error rate.

### Acceptance criteria

1. **[T4] Cascade modes.** Given the Cascade tab, when I open Transcript check, then I can choose `off`, `flag` or `correct`.
2. **[T4] Realtime modes.** Given the Realtime tab, when I open Transcript check, then only `off` and `flag` are offered and `correct` is not selectable.
3. **[T4] Flag is non-blocking.** Given `flag` mode and a segment the checker considers suspicious, when the segment completes, then the segment is annotated as suspicious in the UI and translation proceeds with the original text and without waiting on the check.
4. **[T4] Correct rewrites before translation.** Given Cascade `correct` mode and a segment whose text the checker rewrites, when the segment is processed, then the rewritten text is what goes to translation, the displayed source transcript is updated to the corrected text, and a dedicated latency stage records the time the check took.
5. **[T4] Raw vs corrected WER.** Given a benchmark run with `correct` enabled, when the report is produced, then it reports both raw and corrected WER per item, so a config where correction makes things worse is visible.
6. **[T4] Off means no call.** Given `off`, when a session runs, then no transcript-check model call is made and no extra latency stage appears.
7. **[T4] Check failure is safe.** Given the transcript-check call fails, when the segment is processed, then the original transcript is used, the session continues, and the failure is surfaced as a non-fatal toast rather than ending the session.

---

## Story 5 — Server and offline denoise plus curated model pickers (Tiers 5–6, first to cut)

**As** the researcher, **I want** the server-side and offline-only denoisers plus curated model/voice pickers in the same panel, **so that** the panel is the complete inventory of processing steps and I can sweep models the same way I sweep denoisers.

### Acceptance criteria

1. **[T5] Server denoise selection.** Given the Cascade tab, when I open the Denoise chain, then I can select `off`, DeepFilterNet (with attenuation limit dB and post-filter strength) or noisereduce (with `prop_decrease` and stationary/non-stationary), each with its own parameters visible.
2. **[T5] Applied on the server path.** Given DeepFilterNet is selected, when audio flows through a Cascade session, then every microphone frame is processed by it before reaching Deepgram.
3. **[T5] Capability discovery.** Given the `backend[denoise]` extra is not installed, when I open the panel, then torch-based stages are shown disabled with a "not installed" hint and cannot be selected; given the extra is installed, the same stages are enabled. Core CI runs without torch.
4. **[T5] Offline-only stages are visible but disabled.** Given Demucs / denoiser (DNS), when I open the Denoise chain in either mode, then they appear in the same section, disabled, tagged "benchmark only", and they are selectable in a benchmark config file.
5. **[T5] Wave-U-Net.** Given no maintained Wave-U-Net package exists at build time, when the panel is built, then it is simply absent — no placeholder, no new decision needed.
6. **[T6] Model pickers are allow-lists.** Given the Realtime model picker, segmentation model picker, Deepgram model picker, translation model picker, and the voice pickers, when I open each, then it offers a fixed curated list and no free-text entry.
7. **[T6] Server-side validation.** Given a request that names a model or voice outside the curated allow-list (sent by tooling, not the UI), when the backend receives it, then it rejects the request with an HTTP 400 for the Realtime session route, and for the Cascade WebSocket it falls back to the default rather than killing the session (matching the documented asymmetric validation posture).

---

## Edge cases to think about

- **Apply pressed during TTS playback (Cascade).** Frames are withheld while playback is active; an Apply that triggers a Deepgram reconnect during that window must not strand the queued audio.
- **Apply pressed during a Realtime reply.** The mic track is disabled and the model is mid-response; a `session.update` landing here could interrupt or be ignored — decide whether Apply is deferred to the next turn.
- **Apply pressed while disconnected.** Should it queue for the next connect, or is Apply disabled until connected?
- **Rapid repeated Apply.** Two connection-level changes 200 ms apart should not produce two overlapping Deepgram reconnects.
- **Deepgram reconnect fails after the parameter change.** Falling back to the previous parameters versus surfacing an error and stopping.
- **`backend[denoise]` installed but the model weights are missing or fail to load** — different failure from "not installed", and the panel's hint text differs.
- **Invalid or retired model id in a stored/imported config.** A curated list that shrinks between builds leaves stored configs pointing at a model that no longer exists.
- **Malformed JSON on config import**, or valid JSON with unknown keys from a newer build — reject wholesale, or import known keys and warn?
- **A corpus WAV is missing or is not mono/16-bit/16 kHz.** Per-item skip with a printed conversion command (existing pattern) versus failing the run.
- **Real-recording manifest present but every file missing.** Zero-result report versus clean skip.
- **Benchmark sweep size.** N noise variants × M configs is N×M browser launches in the Realtime half and roughly real-time playback in the Cascade half — a full sweep may run for hours; consider a cap or resume.
- **Fingerprint collisions and drift.** Two different configs must not share a fingerprint; a schema version bump must not silently invalidate old report rows.
- **All denoise stages enabled at once ("Max denoise").** Stacked processing may add more latency than any single measurement suggests, and may cancel out.
- **Gate threshold at boundaries.** 0 dBFS (everything gated) and −∞ (nothing gated) should not crash the worklet or produce silence-only transcripts.
- **RNNoise resampling in the Cascade 16 kHz context.** 16 k → 48 k → 16 k round-trip may itself degrade WER; the clean baseline row is the guard.
- **Playwright harness origin.** The harness runs on port 5183 while `cors_origins` defaults to 5173 — a Cascade benchmark harness will hit the WebSocket origin guard unless the config is widened.

---

## Out of scope

- Server-side or account-based preset storage (localStorage plus JSON export/import only).
- Any GPU requirement; all denoisers run CPU-only.
- Demucs, denoiser (DNS) or Wave-U-Net in the live path — offline benchmark only.
- `correct` transcript-check mode in Realtime mode.
- A per-device microphone calibration wizard.
- New language pairs — EN↔ES and EN↔FR only.
- Supplying the real noisy recording set; the user provides it and the harness self-skips when it is absent.
- Auto-generating `COMPARISON.md` prose; the report prints paste-ready rows, a human still writes the section.
- Multi-user concerns, authentication, or per-user config isolation.

---

## Assumptions made (flag any that are wrong)

1. The exact wire key names for tuning fields are a build detail, as long as they follow the existing camelCase-on-the-wire / snake_case-in-Python convention.
2. The fingerprint is a short hash (e.g. first 8 hex characters of a SHA-256 over canonically-serialised `TuningConfig` JSON); the exact algorithm and length are a build detail as long as it is identical across UI, backend and harnesses.
3. "Live apply" is an explicit **Apply** action in the panel, not auto-apply on every keystroke.
4. The Tuning panel is a new component under `frontend/src/pages/` (matching the flat convention), backed by a pure `tuningConfig.ts` module with its own unit tests, and every control the capture harness must drive carries a `data-testid`.
5. The uncommitted `_turn_detection()` / `realtime_vad_*` work is absorbed rather than reverted; the panel supersedes those `.env` settings as the primary source while they remain the server defaults.
6. Generated noisy audio follows the existing convention: audio is git-ignored, the generation script and its SCRIPT.md are committed.

---

## Open questions (product-level only)

1. When a connection-level Cascade change requires a deliberate Deepgram reconnect, should Apply warn me first, or just do it silently?
2. Does the existing `WER_THRESHOLD = 0.20` pass/fail gate apply to the noisy variants, or are noisy runs report-only with no assertion?
3. In `flag` mode, what should mark a segment as suspicious in the UI — a badge on the segment, a toast, or both?

---

## Step 3 gate outcome (2026-08-15): APPROVED

Open questions answered:
1. **Deepgram reconnect on connection-level Apply**: no confirmation dialog; reconnect immediately, show the existing `reconnecting` status badge ("reconnecting STT") while it happens. **Addendum from the human:** log every failure (each failed reconnect / apply attempt is logged — backend log line + a client-side console/log entry), and if it still fails after several retries (reuse the existing retry/backoff count), show a **dialog** to the user (not just a toast) explaining that the new parameters could not be applied, with the option to retry or revert to the previous config.
2. **WER_THRESHOLD = 0.20**: applies to the clean corpus only. Noisy-variant runs are report-only (numbers, no assertion) so denoise experiments never turn CI red.
3. **`flag` mode UI**: a small badge on the segment (next to the existing trigger annotation), no toast.
