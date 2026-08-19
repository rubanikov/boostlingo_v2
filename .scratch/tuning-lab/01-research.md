# Audio Tuning & Denoise Lab — codebase research report

(codebase-researcher output, feature-factory Step 1, 2026-08-15. Verbatim.)

Repo root: `F:\Users\rubas\Documents\Gauntlet_AI\boostlingo_v2`. Everything below is what the code does **today**; inferences are marked as such.

---

## Relevant files (orientation)

| Path | Role |
|---|---|
| `frontend\src\pages\useCascadeSession.ts` | Cascade transport: getUserMedia → AudioWorklet → WS |
| `frontend\public\cascade-pcm-processor.js` | AudioWorklet PCM16 chunker (separate JS realm) |
| `frontend\src\pages\useRealtimeSession.ts` | Realtime transport: getUserMedia → RTCPeerConnection + `oai-events` |
| `frontend\src\pages\sessionHandle.ts` | The shared `SessionHandle` contract both hooks implement |
| `frontend\src\pages\WorkbenchPage.tsx` | The only page; mode tabs, controls, latency strips |
| `backend\app\api\realtime.py` | Ephemeral-token mint + session JSON payload |
| `backend\app\orchestrator.py` | Cascade WS protocol + STT/segmentation/translate/TTS pipeline |
| `backend\app\providers\deepgram_stt.py` | Deepgram connection params (all module constants today) |
| `backend\tests\fixtures\stt_replay.py` | WAV→Deepgram replay harness (backend-only STT path) |
| `frontend\e2e\realtime-quality-capture.mjs` | Fake-mic Playwright capture harness |
| `backend\tests\fixtures\run_realtime_quality_report.py` | LLM-judge scoring of those captures |
| `COMPARISON.md` | Where measured numbers get written up |

---

## A. Frontend audio capture path

### A1. Cascade capture graph

`frontend\src\pages\useCascadeSession.ts:425-428` — mic request, **hardcoded constraints**:

```ts
const stream = await requestMicStream(
  { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  fail,
);
```

`requestMicStream` (`frontend\src\pages\mediaStream.ts:12-26`) is the shared wrapper: `navigator.mediaDevices.getUserMedia({ audio: constraints })`, mapping `NotAllowedError` to a fixed user-facing message. It takes `MediaTrackConstraints | boolean` — so a tuning panel can pass EC/NS/AGC through unchanged, no signature change needed.

Graph construction, `useCascadeSession.ts:476-504`:
1. `new AudioContext({ sampleRate: 16000 })` — Web Audio resamples the mic's native 44.1/48k down to 16k inside the graph (comment at :476-479).
2. `await captureContext.audioWorklet.addModule('/cascade-pcm-processor.js')` (URL/name constants in `frontend\src\pages\cascadeConfig.ts:15-16`).
3. `micSource = captureContext.createMediaStreamSource(stream)` → `workletNode` → `captureContext.destination` (the destination connect exists **only** to keep `process()` being pulled; the worklet emits silence, :494-496).
4. `workletNode.port.onmessage` forwards the ArrayBuffer straight to the WS, **unless** `isPlaybackActiveRef.current` (mic-mute during TTS playback), :486-491.
5. `startMicLevelMeter(captureContext, micSource, setMicLevel)` inside its own try/catch — metering failure must not fail capture (:498-504).

**This is the single insertion point for a client-side gate / RNNoise node**: `micSource.connect(workletNode)` at :492. Any inserted node must sit between `createMediaStreamSource` and the worklet, and the level meter taps `micSource` (pre-processing) today at :501.

The worklet (`frontend\public\cascade-pcm-processor.js`): `CHUNK_MS = 30` (:16), Int16 buffer of `round(sampleRate * 30/1000)` samples = **480 samples / 960 bytes at 16kHz** (:21), Float→Int16 via `Math.round(clamp(x,-1,1) * 32767)` (:33-34), posts `this._buffer.buffer` (:38). Header comment :1-15 explicitly documents that it runs in `AudioWorkletGlobalScope` and **cannot import the TS module graph** — `floatSampleToInt16` in `frontend\src\pages\pcm.ts:11-14` is a hand-synced duplicate and the unit-tested source of truth.

Worklet params today: **none**. `registerProcessor('cascade-pcm-processor', ...)` with a no-arg constructor (`:18-24, :48`); there is no `parameterDescriptors`, no `processorOptions` passed at `new AudioWorkletNode(captureContext, CASCADE_PCM_WORKLET_NAME)` (`useCascadeSession.ts:485`), and no `port.postMessage` from main thread → worklet anywhere.

### A2. Realtime capture path

`frontend\src\pages\useRealtimeSession.ts:181-184` — different (looser) constraints, **no channelCount/sampleRate**:

```ts
const stream = await requestMicStream(
  { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  fail,
);
```

Then a *separate* `new AudioContext()` (default rate, :193) used **only** for the level meter (:193-199) — the audio itself never passes through Web Audio. The raw track goes to WebRTC: `pc.addTrack(stream.getTracks()[0], stream)` (:229). So **any client-side DSP in Realtime mode requires re-plumbing** (e.g. `MediaStreamAudioDestinationNode` → new track), which does not exist today.

Data channel: `pc.createDataChannel('oai-events')` (:230), `dataChannel.onmessage = handleOaiEvent` (:231), stored in `dataChannelRef` (:232). **Nothing is ever sent on it** — `dataChannelRef.current` is read nowhere except teardown (:155). No `session.update` today.

Events handled (`:88-133`): `conversation.item.input_audio_transcription.delta` → sourceText; `input_audio_buffer.speech_stopped` → latency start; `response.output_audio_transcript.delta` → targetText + **mic mute** (`micTrack.enabled = false`, :112-113) + latency end; `response.done` → re-enable mic after `REALTIME_MUTE_TAIL_MS = 300` (:22, :124-130). Everything else falls through `default: break`.

Remote audio: `pc.ontrack` → `audioRef.current.srcObject` (:222-226), rendered as a hidden `<audio autoPlay hidden data-testid="realtime-audio">` in `WorkbenchPage.tsx:410`.

### A3. Mic level meter

`frontend\src\pages\micLevel.ts`: structural interfaces (`AnalyserLike`, `MicLevelSourceLike`, `MicLevelAudioContextLike`) so tests pass fakes (:7-19). `peakLevel()` = max |byte-128| / 128, clamped to 1 (:30-37). `startMicLevelMeter(ctx, source, onLevel, schedule?, cancel?)` creates an analyser with `fftSize = 512`, connects source→analyser, samples once per rAF (:47-78). `schedule`/`cancel` are injectable for deterministic tests. Returns `{ stop() }`.

Note: it reports **peak**, not RMS — a dBFS-threshold gate UI would need its own RMS computation (this file is the natural home; it already owns the analyser pattern).

### A4. `SessionHandle` contract

`frontend\src\pages\sessionHandle.ts:73-132`. Required: `status`, `errorMessage`, `sourceText`, `targetText`, `micLevel`, `connect(languages)`, `disconnect()`. Optional/mode-specific (the documented extension pattern — "left `undefined` by the other transport", used 5× already): `sourceSegments`, `targetSegments`, `cascadeLatency`, `cascadeToasts`, `segmentTriggers`, `endToEndLatencyMs`. Also `ConnectionStatus = 'idle'|'connecting'|'connected'|'reconnecting'|'error'` (:10), `SessionLanguages` (:13-16), `LatencyStage` union (:37-43), `CascadeSegmentLatency` (:50-53), `DEFAULT_LANGUAGES` (:135).

`connect` currently takes exactly one arg (`SessionLanguages`). **A tuning config would either be a second arg to `connect` or a new `applyTuning(config)` method on the handle** — the latter fits the existing optional-member convention. `useRealtimeSession` extends the handle with `audioRef` (`useRealtimeSession.ts:44-46`), precedent for hook-specific additions.

### A5. WorkbenchPage

`frontend\src\pages\WorkbenchPage.tsx:259-413`. **Both hooks are always mounted** (:260-261) and `session` is picked by mode (:265) so switching never remounts. Mode switch tears down the live session first (:268-277). Language pairs are a local const list keyed to the backend allow-list (:19-22). Controls rendered: mode tabs, language `select`, connection badge, error alert + Try again, toasts, `CascadeLatencyStrip` / `RealtimeLatencyBadge`, dual transcript cards, mic level bar (`data-testid="mic-level-bar"`, :390-396), mic button, hidden audio element.

There is **no settings/panel component, no drawer, no modal** in the app today — `App.tsx` renders `<WorkbenchPage />` and nothing else. A tuning panel would be the first such component (see F for where components live).

### A6. Existing query-param override (the precedent to generalize)

`frontend\src\pages\segmentation.ts:28-31`:

```ts
export function resolveSegmentationModeOverride(search: string): SegmentationModeOverride | undefined {
  const value = new URLSearchParams(search).get('segMode');
  return value === 'llm_priority' ? 'llm_priority' : undefined;
}
```

Consumed at `useCascadeSession.ts:455` and spread conditionally into `start_session` (`...(segmentationMode ? { segmentationMode } : {})`, :460) so an absent value lets the backend default apply. `segmentTriggerLabel` (:47-49) maps `llm`→"llm", `deepgram_speech_final`/`deepgram_utterance_end`→"pause", unknown passes through.

### A7. Latency records on the frontend

Cascade: `frontend\src\pages\latencyTracking.ts` — `LATENCY_STAGES` ordered list (:18-25), `isLatencyStage()` narrowing (:30-32), `CascadeLatencyState = { bySegment, mostRecentCompletedSegmentId }` (:39-42), `recordLatencyStage()` (:55-61), `currentCascadeLatency()` returns only the most recently *completed* segment (:64-68), `latencyBadges()` computes the bottleneck badge (:97-123). State lives in the hook (`useCascadeSession.ts:72, :283-289`) and is **not persisted anywhere** — no export, no file write, no POST.

Realtime: `frontend\src\pages\realtimeLatency.ts` — pure `onSpeechStopped` / `onResponseAudioTranscriptDelta`, single `endToEndMs` number (:15-42).

**Where a config fingerprint could attach (inference, marked as such):** the only structured latency record objects are `CascadeSegmentLatency` (`sessionHandle.ts:50-53`) and `RealtimeLatencyState` (`realtimeLatency.ts:15-20`). Neither has any session-scoped metadata field today. The only place a fingerprint is currently *observable* off the UI is the rendered badge text, which is exactly how the capture harness scrapes latency: `realtime-quality-capture.mjs:183-190` regexes `(\d+)\s*ms` out of `getByTestId('realtime-latency-badge')`.

---

## B. Realtime backend

### B1. Session creation

`backend\app\api\realtime.py`. Constants at :10-15:

```python
OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
REALTIME_MODEL = "gpt-realtime"
REALTIME_VOICE = "alloy"
EXPIRES_AFTER_SECONDS = 600
TRANSCRIPTION_MODEL = "gpt-4o-transcribe"
```

Request model (:18-26) — **only two fields today**, aliased camelCase, both defaulted:

```python
class RealtimeSessionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    source_language: str = Field(default="en", alias="sourceLanguage")
    target_language: str = Field(default="es", alias="targetLanguage")
```

Validation: each code must be in `SUPPORTED_LANGUAGES` else HTTP 400 **before** any OpenAI call (:123-131). Missing key → 500 (:116-120).

The exact outbound payload (`:144-162`):

```python
payload = {
    "expires_after": {"anchor": "created_at", "seconds": EXPIRES_AFTER_SECONDS},
    "session": {
        "type": "realtime",
        "model": REALTIME_MODEL,
        "instructions": instructions,
        "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {"model": TRANSCRIPTION_MODEL},
                "turn_detection": _turn_detection(),
            },
            "output": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "voice": REALTIME_VOICE,
            },
        },
    },
}
```

Note **rate 24000** both directions (vs Cascade's 16000). The comment at :138-143 records that this nested GA shape replaced a flat beta shape and was verified against the pinned SDK's generated types. There is **no `input_audio_noise_reduction` key anywhere in the repo** (grepped) — it would be a new sibling of `transcription`/`turn_detection` under `audio.input`.

Response (:29-43, :196-201): `{client_secret, expires_at, model, voice}`, read from `data["value"]`, `data["expires_at"]`, `session.model`, `session.audio.output.voice`; a missing `value`/`expires_at` on a 2xx returns the same clean 502 as a ≥400 (`_bad_upstream_response`, :46-56). httpx timeout 10.0 (:173).

`_interpreter_instructions(source_name, target_name)` (:59-85) is a plain f-string prompt; no model/voice choice flows through it.

### B2. `_turn_detection()` — currently uncommitted (git status shows `M backend/app/api/realtime.py`)

`realtime.py:88-98`:

```python
def _turn_detection() -> dict:
    turn_detection: dict = {"type": "server_vad"}
    if settings.realtime_vad_silence_ms is not None:
        turn_detection["silence_duration_ms"] = settings.realtime_vad_silence_ms
    if settings.realtime_vad_interrupt_response is not None:
        turn_detection["interrupt_response"] = settings.realtime_vad_interrupt_response
    return turn_detection
```

Key idiom: **a key is only added when the setting is set**, so "unset" is genuinely the OpenAI default rather than a restatement. Pinned by two tests: `backend\tests\test_realtime.py:127` asserts the bare `{"type": "server_vad"}` and `:130-151` asserts the tuned shape. No `semantic_vad`, `threshold`, `prefix_padding_ms`, or `eagerness` support exists.

### B3. Settings

`backend\app\config.py:1-32` — one `Settings(BaseSettings)` with `SettingsConfigDict(env_file=".env", extra="ignore")`, module-level singleton `settings = Settings()` (:32). Fields: three API keys, `elevenlabs_voice_id` (default `21m00Tcm4TlvDq8ikWAM` "Rachel"), `elevenlabs_voice_id_speaker_b` (`ErXwobaYiN019PkySvjV` "Antoni"), `cors_origins: list[str] = ["http://localhost:5173"]`, and the two `realtime_vad_*` optionals (:28-29, also uncommitted). Env names are the upper-snake field names (`REALTIME_VAD_SILENCE_MS` etc., per `.env.example:5-8`).

Tests monkeypatch the singleton's attributes directly (`test_realtime.py:68, :137-138`) — that's the established injection mechanism for settings.

### B4. Where Realtime transcripts/latency are computed

**Entirely client-side.** The backend sees nothing after minting the token (documented in `sessionHandle.ts:121-127`, `realtimeLatency.ts:1-13`, `COMPARISON.md:27-31`). Source/target text accumulate in `useRealtimeSession.ts:92, :119`; latency in `realtimeLatency.ts`.

---

## C. Cascade backend

### C1. Route + origin guard

`backend\app\api\cascade.py:8-14` is a 6-line passthrough to `run_cascade_session(websocket)`. Origin check lives in `backend\app\orchestrator.py:392-396`: an `Origin` header present but not in `settings.cors_origins` → close 1008; **absent Origin is allowed** (non-browser tooling). CORS middleware itself (`backend\app\main.py:10-16`) never sees WS upgrades.

### C2. Wire protocol — exact shapes

**Client → server** (`orchestrator.py:400-412, :621-666`):

```jsonc
// first message, required, must be one of these two
{"type": "start_session", "languages": ["en", "es"], "segmentationMode": "hybrid" | "llm_priority"}  // segmentationMode optional
{"type": "resume_session", "sessionId": "<hex>"}
// during the session
{"type": "clock_sync", "clientTime": 1755280000000}
{"type": "playback_started", "segmentId": "<hex>", "clientTime": 1755280000123}
// binary frames = raw PCM16 mono 16kHz mic audio
```

Parsing is deliberately tolerant: `_parse_languages` (:437-454) falls back to `("en","es")` for anything malformed/unsupported; `_parse_segmentation_mode` (:460-467) falls back to `"hybrid"`; **any unrecognized text message type is silently ignored** (`:661-665` — the `if/elif` has no else). That means a new control message type is additive and backward-compatible in both directions.

**Server → client** (all via `_OutgoingSocket`):

```jsonc
{"type":"session_started","sessionId":"<hex>"}                                        // :479
{"type":"source_transcript","segmentId":"…","text":"…","isFinal":true|false,"speaker":0|1|null}  // :938-946, :966-974
{"type":"target_transcript","segmentId":"…","text":"…","isFinal":false|true,"speaker":…}         // :1133-1141, :1254-1262
{"type":"segment_boundary","segmentId":"…","trigger":"deepgram_speech_final"|"llm"|"deepgram_utterance_end"}  // :744-746
{"type":"latency","segmentId":"…","stage":"stt_final|speech_end|translation_first_token|translation_complete|tts_first_byte|playback_start","ms":123}  // :748-758, :1084-1086, :691-693
{"type":"tts_audio_meta","segmentId":"…","sampleRate":16000,"speaker":…}   // :298-306, immediately followed by a binary PCM16 frame
{"type":"clock_sync_ack","clientTime":…,"serverTime":…}                    // :676-678
{"type":"error","provider":"…","kind":"…","message":"…","retryable":true|false}       // :1287-1295, :533-541, :703-711
```

`_OutgoingSocket` (:259-331) serializes all writes under one lock precisely so `tts_audio_meta` is never separated from its binary frame (:294-308); it also implements `detach()`/`rebind()` for the grace-window resume and a backpressure warning at >5 pending sends (:140, :312-316).

### C3. Pipeline shape

`_start_new_session` (:470-520) constructs **four provider objects per session** from `settings`:

```python
stt_provider = DeepgramSTTProvider(settings.deepgram_api_key)
translation_provider = OpenAITranslationProvider(settings.openai_api_key)
tts_provider = ElevenLabsTTSProvider(settings.elevenlabs_api_key, settings.elevenlabs_voice_id)
segmentation_checker = SegmentationChecker(settings.openai_api_key)
```

…then spawns exactly two tasks: `_run_stt(...)` (:493-506) and `_run_pipeline(...)` (:507-518), joined by `segment_queue`. Audio flows client → `_pump_client_messages` → `audio_queue.put_nowait(bytes)` (:648-651) → `audio_iter()` inside `_run_stt` (:813-818) → `stt_provider.stream(audio_iter(), languages=(src,tgt))` (:876-878).

**Server-side denoise insertion point:** `audio_iter()` at `orchestrator.py:813-818` is the single choke point where every mic frame passes as `bytes` before reaching Deepgram, or alternatively `_pump_audio` in `deepgram_stt.py:168-170`. Frames are ~960 bytes / 30ms (from the worklet) but nothing enforces size.

Segmentation race, `_run_stt` (:762-1046): `asyncio.wait({next_item_task, clause_check_task}, return_when=FIRST_COMPLETED)` (:886). `speech_final` cuts unless mode is `llm_priority` (:976); `UtteranceEndSignal` always cuts (:900-923); a `True` clause verdict cuts (:1009-1020). Losers are "parked" via `_park_stale` (:838-840) and their results discarded. Outer retry loop reconnects `stream()` on `ProviderError` per `retry_backoffs` (:853, :1026-1046) — **note this already re-creates the Deepgram connection mid-session over the same `audio_queue`, which is the mechanism a param-change reconnect would reuse.**

`_run_pipeline` (:1049-1076) → `_process_segment` (:1219-1269): starts the TTS task first, then streams translation deltas into both the client and `tts_input` concurrently, sends `TTSFlush` at the end.

**Where a transcript-check stage slots in (inference):** the cleanest seam is `_process_segment` at :1231-1234, between `_resolve_direction` and `_run_translation_with_retry` — `segment.text` is the finished source transcript there, and a corrected text would flow into translation and (if you also want it displayed) a re-sent `source_transcript` with `isFinal: true`. The alternative seam is `_cut_segment` (:714-759), which is where `_CompletedSegment(segment_id, buffer, speaker, detected_language)` is constructed (:759) — but that call is on the STT hot path and would delay `speech_end`.

`_CompletedSegment` is a 4-field dataclass (:191-196); adding a field is a one-line change, all construction is at :759.

### C4. Providers

**Deepgram** (`backend\app\providers\deepgram_stt.py`): every connection parameter is a **module-level `Final` constant or a literal inside `_url()`** — `MODEL = "nova-3"` (:52), `ENDPOINTING_MS = 500` (:53), `UTTERANCE_END_MS = 3000` (:58), `SAMPLE_RATE = 16000` (:59); `_url()` (:140-165) builds the query with `interim_results=true`, `utterance_end_ms`, `vad_events=true`, `encoding=linear16`, `sample_rate`, `channels=1`, `model`, `language=multi`, `diarize=true`. **`stream()` explicitly discards the `languages` argument** (`del languages`, :77). The provider takes only `api_key` in `__init__` (:71-72) — per-session params would need a constructor or `stream()` signature change plus updating `test_providers.py:291-320` which asserts substrings of the URL.

Reconnect: `with_reconnect(lambda: self._stream_once(audio_chunks), provider="deepgram")` (:78). **Yes, the STT connection can be re-established mid-session with the same audio iterator** — that's `_resilience.with_reconnect` (`backend\app\providers\_resilience.py:66-93`, backoffs 0.5/1/2s, 3 attempts) and also `_run_stt`'s outer loop. There is **no mechanism to trigger a reconnect deliberately** today — only exceptions do it (inference: a param change would need either a new sentinel/exception or a restart of the `stt_task`).

**Translation** (`openai_translation.py`): `MODEL = "gpt-4o-mini"` (:25), client built once per session with `httpx.Timeout(30.0, connect=10.0)` (:39-41), streaming chat completions, error mapping at :71-86.

**Segmentation checker** (`segmentation_checker.py`): `MODEL = "gpt-4o-mini"` (:25), timeout `(10.0, connect=5.0)` (:41), `max_tokens=3`, prompt template at :27-32, **any `OpenAIError` returns `False`** (:72-73). Explicitly documented as *not* a `Protocol` provider — "orchestration logic, not a swappable vendor boundary" (:8-13). A transcript-check stage would most naturally follow this file's shape.

**TTS** (`elevenlabs_tts.py`): `MODEL_ID = "eleven_flash_v2_5"` (:42), `SAMPLE_RATE = 16000` → `OUTPUT_FORMAT = "pcm_16000"` (:43-44), voice is per-call (`synthesize(..., voice=...)`, :60-70) resolved from `orchestrator._voice_for_speaker` (:178-188) which maps speaker parity → the two `settings.elevenlabs_voice_id*` values.

**Protocols** (`base.py:93-151`): `STTProvider.stream`, `TranslationProvider.translate`, `TTSProvider.synthesize` — all `Protocol`, all `def` returning `AsyncIterator` (not `async def`), documented at :98-101. `ProviderError(kind, provider, message, retryable=)` + `ProviderErrorKind` enum (:18-41).

---

## D. Quality suite & harnesses

### D1. Backend-only STT replay (the "Cascade STT harness" you'd extend)

`backend\tests\fixtures\stt_replay.py` — this already **is** a backend-only Cascade STT harness. `transcribe_wav(path, source_lang, target_lang, api_key)` (:106-141) streams a WAV through the real `DeepgramSTTProvider` in 20ms chunks (:28-29) with 1.5s trailing silence appended (:39, :101-103, needed or Deepgram never finalizes — see the docstring's two hard-won bugs), stops on `speech_final`, joins final segments. `assert_wav_format` enforces **mono/16-bit/16kHz** (:78-89). `word_error_rate` = `jiwer.wer` with a `NORMALIZE` transform (lowercase, strip punctuation, collapse spaces) (:56-64, :144-145).

Consumers: `backend\tests\test_quality_wer.py` (module-level `skipif` on `settings.deepgram_api_key`, :47-53; per-item `pytest.skip` if the WAV is missing, :74-79; `WER_THRESHOLD = 0.20`, :59) and `run_real_audio_report.py`.

### D2. Real-recording harness with the self-skip pattern

`backend\tests\fixtures\run_real_audio_report.py` — **this is the model for "user-supplied real recording set, self-skip if absent"**: `_load_manifest()` returns `[]` if the file is missing (:82-85), and `main()` prints a friendly message and returns cleanly, "exiting cleanly, not an error" (:96-103). Per-item skips for missing/wrong-format audio print an `ffmpeg` conversion command (:119-130). Manifest item shape (docstring :44-51): `{id, audioFile, sourceLang, targetLang, referenceText, conditions}`. Report JSON: `{results: [...], summary: {total, averageWordErrorRate, translationsAcceptable}}` (:178-192).

### D3. LLM judge

`backend\app\quality\llm_judge.py`: `judge_translation(source_text, source_language, candidate, target_language, *, client=None) -> TranslationJudgment{acceptable, issues, notes}` (:51-96), `MODEL = "gpt-4o-mini"`, `response_format={"type":"json_object"}`, system prompt at :27-36. API failures **propagate** (deliberate, :68-76); only malformed content is parsed defensively (`_parse_response`, :99-131). Injectable `client` exists specifically so a batch runner shares one and tests inject a fake.

### D4. Report producers

- `backend\tests\fixtures\run_quality_report.py` — Cascade: translate each dataset item with the real provider, judge it, write `tests/fixtures/quality_report.json` `{results, summary:{total, acceptable, acceptanceRate}}` (:95-109).
- `backend\tests\fixtures\run_realtime_quality_report.py` — reads `realtime_quality/captures.json`, judges each against `referenceText` (not the caption), writes `tests/fixtures/realtime_quality_report.json`. Summary block (:136-148):

```python
summary = {
  "captured": …, "judged": …, "translationsAcceptable": …, "acceptanceRate": …,
  "averageCaptionWordErrorRate": …,
  "endToEndLatencyMs": {"n": …, "mean": …, "min": …, "max": …},
}
```

  Per-result rows carry `id, sourceLang, targetLang, referenceText, referenceTranslation, conditions, status, inputTranscript, captionWordErrorRate, outputTranscript, translationAcceptable, translationIssues, translationNotes, endToEndLatencyMs` (:114-126, `_identity` :171-179). It even **prints a ready-to-paste COMPARISON.md table row** at :164-168 — that's the existing convention for feeding the write-up. **This is the natural place to produce a per-config comparison table**, and the natural place to key rows by a config fingerprint.
- Invocation is module-form (`uv run python -m tests.fixtures.run_realtime_quality_report`) so `app` imports resolve (:28).

### D5. Fake-mic capture harness

`frontend\e2e\realtime-quality-capture.mjs` (npm script `capture:realtime-quality`, `package.json:14`). Key mechanics:
- **One `chromium.launch()` per clip** (:129-136) because `--use-file-for-fake-audio-capture` is fixed per browser process; flags `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--use-file-for-fake-audio-capture=<padded>%noloop`.
- **Padding**: `LEAD_SILENCE_S = 4`, `TAIL_SILENCE_S = 3`, `SAMPLE_RATE = 16000` (:63-65); `padClip()` (:219-269) hand-writes a 44-byte WAV header and validates mono/16-bit/16kHz — **this is the existing dependency-free WAV manipulation code a noise-mixing script would mirror**.
- Drives the real UI: clicks the `Realtime` tab, clicks `Connect microphone`, waits for the status badge, scrapes `getByTestId('target-transcript')` / `source-transcript` / `realtime-latency-badge` (:143-190).
- Args: `--only`, `--limit`, `--headed`, `--manifest`, `--out` (:310-327) — **`--manifest`/`--out` already parameterize corpus and output path**, so per-config runs need no new plumbing there.
- Writes after every clip (crash-safe, :101-102). Output envelope: `{baseUrl, leadSilenceS, items: [...]}` (:271-276). Item shape confirmed in `captures.defaults.json:5-18`: `{id, sourceLang, targetLang, referenceText, referenceTranslation, conditions, capturedAt, inputTranscript, outputTranscript, endToEndLatencyMs, pageErrors, error}`.
- `assertServersUp()` (:278-308) probes `POST /api/realtime/session` with `sourceLanguage: 'zz'` and expects a 400 mentioning "Unsupported language code" — a deliberate identity check that an unrelated server isn't on the port.

### D6. Playwright config

`frontend\playwright.config.ts`: three projects, one per fixture file (`realtime-fake-mic`, `cascade-fake-mic`, `noise-rejection-fake-mic`, :95-123), each with `permissions: ['microphone']` + `fakeMicArgs()` (:50-56). `HAS_REAL_SPEECH_FIXTURE` is exported and computed at config-load (:22) so specs can gate at collection time (`cascade.spec.ts:53`). Port **5183**, `--strictPort`, deliberately not 5173 (:26-31). `webServer` starts both Vite and `uv run uvicorn app.main:app --port 8000` (:80-94).

Self-skip idioms: collection-time `(HAS_REAL_SPEECH_FIXTURE ? test : test.skip)(...)` (`cascade.spec.ts:53`), runtime `test.skip(finalStatus !== 'Connected', '…')` (`cascade.spec.ts:60`, `noise-rejection.spec.ts:44-48`), and the "accept either outcome" assertion `expect(['Connected','Error']).toContain(finalStatus)`.

### D7. COMPARISON.md

`COMPARISON.md` §1 Latency (tables at :36-44), §2 Quality (table at :85-94), §3 Cost, §4 Controllability, §5 Recommendation, §6 model comparison. Every table row states how it was obtained and the exact reproduce command (e.g. :106-110). Numbers come from the JSON reports above, transcribed by hand into markdown tables — **there is no script that generates COMPARISON.md sections**. §2's existing "defaults vs tuned" two-row comparison (:91-94) is the closest existing precedent for a per-config comparison table.

---

## E. Config, deps, commands

**Backend deps** (`backend\pyproject.toml`): PEP 621 `[project].dependencies` (:7-18: fastapi, httpx, jiwer, openai, psutil, pydantic, pydantic-settings, python-dotenv, uvicorn[standard], websockets) plus `[dependency-groups].dev` (:20-25: pytest, pytest-asyncio, ruff). **There is no `[project.optional-dependencies]` section today** — an extras group would be the first. `requires-python = ">=3.12"`. Lockfile `uv.lock`; `uv sync` per `README.md:86-88`.

**Commands** (from `README.md:119-155`, `package.json:6-15`, `frontend\e2e\README.md:52-61`):
- Backend tests: `cd backend && uv run pytest -v` (119 passing with keys).
- Backend lint: `ruff` is a dev dep; **no configured script or `[tool.ruff]` section, and no ruff.toml/pytest.ini/setup.cfg exist** — invocation is bare `uv run ruff check`/`format` (inference from the dep alone).
- Frontend: `npm test` (vitest run), `npm run test:watch`, `npm run lint` (oxlint, config `frontend\.oxlintrc.json`), `npm run build` (`tsc -b && vite build` — that's the typecheck), `npm run test:e2e`, `npm run capture:realtime-quality`.
- Dev servers: `.\dev.ps1` from repo root (auto port resolution, kills leftover repo-owned processes, `-SkipInstall` switch), or two terminals: `uv run uvicorn app.main:app --reload --ws-ping-interval 20 --ws-ping-timeout 20` and `npm run dev`.

**Settings/.env**: single `Settings` class, `env_file=".env"`, `extra="ignore"` (`config.py:5`); `.env` lives at `backend/.env`; `.env.example` is the tracked template. Frontend env: only `VITE_API_BASE_URL`, read in `cascadeConfig.ts:7-8` and `realtimeConfig.ts:5-6` (deliberately duplicated, not shared — see the comment at `cascadeConfig.ts:1-4`).

**CORS**: `main.py:10-16`, `allow_origins=settings.cors_origins`, `allow_credentials=True`, methods/headers `*`. WS upgrades bypass it (see C1).

**.gitignore** (`.gitignore:8-36`): generated TTS audio, all real recordings, `realtime_quality/*.wav`, `manifest.json`, `captures*.json`, `.padded/`, `realtime_quality_report*.json`, and `frontend/e2e/fixtures/real-speech.wav` are all ignored — **any new noisy-variant audio corpus should follow the same "generated/personal audio is not committed, the script + SCRIPT.md are" convention.**

---

## F. Conventions

**Frontend**
- Everything lives flat in `frontend\src\pages\` — hooks, pure logic modules, and the single page component, with `*.test.ts(x)` co-located. There is no `components/` directory today; a Tuning panel component would go in `src/pages/` to match, or establish a new folder (a deviation).
- **Pure-logic-extracted-from-hooks** is the dominant idiom: `segmentation.ts`, `cascadeResilience.ts`, `latencyTracking.ts`, `realtimeLatency.ts`, `transcriptPane.ts`, `pcm.ts` are all pure modules with their own unit tests, explicitly "kept independent of the WebSocket/React state so both are testable without a live socket" (`segmentation.ts:1-8`). **A `tuningConfig.ts` pure module + its test is the fitting shape.**
- Web Audio types are declared as **structural interfaces** (`AnalyserLike`, `AudioContextLike`, …) so jsdom fakes satisfy them (`micLevel.ts:1-19`, `gaplessPlayer.ts:1-22`).
- Tests: Vitest + `@testing-library/react`; `renderHook`/`act`/`waitFor` for hooks (`useCascadeSession.test.ts:1-56`), `render` + `userEvent` for the page (`WorkbenchPage.test.tsx:39-60`). Globals stubbed via `vi.stubGlobal` in `beforeEach`, `vi.unstubAllGlobals()` in `afterEach`. Shared fakes live in `frontend\src\test\`: `mockCascadeApis.ts` (MockWebSocket with `emitOpen/emitMessage/emitClose`, FakeAudioContext, FakeAudioWorkletNode, `installMockGetUserMedia`), `mockRealtimeApis.ts` (fetch router, MockRTCPeerConnection/DataChannel, `createMockMicStream`), `mockAudioAnalysis.ts` (`installManualAnimationFrame`, `FakeAnalyserNode.setNextData`). `setup.ts` only wires jest-dom + cleanup.
- DaisyUI 5 + Tailwind 4, theme `luxury` set via `@plugin "daisyui" { themes: luxury --default; }` in `index.css:1-4`. Class usage is vanilla DaisyUI: `card card-border bg-base-100`, `card-body`, `badge badge-*`, `btn btn-circle btn-lg btn-primary`, `tabs tabs-box tabs-sm`, `select select-sm`, `alert alert-error/alert-warning alert-soft`, `toast toast-top toast-end`, `progress progress-success`, `navbar`. Status/tone maps are `Record<ConnectionStatus, …>` consts at module top (`WorkbenchPage.tsx:29-70`). Custom CSS is minimal and commented (:6-26 of index.css).
- Test hooks for E2E are `data-testid` (`source-transcript`, `target-transcript`, `mic-level-bar`, `cascade-latency-strip`, `realtime-latency-badge`, `realtime-audio`). **Add a testid to any new panel control the harness must drive.**

**Backend**
- Layering: `api/` thin routes → `orchestrator.py` (Cascade wiring) → `providers/` (vendor boundaries, `Protocol`-typed) + `quality/` (batch/offline utilities, explicitly *not* providers).
- Naming: private module functions prefixed `_`; wire-facing JSON is **camelCase** (`segmentId`, `sampleRate`, `clientTime`, `sourceLanguage`) while Python is snake_case, bridged either by literal dict keys or by pydantic `alias` + `populate_by_name` (`realtime.py:23-26`).
- Validation posture is **asymmetric by transport and documented as such**: HTTP → 400/500 with detail; WebSocket → tolerant fallback to a default, never kill the session (`orchestrator.py:437-467`, `languages.py:1-12`).
- Constants are module-level `Final` with a comment explaining the number's provenance (`deepgram_stt.py:52-59`, `_resilience.py:37-39`, `orchestrator.py:122-142`).
- Tests: pytest + pytest-asyncio; `pytestmark = pytest.mark.asyncio` or per-test markers. Provider injection is `monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)` against the **module-level name** (`test_orchestrator.py:131-133`) — fakes are plain classes matching the Protocol shape, no inheritance (:24-92). WS tests use `starlette.testclient.TestClient` + `client.websocket_connect("/ws/cascade")`. Time is made deterministic by monkeypatching `orchestrator._now_ms` with a sequence (`_sequential_clock`, :100-106). Live-key tests self-skip with a message naming the exact env var. `conftest.py` has exactly one autouse fixture, stubbing `SegmentationChecker` so legacy tests don't hit OpenAI.
- Every module carries a substantial docstring explaining *why*, including recorded corrections (e.g. `deepgram_stt.py:157-161` on `detect_language`). This is a strong house style — new modules should match it.

---

## Constraints & gotchas for the builders

1. **The worklet realm cannot import TS.** `public/cascade-pcm-processor.js` is loaded by URL into `AudioWorkletGlobalScope`; the Float→Int16 formula is hand-duplicated with `pcm.ts` (both files say so at `cascade-pcm-processor.js:1-15` and `pcm.ts:1-10`). A worklet-side RMS gate must be self-contained JS, and any parameters must arrive via `processorOptions` (constructor) or `port.postMessage` (live) — **neither exists today**; the port is currently one-way worklet→main (`useCascadeSession.ts:486`).
2. **Sample rates differ by mode**: Cascade capture 16kHz (AudioContext-forced, `useCascadeSession.ts:480`), Cascade TTS playback 16kHz but read dynamically from `tts_audio_meta.sampleRate` (`:124-135`), Deepgram input 16kHz (`deepgram_stt.py:59`), Realtime both directions 24kHz (`realtime.py:152, :157`), Realtime meter AudioContext at the browser default. RNNoise expects 48kHz frames of 480 samples — none of the current contexts run at 48k.
3. **Both modes mute the mic during reply, differently.** Cascade *withholds WS frames* while `isPlaybackActiveRef` is true (`useCascadeSession.ts:487`), armed from the gapless player's `queuedUntil()` plus `PLAYBACK_MUTE_TAIL_MS = 200` (:35, :216-227). Realtime sets `micTrack.enabled = false` on every `response.output_audio_transcript.delta` and re-enables 300ms after `response.done` (`useRealtimeSession.ts:22, :112-130`). A gate/denoise stage sees no audio during those windows in Cascade, and a disabled track in Realtime.
4. **Realtime audio never touches Web Audio.** The raw `MediaStreamTrack` goes straight into `pc.addTrack` (`useRealtimeSession.ts:229`). Client-side DSP for Realtime requires inserting a `MediaStreamAudioDestinationNode` and swapping the track — new plumbing, and it will interact with #3 (`enabled=false` is applied to `mediaStreamRef.current`'s track, not the processed one).
5. **The data channel is receive-only today.** `dataChannelRef` is set and never used (`useRealtimeSession.ts:232`, only read at teardown :155). Sending `session.update` also needs readiness handling (`onopen`) that doesn't exist, and the mock (`MockRTCDataChannel` in `mockRealtimeApis.ts:70-84`) already has a `send = vi.fn()` ready to assert against.
6. **Deepgram params are connection-level constants**, and `stream()` ignores its `languages` arg (`deepgram_stt.py:77`). Changing endpointing/utterance_end/model/diarize mid-session means tearing down and re-calling `stream()`. The machinery to do that safely already exists (`_run_stt`'s outer loop reuses the same `audio_queue`, `orchestrator.py:853, :1035-1039`; `with_reconnect` in `_resilience.py:66-93`), but **nothing today triggers it deliberately** — only exceptions do. Three tests assert URL substrings (`test_providers.py:295-320`) and will need updating.
7. **Any new WS message type from the client is silently ignored** by `_pump_client_messages` (`orchestrator.py:661-665`) and any unknown server type just logs a warning client-side (`useCascadeSession.ts:316-317`) — so the protocol extends safely, but a typo fails silently rather than loudly.
8. **`start_session` must be the first message, strictly before binary frames** (`orchestrator.py:400-412`; the client sets up the worklet only after sending it, `useCascadeSession.ts:448-482`). A tuning payload therefore has to ride *inside* `start_session` or arrive as a later control message.
9. **The origin check** (`orchestrator.py:392-396`) rejects browser origins not in `settings.cors_origins`; the Playwright harness runs on port **5183** while `cors_origins` defaults to **5173** — meaning e2e Cascade runs against the default config would be rejected by that guard (observed from config, not verified live; flagging as a likely trap for any new harness on a new port).
10. **No `input_audio_noise_reduction`, no `semantic_vad`, no model/voice pickers, no localStorage, no fingerprint** exist anywhere in the repo (grepped) — all greenfield. `REALTIME_MODEL`/`REALTIME_VOICE`/`TRANSCRIPTION_MODEL` are constants (`realtime.py:12-15`), as are the translation/segmentation/TTS models.
11. **The `_turn_detection()` work is uncommitted.** `git status` at session start showed `M backend/app/api/realtime.py`, `M backend/app/config.py`, `M backend/tests/test_realtime.py` plus two untracked fixture JSONs. Whoever builds on it should expect to rebase around or absorb that change.
12. **Heavy-dep runtime detection has no precedent here.** There are no optional extras, no `importlib.util.find_spec` checks, and no capability endpoint. The frontend would need a new way to learn what's installed server-side (today it learns nothing about backend capabilities — the only backend-shape knowledge is the hardcoded `LANGUAGE_PAIR_OPTIONS` list in `WorkbenchPage.tsx:19-22`, kept in sync by hand with `languages.py:23-27`).
13. **Cascade latency is per-segment and ephemeral**; Realtime latency is a single number scraped from badge text by the harness (`realtime-quality-capture.mjs:183-190`). Stamping a fingerprint onto "latency records" means either adding a field to `CascadeSegmentLatency`/the `latency` WS message, or (cheaper, matching the existing scraping approach) adding it to the capture harness's output envelope at `realtime-quality-capture.mjs:271-276` and the report rows at `run_realtime_quality_report.py:114-126, :171-179`.
14. **One browser process per audio file** is a hard Chromium constraint the capture harness already works around by relaunching per clip (`realtime-quality-capture.mjs:129`) and Playwright works around by having one *project* per fixture (`playwright.config.ts:95-123`). A benchmark sweeping N noise variants × M configs is N×M browser launches in the Realtime half; the backend-only Cascade half (`stt_replay.py`) has no such cost.
15. **`stt_replay.py` needs trailing silence or Deepgram never finalizes** (:39, :92-103) and paces chunks with real `asyncio.sleep` (:100) — a large benchmark sweep runs in roughly real time, and the safety timeout is `max(2× duration, 10s)` (:49-50, :137).
16. Untested/unknown from reading alone: whether any of the DSP libraries named in the brief (RNNoise-WASM, DeepFilterNet, noisereduce, Demucs, torch) are installed anywhere — they appear nowhere in `pyproject.toml`, `package.json`, or the source.
