# Build log — Audio Tuning & Denoise Lab (feature-factory Step 10)

Concurrency cap: 5 (human decision at Step 9). Lint gate = `uv run ruff check` (repo has no ruff config; `ruff format --check` fails on pre-existing files, house line length ~100).

## Wave 0

### Ticket 08 — Noisy corpus generator (backend-builder) — DONE, clean
- Files: `backend/tests/fixtures/make_noisy_corpus.py` (new), `backend/tests/fixtures/noisy/SCRIPT.md` (new), `backend/tests/test_noisy_corpus.py` (new, 6 tests), `.gitignore` (+noisy/*.wav, noisy_manifest.json).
- CLI: `uv run python -m tests.fixtures.make_noisy_corpus [--seed 1234] [--only ID] [--conditions babble,street,fan,white] [--snr 20,10,5] [--out-dir tests/fixtures/noisy] [--dataset PATH] [--audio-dir DIR]`
- Real run: 33 clean + 396 noisy = 429 rows, 35 s, measured SNR exactly on label. Clean baseline is a first-class row (`__clean`, `snrDb: null`), WAV copied into `noisy/`.
- Noise sources: procedural white/fan/street (stdlib only, no numpy); babble = 3–5 overlaid corpus TTS clips, self-skips if <3 usable clips.
- Checks: `ruff check` clean on its files; `pytest tests/test_noisy_corpus.py` 6 passed; full suite 126 passed with ticket-01 in-flight files ignored.
- Deviations: added `--dataset`/`--audio-dir` flags (needed for tests to drive real `main()`); did not add `tuning_sweep*.json` gitignore line (ticket 09's).

### Ticket 01 — frontend (frontend-builder) — DONE, clean
- New: `frontend/src/pages/tuningConfig.ts` (+33 tests), `tuningCapabilities.ts`, `shared/tuning-fingerprint-cases.json` (created by FE; BE appended 2 cases → 10 total, TS reproduces all).
- Changed: `WorkbenchPage.tsx` (capabilities fetch, `FingerprintChip` in navbar-end, `configFingerprint` prop into latency components), `WorkbenchPage.test.tsx` (+7), `src/test/mockRealtimeApis.ts` (routes capabilities), `tsconfig.app.json` (`types: ["vite/client","node"]` to read the repo-root fixture).
- API consumed: `GET /api/tuning/capabilities` → `schemaVersion, defaults, allowLists{…}, stages{…}`; per-key fallback to `DEFAULT_TUNING_CONFIG`; transport failure → warn + hash defaults.
- Number rules: clamp → step-round → 2dp → integral ⇒ int text; `-0`→`0`. Deviation: `postFilterBeta` step 0.01 (brief said 0.05 but its default 0.02 is off-grid) — backend independently did the same. Integer knobs also quantised.
- Chip `tuning-fingerprint-latency` rendered outside `cascade-latency-strip` (sibling), per brief; layout adjusted.
- Checks: tsc 0, oxlint clean, vitest 12 files / 177 passed, vite build ok.

### Ticket 01 — backend (backend-builder) — DONE, clean
- New: `backend/app/tuning/{__init__,schema,fingerprint,allowlists,defaults}.py`, `backend/app/api/tuning.py` (GET /api/tuning/capabilities, `_last_init_error` dict hook), tests `test_tuning_config.py` (31), `test_tuning_api.py` (13); E15 in `test_resilience.py::TestOriginValidation`.
- Changed: `main.py` (router), `config.py` (`cors_origins` +5183; `elevenlabs_voice_ids_extra` comma-separated via NoDecode), `.env.example`; appended 2 clamp/off-grid cases to `shared/tuning-fingerprint-cases.json` (10 total).
- `schema.py` imports nothing from `app` (circular-import guard for tickets 04/06); `defaults.py` reads providers at call time; drift test guards literal defaults.
- Checks: `uv run pytest -q` 171 passed; `ruff check app tests` clean; new files ruff-formatted.
- Flags for later tickets: `_last_init_error` hook location (16/17 write to it); ElevenLabs labels "Rachel/Antoni" are attached to whatever ids .env sets (02/18 may prefer "Voice A default").

### Ticket 01 — RECONCILE: CLEAN
- Contract match: FE consumes exactly `{schemaVersion, defaults, allowLists{8 lists}, stages{4}}`; BE emits it; `defaults` served canonical so client hash == server hash by construction.
- Parity: all 10 fixture cases pass in both pytest and vitest.
- **Brief amendment (adopted):** `cascade.denoise.deepfilternet.postFilterBeta` step is **0.01** (brief said 0.05; its default 0.02 is off that grid). Integer knobs are also clamped/quantised.
- E15 lives in `test_resilience.py` (that's where the origin tests are).

## Wave 0 complete → Wave 1 (02, 09)

## Wave 1

### Ticket 02 — Tuning panel shell (frontend-builder) — DONE, clean
- New: `useTuningConfig.ts` (+11 tests), `TuningPanel.tsx` (739 lines), `TuningSection.tsx` (primitives, split per §2), `TuningPanel.test.tsx` (27). Changed: `WorkbenchPage.tsx` (toggle, two-column shell, Escape/focus), `WorkbenchPage.test.tsx` (+8), `tuningCapabilities.ts` (export FALLBACK_ALLOW_LISTS), `index.css` (`.tuning-pending`).
- Hook API: `useTuningConfig(mode) → {draft, applied, pending, capabilities, capabilitiesState, applyState, attempt, lastAppliedAt, activeFingerprint, draftFingerprint, setKnob, setProviderDefault, apply(applyTuning?), revert}`; `ApplyTuning`/`ApplyResult` types + `APPLY_MAX_ATTEMPTS=3` exported from `useTuningConfig.ts`; `TuningPanel` takes optional `applyTuning` prop. **05/07 plug `session.applyTuning` in here** (WorkbenchPage renders `<TuningPanel>` without it, comment names 05/07).
- Testids live: shell (`tuning-toggle/panel/close/fingerprint/fingerprint-panel/fingerprint-latency/pending-count/apply/revert/status/apply-failed-dialog/apply-retry/apply-revert/section-*`), knobs (`tuning-openai-noise-reduction-{off,near,far,default}`, `tuning-dfn-*`, `tuning-noisereduce-*`, `tuning-demucs-enabled`, `tuning-dns-enabled`, `tuning-segmentation-model`, `tuning-transcript-check-{off,flag,correct,model}`, `tuning-model-{deepgram,translation,realtime}`, `tuning-voice-{a,b,realtime}`).
- Deviations: `tuning-fingerprint` stays on navbar (panel header = `tuning-fingerprint-panel`); Realtime `correct` is a real disabled radio; **shipped the OpenAI noise-reduction row early** (ticket 04 wires it); empty sections show "No adjustable settings in this section yet."; extra primitives `SelectKnob`, `DenoiseStageCard`.
- Not done (by scope): transport, localStorage/presets/import/export (03), sessionHandle changes (05/07), dialog focus trap (07), mic/gate/rnnoise/turn/endpointing/segmentation-mode rows (04/06/11/12/13).
- Checks: vitest 14 files / 223 passed; oxlint clean; tsc+vite build ok.

### Ticket 09 — Cascade sweep runner (backend-builder) — DONE, clean
- Changed: `stt_replay.py` (`ReplayResult`, `transcribe_wav_detailed(..., tuning=, offline_stages=, reference_text=)`, `transcribe_wav` delegates & still returns str, `TRAILING_SILENCE_S` public). New: `run_tuning_sweep.py`, `test_tuning_sweep.py` (15). `.gitignore` +tuning_sweep*.json; README harness subsection; COMPARISON.md §7 skeleton (9-col table, provenance: judge Realtime-only, noisy rows report-only).
- CLI: `uv run python -m tests.fixtures.run_tuning_sweep --config a.json [--config b.json] [--corpus …] [--out …] [--limit N] [--only …] [--conditions …] [--snr …] [--yes]`; exit 0 on all self-skips, 1 on cap refusal.
- Seams: `stt_replay._make_stt_provider(api_key, tuning)` (06 plugs `DeepgramParams.from_tuning`), `build_denoise_chain` import guarded (16), `_apply_offline_stages` (16/17), `correctedWer` null (14).
- Checks: pytest 186 passed; ruff check clean; new files formatted at `--line-length 100`.
- Notes: providerLatencyMs measured from end of real audio (includes endpointing wait — deliberate); resume skips all present rows.

## Wave 1 complete

## Wave 2

### Ticket 03 — Persistence, presets, import/export (frontend-builder) — DONE, clean
- New: `tuningPresets.ts` (+16 tests). Changed: `tuningConfig.ts` (`parseImported`, `migrate`), `useTuningConfig.ts` (hydrate-after-capabilities, write effect, presets/import/export/reset), `TuningPanel.tsx` header only, tests, `src/test/setup.ts` (in-memory localStorage — Node 26 shadows jsdom's).
- Hook adds: `presets, selectedPreset, presetModified, importMessage, applyPreset, savePresetAs, deletePreset, exportConfig, importConfig, resetToDefaults`.
- Storage: `boostlingo.tuning.v1 {schemaVersion, draft, applied|null}`, `boostlingo.tuning.presets.v1 {schemaVersion, presets[]}`; nothing else persisted.
- Presets are override specs over server defaults: Provider defaults `{}`; Tuned turn-taking (silence 800, prefix 300, interrupt false; endpointing 800, utteranceEnd 3000); Max denoise (all stages on, far_field).
- Testids: spec'd 7 + `tuning-import-text`, `tuning-import-paste`, `tuning-import-message`, `tuning-sections`. Export filename `tuning-<hex>.json` (no colon). File input always mounted (hidden) for ticket 10.
- Checks: vitest 15 files / 279 passed; oxlint clean; tsc+build ok.

### Ticket 04 — backend (backend-builder) — DONE, clean
- Changed: `app/api/realtime.py` (`tuning` on request as `dict|None` parsed in-route via `RealtimeModeTuning.model_validate` so semantic errors are 400 not 422; `_validate_tuning`, `_turn_detection(tuning)`, `_audio_input(tuning)`; response gains `fingerprint` + `appliedTuning`), `tests/test_realtime.py` (+25; existing 13 unchanged).
- API provided: request `{sourceLanguage, targetLanguage, tuning?: ModeTuningConfig(realtime)}`; response `{client_secret, expires_at, model, voice, fingerprint, appliedTuning}`; no-tuning → fingerprint of .env defaults (`cfg:724ea8f0`). Outbound `session.audio.input.{turn_detection, noise_reduction}` per brief mapping; `noiseReduction` absent→no key, off→null, near/far→{type}. Language 400 still first. 10 exact 400 detail strings (incl. new "Unsupported tuning mode 'cascade'…").
- Checks: test_realtime 39 passed; ruff clean on its files. Full suite: 2 flaky live-Deepgram `test_quality_wer` items (pass in isolation) — pre-existing nondeterminism, noted.

### Ticket 06 — backend (backend-builder) — DONE, clean
- Changed: `providers/deepgram_stt.py` (`DeepgramParams` frozen, defaults = constants, `from_tuning`, `stream(..., params=)`, `_url(params)`), `orchestrator.py` (`_SessionTuning{current,previous,pending,request_id,reconnecting,client}`, `_parse_cascade_tuning(raw,*,cascade,client)` tolerant `_overlay`, `_connection_level_changes`, `_handle_update_tuning(payload, tuning_state, audio_queue, outgoing)`, unsolicited `tuning_applied` as 2nd message), `providers/base.py` (`stream(params)`, `translate(model)`), `openai_translation.py`/`segmentation_checker.py` (per-call `model=`), tests (+21 orchestrator, +5 providers; fakes updated in conftest/test_resilience/test_segmentation/test_memory_stability).
- API provided: `start_session.tuning` (optional, tolerant; legacy `segmentationMode` only when no tuning); `update_tuning{requestId, tuning}`; `tuning_applied{requestId|null, fingerprint, reconnectedStt}`; `tuning_failed{requestId, attempt, maxAttempts, message}`. **Interim (07 replaces):** connection-level change → parked in `pending` + `tuning_failed{attempt:1,maxAttempts:1,"Reconnect-required settings can't be applied live yet."}`.
- Reads of `tuning_state.current`: `_run_stt` (DeepgramParams per (re)connect, segmentation mode/model per result), `_process_segment` (translation model, TTS voices), `_handle_update_tuning`.
- Note: TTS voice ids validated against env-specific `elevenlabs_voices()`; new session = 2 messages (`session_started`, `tuning_applied`) — helpers must drain both.
- Checks: `ruff check app tests` clean; `pytest -q` 238 passed (one live-Deepgram WER flake, passes on rerun).

### Ticket 06 — frontend (frontend-builder) — DONE, clean
- Changed: `useCascadeSession.ts` (`connect(languages, tuning?)` → `tuning` in first `start_session`, legacy `segmentationMode` only when no tuning; `applyTuning()`; `appliedFingerprint`; `tuning_applied`/`tuning_failed` handling; playback deferral + coalescing via `pendingTuningRef`, flushed in the unmute timeout; 10 s timeout; teardown settles in-flight applies), tests +14; `TuningPanel.tsx` Endpointing rows (`tuning-dg-endpointing/utterance-end/diarize`, conditional `reconnects STT` chip) + Segmentation join (`tuning-segmentation-mode-hybrid/llm`), tests +7.
- `CascadeSessionHandle extends SessionHandle` narrows `applyTuning`/`appliedFingerprint` to required (sessionHandle.ts got the optional members from 04 FE mid-run).
- `tuning_failed` settles the apply promise only when `attempt >= maxAttempts` (every attempt console.warned).
- Checks: tsc clean; oxlint clean; vitest 15 files / 315 passed; build ok.
- Open (handed to 07): "Applying after the current reply…" deferred status line not rendered (needs `deferred` state in `useTuningConfig.apply()` + footer branch); interim BE parking of connection-level applies (`tuning_failed attempt 1/1`) to be replaced by the sentinel reconnect.

### Ticket 06 — RECONCILE: CLEAN
- Wire shapes match both ways; fingerprint = hash of `{schemaVersion, mode:'cascade', client, cascade}` on both sides; unsolicited `tuning_applied` is the 2nd server message and FE handles `requestId:null`.
- KNOB_METADATA step for endpointingMs/utteranceEndMs is 1 while UI inputs step 10/100 — no drift (UI values are on the step-1 grid); left as is.

### Ticket 04 — frontend (frontend-builder) — DONE, clean
- Changed: `sessionHandle.ts` (`ApplyResult`/`ApplyTuning` live here; `appliedFingerprint?`, `applyTuning?`, `connect(languages, tuning?)`), `useTuningConfig.ts` (re-exports), `useRealtimeSession.ts` (`tuning` in POST when present; stores server `fingerprint`; cross-checks `appliedTuning`), `TuningPanel.tsx` (Realtime turn-detection rows `tuning-vad-type-server/semantic`, `tuning-vad-threshold/prefix-padding/silence-duration/interrupt-response/eagerness` + `-default` siblings; `appliedFingerprint` prop), `WorkbenchPage.tsx` (`appliedForMode` at both connect sites; `applyTuning`/`appliedFingerprint` into panel), tests +17, `mockRealtimeApis.ts`.
- Switching VAD type drops the other type's optional keys (avoids server 400s). Testids follow wireframe §8 long names.
- Checks: vitest 315 passed; oxlint clean; build ok.

### Ticket 04 — RECONCILE: CLEAN
- Body/response shapes identical both sides; `tuning` absent (not null) when unset; no-tuning response still carries `.env` fingerprint.
- **Brief amendment (adopted):** only two `connect()` call sites (mic button, Try again); mode switch tears down only (existing test forbids auto-reconnect).

## Wave 2 complete → Wave 3 (05, 07, 10, 11, 14, 16, 18; cap 5) — sub-wave 3a = 05, 07, 10, 18; 3b = 11, 14, 16 after 07 lands (orchestrator.py / session-hook contention)

## Wave 3a

### Ticket 05 — Realtime live apply (frontend-builder) — DONE, clean (own files)
- Changed: `useRealtimeSession.ts` (pure `sessionUpdateEvent()`, `isReplyActiveRef`/`pendingTuningRef`, `applyTuning`, `dataChannel.onopen` flush, flush from `response.done` unmute timeout; gate on `readyState==='open'`), tests 21→36 (S7, E2, E3, deferred-disconnected, no-send-after-disconnect, 10 event cases), `mockRealtimeApis.ts` (`readyState`, `emitOpen()`).
- Emitted: `{"type":"session.update","session":{"type":"realtime","audio":{"input":{"turn_detection":{…},"noise_reduction":{"type":"near_field"}|null|absent}}}}`; never model/voice.
- Semantics: no channel → deferred, NOT queued (connect carries it); reply streaming or channel not open → single pending slot (last wins), flushed at onopen / after response.done+tail; else send once, `appliedFingerprint` updated. Realtime `applyTuning` never returns ok:false.
- Notes for 07 FE (already in its brief): deferred copy in footer; don't drive footer off `appliedFingerprint`; dialog Cascade-only. For 18: model/voice "applies at next connect".
- Checks: at a consistent tree: build ok, oxlint clean, vitest 330 passed; later transient failures were 07 FE mid-edit in `useTuningConfig.ts`.

### Ticket 18 — Model/voice pickers wired + validation (general-purpose builder) — DONE, clean (own files)
- New: `backend/tests/test_tuning_pickers.py` (7: F4 for all six Cascade pickers on start_session + update_tuning — fallback to config-in-force, warning per path, no reconnect triggered; wired-through S31 half incl. ttsVoiceB speaker-1 and ELEVENLABS_VOICE_IDS_EXTRA widening). Changed: `TuningPanel.tsx` Models section (allow-list footnote both modes; `applies at next connect` chip on Realtime model/voice rows), `TuningPanel.test.tsx` (+6), README paragraph.
- Verified already correct: `allowlists.py` (`elevenlabs_voices()` two + extras, dedup), `.env.example`, no orphan select options (migrate/parseImported), 06's per-call wiring.
- Label decision: keep "Rachel/Antoni (voice A/B default)" — renaming only server-side would desync from `tuningConfig.ts` fallback + mock; follow-up if wanted must land across 4 files.
- Checks: pytest pickers 7 passed; `ruff check tests` clean; vitest 337 passed; oxlint clean; build/`ruff check app` failing only on 07 BE/FE in-flight edits; full suite 243 passed + 7 live-Deepgram WER flakes.

> Network outage (ENOTFOUND) killed 07 BE, 07 FE and 10 mid-run; all three resumed from transcript with edits intact. Tree at resume: backend `ruff check` clean; frontend `tsc -b` had 4 errors in 07 FE's in-flight test files.

### Ticket 07 — frontend (frontend-builder) — DONE, clean
- Changed: `sessionHandle.ts` (`ApplyProgress`, `ApplyAttemptFailure`, `applyProgress?`), `useCascadeSession.ts` (status→`reconnecting` while a connection-level apply is in flight, per-attempt warn + progress, 20 s timeout, `settleApply`), `useTuningConfig.ts` (`applyState` +`reconnecting`/`deferred`, `maxAttempts`, `clearDeferred()`; dialog only on exhausted budget), `TuningPanel.tsx` (footer branches, dialog attempt log `tuning-apply-failed-log`, Tab trap, Escape swallowed, focus restore→`tuning-revert` fallback; dialog gated to Cascade), `WorkbenchPage.tsx` (`applyProgress` prop), `segmentation.ts` (`tuning_reconnect`→`reconfig`), tests +19.
- Contract expected from BE: `tuning_failed` PER attempt with `attempt<maxAttempts` = progress, `attempt>=maxAttempts` = settle `{ok:false}` → dialog; `tuning_applied{reconnectedStt:true}` → idle; `segment_boundary.trigger:"tuning_reconnect"`.
- Copy: `Reconnecting STT with the new parameters… (attempt i of n)`, `Applying…`, `Applying after the current reply…`, `Applied · cfg:… · HH:MM:SS`; dialog title `Couldn't apply the new settings`.
- Open: Realtime deferred marker has no clear signal (05 could expose a flush notification) — minor.
- Checks: vitest 355 passed; oxlint clean; build ok.

### Ticket 07 — backend (backend-builder) — DONE, clean
- Changed: `orchestrator.py` (`_RECONNECT` sentinel; connection-level `update_tuning` parks + enqueues sentinel, no immediate reply; `audio_iter` returns on sentinel; `_run_stt` StopAsyncIteration → cut partial as `tuning_reconnect`, rotate previous/current/pending, reopen with new params; first result → `tuning_applied{reconnectedStt:true}`; per-attempt `tuning_failed` + warning; revert to previous on exhaustion; revert failure → existing terminal path), `test_orchestrator.py` (+7; `TestConnectionLevelReconnect`: S9, F6, F6-terminal, E4, E6, sentinel race; parked test rewritten).
- Verified sequence: `segment_boundary{tuning_reconnect}` (+ its latency/translate/TTS tail) precedes `tuning_applied{reconnectedStt:true}`, which precedes the first transcript of the new connection. Frames per connection `[[A],[C]]` success; `[[A],[],[],[C]]` fail-then-revert; no `error` on revert success. `maxAttempts = 1+len(retry_backoffs)`: CONNECTION 1, RATE_LIMIT 3, else 2. `message` from `_CLIENT_ERROR_MESSAGES`.
- Judgement calls: while parked, non-connection-level applies also ride along (no immediate reply); E4 coalescing guaranteed inside the close window; **`tuning_applied` waits for first result — can lag until speech**.
- Checks: `ruff check app tests` clean; `pytest -q` 257 passed (no WER flake this run). Mutation-checked.

### Ticket 07 — RECONCILE round 1
- Shapes match. Semantic mismatch: FE 20 s timeout vs BE first-result confirmation → false failure dialog during silence. Fix routed to 07 FE: no reply timeout for applies sent while status is/becomes `reconnecting` (settle on tuning_applied / final tuning_failed / teardown); keep 20 s for others.

### Ticket 10 — capture harness --tuning + report fingerprint (general-purpose builder) — DONE, clean
- Changed: `frontend/e2e/realtime-quality-capture.mjs` (`--tuning <file>`: wait for fingerprint chip (hydration) → toggle → import via file input (paste fallback) → wait "Imported" → apply if enabled → close → read `tuning-fingerprint-latency` → connect → re-read; stamps `fingerprint` + `tuningFile` on envelope and `fingerprint` per item; defaults run stamps `cfg:724ea8f0`), new `frontend/e2e/tuning-import.spec.ts` (S17; new Playwright project `tuning-import`), `playwright.config.ts`, `frontend/e2e/README.md`, `run_realtime_quality_report.py` (fingerprint through `_load_captures→_identity→summary`, `_table_rows()` §7 printer: `| cfg | realtime | cond | -- | WER | -- | judge | -- | E2E |`; legacy captures → `cfg:unknown`), new `test_realtime_quality_report.py` (5), README paragraph.
- **App race found (route to 11 FE):** `useTuningConfig` re-hydrates draft/applied when capabilities resolve, discarding an import/apply done before that. Harness works around by waiting for the chip; app should ignore late hydration once the user has imported/applied.
- Checks: report tests 5 passed; ruff clean; full backend 257 passed; oxlint clean; `npx playwright test tuning-import` 1 passed (against a real backend on 8011 — port 8000 here is an unrelated Django server, so bare run skips).

## Wave 3a complete except 07 FE reconcile round 1 (in flight) → Wave 3b: 14 BE, 16 BE launched now (orchestrator.py free); 11 FE, 14 FE, 16 FE after 07 FE reconcile lands

### Ticket 07 — RECONCILE round 1 result + round 2
- Round 1 (FE): no reply timeout for reconnect applies or applies sent while a reconnect is parked; riders behind a parked reconnect settle with the reconnect's result. vitest 358 passed.
- Round 2 (FE, final): backend echoes the LATEST rider's requestId (`orchestrator.py:1037`), so the sweep must fire on ANY parked id while a reconnect is pending. Routed.
- Round 2 (FE) done: `settleApply` sweeps all pending applies whenever any of them is a reconnect; `seq` picks the last-sent config for `liveTuningRef`. vitest 359 passed. **Ticket 07 RECONCILE: CLEAN.**
- Known minor gap: Realtime deferred marker has no clear signal (would need 05 to expose a flush notification).

## Wave 3b frontend halves launched: 11 (+hydration-race fix), 14 FE, 16 FE

## Wave 3b

### Ticket 14 — frontend (frontend-builder) — DONE, clean
- Changed: `sessionHandle.ts` (`transcript_check` stage; `flagged?`/`correctedFrom?` on segments), `latencyTracking.ts` (stage after speech_end, label `check`), `transcriptPane.ts` (new `applyTranscriptCheck` — replace text by segmentId, set flagged/correctedFrom, no duplicate), `useCascadeSession.ts` (source_transcript with `flagged:true` → merge; envelope types), `WorkbenchPage.tsx` (badge `segment-suspicious-badge` `⚑ check` after trigger annotation, title incl. "was: <correctedFrom>"), tests +23.
- Verified: panel Transcript-check section already live (S25 binding tests added); `routeCascadeError` toasts `retryable:true` regardless of provider → non-fatal.
- Consumes: `source_transcript{…, flagged?, correctedFrom?}`, `latency{stage:"transcript_check"}`, `error{provider:"transcript_check", retryable:true}`.
- Checks: vitest 401 passed; oxlint clean; build ok (transient failures were 11 FE in-flight in `useTuningConfig.test.ts`).

### Ticket 16 — frontend (frontend-builder) — DONE, no code change needed
- noisereduce row already live-wired via ticket 02's generic `ServerStage`/`stageBadge`/`DenoiseStageCard` (installed → live; `!installed` → not installed + reason; installed+reason → "model weights unavailable"; `Cascade only` in Realtime). Added `describe('ticket 16')` (+5) in `TuningPanel.test.tsx`.
- Checks: vitest 401 passed; oxlint clean; build ok.

### Ticket 11 — Mic constraints + hydration guard (frontend-builder) — DONE, clean
- Changed: `useCascadeSession.ts`/`useRealtimeSession.ts` (constraints from `tuning?.client.microphone ?? DEFAULT_TUNING_CONFIG.client.microphone`; Cascade keeps channelCount/sampleRate), `TuningPanel.tsx` (Microphone section: `tuning-mic-ec/ns/agc` toggles per §8, wire names mono, footnote verbatim, `{n} on` chip; removed `EMPTY_SECTION_LINE` — 12/13 need their own if wanted), `useTuningConfig.ts` (hydration guard: `userTouched` ref set by setKnob/setProviderDefault/applyPreset/apply/resetToDefaults/successful importConfig; if touched, hydrate only completes missing keys/repairs ids and never overwrites), tests +14.
- Checks: vitest 401 passed; oxlint clean; build ok.

### Ticket 16 — backend (backend-builder) — DONE, clean
- New: `providers/denoise.py` (`DenoiseStage` Protocol, `NoopStage`, `NoisereduceStage` 480 ms ring buffer w/ lazy import + degrade-to-passthrough + `_last_init_error`, `build_denoise_chain` order noisereduce→deepfilternet, offline stages logged-once/never live, `stage_installed`, `STAGE_MODULES`, **17's seam `_deepfilternet_factory`**), `test_denoise.py` (23). Changed: `orchestrator.py` (`_SessionTuning.denoise_chain` + `set_current()` rebuild incl. reconnect-revert site; chain applied in `audio_iter()`), `api/tuning.py` (reads denoise.*), `pyproject.toml` (`bench = [noisereduce>=3.0.3, numpy>=1.26]`) + `uv.lock`, `test_orchestrator.py` (+S28 class), `test_tuning_api.py` (S29), `stt_replay.py` (unconditional import), README (`uv sync --extra bench`).
- Checks: ruff clean; pytest 303 passed / 5 skipped / 1 failed (14 BE in-flight `test_memory_stability` positional-arg mismatch); own scope 79 passed; real-library run via `uv run --with noisereduce --with numpy` 23 passed.
- Note: first ~480 ms noise profile partly from pre-filled silence (documented).

### Ticket 16 — RECONCILE: CLEAN (row enablement ↔ `stages.noisereduce.installed`; shape unchanged)

### Ticket 14 — backend + harness (backend-builder) — DONE, clean
- New: `providers/transcript_check.py` (`TranscriptChecker.check(text, language, mode, *, model=)` → `TranscriptCheckResult{flagged, corrected_text, failed}`, never raises), `test_transcript_check.py` (14). Changed: `orchestrator.py` (checker in `_start_new_session`, `_run_pipeline` owns pending flag tasks (cancelled in finally), `_check_transcript`/`_flag_transcript`/`_send_flagged_transcript`/`_send_transcript_check_failed`; `_process_segment` calls between `_resolve_direction` and TTS/translation kickoff), `conftest.py` (2nd autouse stub), `test_orchestrator.py` (`TestTranscriptCheck`: S26, S27, F8, F9 +1), `stt_replay.py` (`corrected_transcript`/`corrected_wer`), `run_tuning_sweep.py` (`correctedWer` + §7 cell), `test_tuning_sweep.py` (+5), `test_memory_stability.py` (new positional arg).
- Wire: correct → `latency{transcript_check}` then `source_transcript{…, flagged:true, correctedFrom}` before any target_transcript; flag → `source_transcript{…, flagged:true}` (translation already started); failure → `error{provider:"transcript_check", kind:"UNKNOWN", retryable:true}`; off → nothing. Correct-mode "suspicious but no rewrite" → flagged without correctedFrom.
- Checks: ruff clean; pytest 304 passed / 5 skipped.

### Ticket 14 — RECONCILE: CLEAN

## Wave 3b complete → Wave 4 (12, 17)

## Wave 4

### Ticket 12 — RMS gate + Realtime client DSP (frontend-builder) — DONE, clean
- New: `rmsGate.ts` (+test incl. worklet-parity suite, mutation-checked), `public/gate-processor.js` (shared worklet; `processorOptions.gate`, `port {type:'gateParams', gate}`; re-clamps; `enabled:false` = passthrough), `gateConfig.ts`. Changed: `useCascadeSession.ts` (gate node at insertion point; `postGateParams` alongside `update_tuning`), `useRealtimeSession.ts` (`buildClientDsp`: gate on → `AudioContext → src → gate → MediaStreamDestination`, `addTrack(sentTrack)`; gate off → raw track, no context; `sentTrackRef` used at BOTH mute sites; teardown closes DSP ctx; gateParams alongside session.update), `TuningPanel.tsx` (RMS row first in Denoise chain: `tuning-rms-enabled/threshold/hold/attack/release/attenuation/mute`), mocks (`createMediaStreamDestination`, `sampleRate`, two-way worklet port, `AudioWorkletNode` stub in realtime fakes), tests +47.
- Math: per-128 RMS→dBFS; ≤-80 always open, ≥0 always closed; floorGain = fullMute?0:10^(-att/20); linear ramps over attack/release ms; hold re-armed per open block; starts open.
- Enabling a gate that was off at connect → applies at next connect (visible text). Worklet loaded lazily only when enabled.
- Seam for 13: `buildClientDsp` `if (!client.rmsGate.enabled) return null;` comment marks `|| rnnoise.enabled` + 48 kHz context.
- Checks: vitest 448 passed (16 files); oxlint clean; build ok.

### Ticket 17 — DeepFilterNet + `denoise` extra (backend-builder) — DONE, clean
- Changed: `providers/denoise.py` (`DeepFilterNetStage(attenuation_limit_db, post_filter_beta)`; `_DFRuntime` load seam; module-default `_deepfilternet_factory`; 10 ms (one 480-sample hop @48 k) algorithmic delay, pinned by test; degrade → passthrough + `_last_init_error` + one warning; shared `_record_degradation()`), `pyproject.toml` (`denoise = [torch>=2.4, torchaudio>=2.4,<2.9, deepfilternet>=0.5.6]`, `[[tool.uv.index]] pytorch-cpu`, `[tool.uv.sources]`), `uv.lock` (77 pkgs; deepfilternet pins numpy<2 → bench's numpy 1.26.4), tests (+20 denoise, F15 e2e in test_tuning_api, S28 DFN half), README, `TuningPanel.test.tsx` (+1).
- Real smoke in an isolated venv: 50 passed / 5 skipped; 11.8 ms per 30 ms frame (RTF 0.39), first frame ~2.7 s (init+weights on the event loop — documented). Capabilities: torch absent → installed:false + torch reason; installed + init_df raises → installed:true + "model weights unavailable — see the server log."
- Checks: ruff clean; pytest 321 passed / 7 skipped (+2 errors from 15 BE's in-flight `TestTranscriptCheckRoute` monkeypatching a not-yet-written name).

### Ticket 17 — RECONCILE: CLEAN (row already live-capable; two failure-mode hints as spec'd)

## Wave 5

### Ticket 15 — backend (backend-builder) — DONE, clean
- Changed: `api/tuning.py` (`POST /api/tuning/transcript-check`: `{text, language, mode, model}` → 200 `{flagged, correctedText, elapsedMs}` (+`failed:true` only when the checker had no verdict); 400s: text>2000, mode∉{flag,correct}, model∉TEXT_MODELS, language∉SUPPORTED_LANGUAGES (before key check); 500 no key; 422 missing/wrong-typed), `test_tuning_api.py` (+11).
- Checks: ruff clean; `pytest -q` 334 passed / 7 skipped.

### Ticket 13 — RNNoise (frontend-builder) — DONE, clean, with live evidence
- New: `resample.ts` (+11 tests incl. E9 worklet parity: 8-tap Hamming sinc fc 7 kHz, 3:1, streaming state), `rnnoiseConfig.ts` (`?url` imports for worklet + 2 wasm, `createRnnoiseNode`), `src/test/mockRnnoise.ts`. Changed: `package.json` (+`@sapphi-red/web-noise-suppressor@^0.4.0`), `public/cascade-pcm-processor.js` (decimator when `sampleRate===48000 && processorOptions.targetSampleRate`; chunk at output rate), `cascadeConfig.ts`, `useCascadeSession.ts` (48 k ctx when on; `mic→[gate]→[rnnoise]→pcm`), `useRealtimeSession.ts` (`buildClientDsp` = gate||rnnoise; DSP ctx ALWAYS 48000; `src→[gate]→[rnnoise]→dest`), `TuningPanel.tsx` (RNNoise row after RMS; `tuning-rnnoise-voice-prob` DISABLED with visible note — package exposes no VAD threshold; value still hashed), mocks, tests +27.
- URLs verified: build emits worklet + 2 wasm assets; dev serves them 200; live Chromium run had `pageErrors: []`.
- Live evidence: Cascade sweep (defaults vs rms-gate) identical by construction (server-side replay doesn't apply client DSP). Realtime capture n=2 A/B: RNNoise on `cfg:4762791b` e2e 421/249 ms, transcript exact for a clean clip; off `cfg:724ea8f0` 487/171 ms — AC 3.4 satisfied for Realtime; not a WER measurement. NOTE: harness resumed into gitignored `captures.json` (2 rows overwritten) and regenerated `realtime_quality_report.json`; the report's aggregate mixes 31 untagged rows — do not paste as a cfg:4762791b row.
- Checks: tsc clean; oxlint clean; vitest 475 passed (17 files); build ok.

### Ticket 15 — frontend (frontend-builder) — DONE, clean
- Changed: `realtimeConfig.ts` (`TRANSCRIPT_CHECK_ENDPOINT`), `useRealtimeSession.ts` (settle on `conversation.item.input_audio_transcription.completed` (SDK-verified) → best-effort POST when `mode==='flag'`; `sourceFlagged` cleared on `speech_started`/connect/disconnect; `liveTuningRef` updated immediately by applyTuning for the check; abort on teardown), `sessionHandle.ts` (`sourceFlagged?`), `WorkbenchPage.tsx` (`SuspiciousBadge` shared component; flat-text badge on source pane), `mockRealtimeApis.ts` (route), tests +16.
- Verified panel copy `correct is unavailable: no seam in Realtime.` already exact (02/04/14).
- Checks: vitest 491 passed (17 files); oxlint clean; build ok.

### Ticket 15 — RECONCILE: CLEAN

## STEP 10 COMPLETE — 18/18 tickets built and reconciled (2026-08-16)
Final builder-reported gates: backend `uv run pytest -q` 334 passed / 7 skipped, `ruff check app tests` clean; frontend vitest 491 passed (17 files), oxlint clean, `tsc -b && vite build` clean; Playwright `tuning-import` spec 1 passed against a real backend.

## Step 11 — test-verifier (2026-08-16)
- Added: `backend/tests/test_acceptance_tuning_lab.py` (8; 1 FAILING = real defect), `frontend/src/pages/tuningLab.acceptance.test.tsx` (6, mutation-checked).
- Runs: backend 341 passed / 1 failed / 7 skipped; ruff clean; frontend 497 passed / 18 files; oxlint + tsc clean; Playwright tuning-import 1 passed (against backend on 8011); live WER 33 passed, no flakes.
- Coverage: all 42 ACs / S1–S31 / F1–F17 / E1–E16 covered except: **AC 2.2 ✘** (`stt_replay._make_stt_provider` is still the ticket-09 placeholder — never passes `DeepgramParams.from_tuning`; fingerprinted rows didn't apply deepgram.* knobs), **AC 3.7 ✘** (no measured rows in COMPARISON §7; Cascade sweep can't apply client DSP; Realtime n=2 is not a WER measurement), AC 2.3 ◐ (envelope stamping untested — harness change needed), AC 3.4 ◐ (non-empty transcript needs live keys), E10 hollow (clean row exists but can't serve its RNNoise purpose in the Cascade sweep).
- Minor: `project_mode()` returns aliased sub-dicts (footgun); build-log's "Realtime deferred marker" gap is actually closed in code (stale comment in TuningPanel.tsx:250-266).

## Step 13 (pre-emptive) — AC 2.2 fix (backend-builder) — DONE
- `stt_replay.py`: `_make_stt_provider(api_key, tuning) → (provider, DeepgramParams|None)`; `transcribe_wav_detailed` passes `params=` to `stream()`; placeholder log removed. `test_tuning_sweep.py` +3 (recording provider fixture).
- Checks: acceptance + sweep tests 31 passed; full `pytest -q` 345 passed / 7 skipped; ruff clean.

## Step 12 — security-auditor
- Critical: none. Important: I1 `update_tuning` connection-level spam → unbounded Deepgram connect churn (slot frees on promotion; `attempt=0` each time; no-Origin clients admitted by design) — remedy: per-session reconnect rate limit/cap; I2 `audio_queue` unbounded + synchronous denoise `process()` on the event loop (noisereduce/DFN, DFN init ~2.7 s) — remedy: `maxsize` + drop-oldest, `asyncio.to_thread`; I3 `POST /api/tuning/transcript-check` unauthenticated/unmetered LLM proxy (CORS blocks web pages; local processes can hit it) — remedy: token bucket 429 + shared client. Minor: M1 unbounded `requestId`/rejected-value logging (`%s`), M2 `json.loads` ValueError beyond JSONDecodeError, M3 client.* ranges + NaN/Infinity accepted server-side, M4 prompt-injection steerability of `corrected` + no length cap on Cascade path, M5 harness path traversal (operator-supplied), M6 DFN weights fetched unpinned at first use, M7 preset/import length caps, M8 test-only `new Function`.
- Verified OK: origin guard + explicit CORS list; no key leakage; allow-lists before every provider use; raw ranges before clamp; no innerHTML/eval; localStorage version-gated + revalidated; per-session params only; explicit-scoped torch index; lockfiles committed. Orchestrator verified: no capture/audio data tracked (`git ls-files` empty; WAVs/manifest/*.defaults.json ignored; only noisy/SCRIPT.md trackable).

## Step 12 — implementation-validator
- Critical: AC 3.7 — COMPARISON §7 has no measured rows; Cascade sweep can't apply client stages (structural), Realtime half yields judge/latency not WER. Needs human decision (run offline pre-filter path vs re-scope) — orchestrator will run the measurable subset now and put the decision at the final gate.
- Important: stale `TuningPanel.tsx:10-20` docstring + `:250-266` deferred comment (mechanism exists; build-log "gap" line wrong); unconditional `reconnects STT` chip on Models section (`:1128-1132`); COMPARISON corrected-WER note stale; AGENTS.md lacks the feature-factory phase; per-call `model=` on base/openai_translation/segmentation_checker not in brief's file table (scope-list omission, correct change).
- Minor: no 400 for bad `noiseReduction` (422); orchestrator docstring omits two-opening-messages; `.env.example` lacks `ELEVENLABS_VOICE_ID_SPEAKER_B`; transcript-check prompt uses language code; revert leaves `request_id`; attenuation-disabled reason aria-hidden; apply-during-silence copy.
- Verified OK: all 10 checks (every decision-5/11 knob present; parity; absent-key idiom; reconnect; transcript check; denoise; harness/report; localStorage; a11y; docs/ports).

## Step 13 — fixes
### Frontend (frontend-builder) — DONE
- `TuningPanel.tsx`: docstring rewritten (panel complete); deferred-clearing comment corrected (Realtime confirms locally on send); Models & voices `reconnects STT` chip now conditional on `cascade.deepgram.model` pending; visible "Full mute overrides attenuation." line. `TuningPanel.test.tsx` +1. Build-log's earlier "Realtime deferred marker gap" is CLOSED (was stale).
- Checks: vitest 498 passed; oxlint clean; build ok.
### Backend + docs (backend-builder) — DONE
- Real sweep (96 rows, 0 errors, ~15 min): `cfg:39ace417` defaults, `cfg:9d963847` endpointing 800, `cfg:dc4da27f` transcript-correct, `cfg:b3bb3fbe` noisereduce; 8 items × clean/babble/street @10 dB. Rows pasted verbatim into COMPARISON §7 with honest provenance (client stages NOT measured — structural; Realtime n=2 RNNoise smoke labelled as not-WER; DFN not run — extra not installed). Findings: endpointing 800 → same WER, +~450 ms provider latency; transcript-correct → corrected WER == raw on this subset; noisereduce → +2.6–3.3 s addedLatency/clip and one clean clip WER 100% due to **NaN reaching the int16 cast (`denoise.py:186`)** — real defect, fix in round 2.
- `realtime.py` +400 for bad `noiseReduction` (+test); orchestrator docstring (two opening messages); `.env.example` SPEAKER_B; AGENTS.md "Phase 3" section; COMPARISON corrected-WER note fixed.
- Checks: test_realtime 40 passed; full `pytest -q` 346 passed / 7 skipped; ruff clean.
- Not run: per-fingerprint Realtime report (captures.json back-fills envelope fingerprint onto untagged items — trap documented in §7); needs a fresh per-config re-capture.
### Round 2 (backend-builder) — DONE: noisereduce/DFN non-finite guard
- `denoise.py`: `NoisereduceStage` sanitises the int16 cast (`nan_to_num` + clip; all-NaN slice → passthrough of the input frame + one warning per session via `_warn_non_finite`, no session degradation); `DeepFilterNetStage` `to_pcm16` gains `torch.nan_to_num` (unverified here — extra not installed). `test_denoise.py` +5 (numpy/torch-gated).
- Checks: denoise tests 37 passed w/ numpy overlay; full `pytest -q` 346 passed / 12 skipped; ruff clean.

## Step 13 complete → Step 14 polish

## Step 14 — final-polish (code-polisher) — DONE, green
- ~95 lines removed (duplicate fakes, single-call helpers, dead params/imports, stale comments); em-dash density normalised in backend/app; docs synced (torch size figure, AGENTS.md commit-history claim, README Tuning panel section + "Where things live", NoopStage docstring, e2e README fence). One authorised behaviour fix: `useCascadeSession.flushPendingTuning` clears the slot only after a successful send (+1 test).
- Open review findings: offline demucs/dns64 plumbed but never executed by the sweep (`_apply_offline_stages` no-op → AC 5.4/S30 half-met); `schema.py` post_filter_beta comment says 0.05; degrade-in-place vs brief's "NoopStage"; DFN 10 ms delay not in budget; provider-boundary leak (`DeepgramParams` built in orchestrator; `params: Any` on the Protocol); three range tables (fingerprint/_TUNING_RANGES/_TURN_DETECTION_RANGES) + panel step literals; TS/Py canonicaliser latent divergences (null handling, post-step re-clamp) untested by fixture; `ttsVoiceA` default "" server-side; TuningPanel.tsx 1600+ lines; duplicated §7 renderers; report script hardcodes captures path; README `uv sync --extra` wording vs AGENTS.md; reconnect applies untimed across drop→resume; Cascade DSP ctx only 48 k when RNNoise on (vs AGENTS "always 48 k").
- Proposed docs (not created): CONTRIBUTING.md, docs/api.md, glossary, ADR home; LICENSE (human).
- Checks: ruff clean; pytest 346 passed / 12 skipped; tsc/oxlint clean; vitest 499 passed; build ok.

## READY FOR STEP 15 GATE
