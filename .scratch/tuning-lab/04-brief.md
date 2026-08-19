# Audio Tuning & Denoise Lab — technical brief

(spec-writer output, feature-factory Step 6, 2026-08-15. Status: DRAFT pending Step 7 gate.)


> **Field-name correction (verified against the pinned OpenAI SDK, `backend/.venv/Lib/site-packages/openai/types/realtime/realtime_audio_config_input.py:34`):** the GA Realtime field is `noise_reduction` (a sibling of `transcription`/`turn_detection` under `session.audio.input`, typed `{"type": "near_field" | "far_field"} | null`), not the beta-era `input_audio_noise_reduction` used in earlier artifacts. The brief uses the GA name throughout.

Sources: `.scratch/tuning-lab/00-idea-brief.md`, `01-research.md`, `02-story.md` (approved, incl. Step 3 gate), `03-wireframe-notes.md` (approved, incl. Step 5 gate). Wireframe mock: `.lavish/step5-wireframe-tuning-lab.html` — **layout source of truth for all Frontend work**.

## Goal & scope

Expose every audio, turn-taking, segmentation, denoise and transcript-check processing step as a user selection in an in-app Tuning panel, carried as one shared `TuningConfig` JSON document across UI, backend and harnesses; apply it at session start and live mid-session in both modes; and make every configuration measurable against a synthesised noisy corpus, with WER, LLM-judge score and added latency joined to a config fingerprint. Nothing is settable only via `.env` or a query param any more — `.env` becomes *server defaults*, published through a new capabilities endpoint so the panel can display them.

| Tier | Deliverable | Stories/ACs |
|---|---|---|
| **1** (must) | `tuningConfig.ts` + pydantic mirror + fingerprint; `TuningPanel`; `POST /api/realtime/session` `tuning`; `GET /api/tuning/capabilities`; Cascade `start_session.tuning` + `update_tuning`/`tuning_applied`/`tuning_failed`; deliberate Deepgram reconnect; `SessionHandle.applyTuning` + `connect(languages, tuning?)`; localStorage, presets, export/import, fingerprint chips | Story 1 (1.1–1.13) |
| **2** (must) | `make_noisy_corpus.py` + SCRIPT.md; `stt_replay.py` extension; `run_tuning_sweep.py`; `--tuning` on `realtime-quality-capture.mjs`; fingerprint through `run_realtime_quality_report.py`; COMPARISON.md §7 | Story 2 (2.1–2.8) |
| **3** (should) | Mic constraint toggles; RMS gate worklet; RNNoise; OpenAI `noise_reduction`; Realtime client-DSP re-plumbing | Story 3 (3.1–3.7) |
| **4** (should) | `TranscriptChecker` (off/flag/correct); `transcript_check` latency stage; `flagged`/`correctedFrom` on `source_transcript`; `POST /api/tuning/transcript-check` for Realtime `flag` | Story 4 (4.1–4.7) |
| **5** (cut first) | `DenoiseStage` protocol; `NoisereduceStage`; `DeepFilterNetStage`; offline Demucs/DNS64 in the sweep only; capability discovery | Story 5 (5.1–5.5) |
| **6** (cut first) | Curated model/voice pickers + server-side allow-list validation | Story 5 (5.6–5.7) |

Cut from the bottom: dropping tier 6 leaves the model constants as they are today; dropping tier 5 leaves `stages.*.installed = false` for every torch stage and the Denoise-chain rows permanently disabled (the panel still shows them — locked decision 11).

---

## Data model changes

**There is no database and no ORM in this repo.** The "data model" here is (a) the shared `TuningConfig` JSON schema, (b) two localStorage keys, (c) three on-disk JSON report/manifest shapes. Stated per the required headings:

### Tenant boundary

This is a **single-user local lab application**: no accounts, no auth, no tenant key, no per-user isolation (explicitly out of scope, story "Out of scope" line 135). The isolation boundaries that *do* exist and **must not be weakened**:

1. **Per-session, never module-global.** Today `deepgram_stt.py:52-59` holds `MODEL`/`ENDPOINTING_MS`/`UTTERANCE_END_MS`/`SAMPLE_RATE` as module-level `Final` constants. **Loud flag: if live-apply were implemented by mutating those constants, one browser tab's Apply would silently re-parameterise every other concurrent Cascade session's STT connection.** All per-session tuning state MUST live in objects constructed inside `_start_new_session` (`orchestrator.py:470-520`) and be passed down explicitly. This is why `DeepgramParams` is a per-`stream()` argument, not a provider attribute mutated in place.
2. **The WebSocket `Origin` guard** (`orchestrator.py:392-396`) is the only thing stopping an arbitrary page from opening a session against the developer's real API keys. Widening `settings.cors_origins` widens that guard. See Risks for the 5183 decision.
3. **No config is stored server-side** (story AC 1.8, locked decision 10). `GET /api/tuning/capabilities` is read-only and derives from `settings` + `importlib.util.find_spec`; no endpoint writes to `settings` or to disk.

### Timezone handling

No date/time value in this feature is stored in a database, compared, or used for arithmetic. Explicitly:

| Value | Where | Timezone | Storage vs display |
|---|---|---|---|
| `capturedAt` (existing, `realtime-quality-capture.mjs:124`) | `captures*.json` | **UTC** | `new Date().toISOString()` → `…Z`. Never displayed. |
| `generatedAt` (new) | `noisy_manifest.json`, `tuning_sweep.json` | **UTC** | `datetime.now(timezone.utc).isoformat()` → `…+00:00`. Never displayed. |
| Panel status line `Applied · cfg:7f3a9c21 · 12:04:31` | React state only | **Browser local** | `toLocaleTimeString()`, display-only, **never persisted, never sent, never part of the fingerprint**. |
| Failure-dialog attempt log timestamps | React state only | **Browser local** | Same as above. |
| `_now_ms()` (existing, `orchestrator.py:153-160`) | latency maths | **epoch ms, TZ-free** | Unchanged; the `transcript_check` stage reuses it. |

There are no "days", deadlines, schedules or date boundaries anywhere in this feature.

### `TuningConfig` schema (schemaVersion 1)

The full document carries **both** modes so one export/import round-trips everything. What goes on the wire and what gets hashed is a **mode-scoped projection**.

```ts
// frontend/src/pages/tuningConfig.ts  (PURE, unit-tested)
export const TUNING_SCHEMA_VERSION = 1 as const;

export interface ClientTuning {                  // shared by both modes
  microphone: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean };
  rmsGate: {
    enabled: boolean;
    thresholdDbfs: number;   // -80..0   step 1    default -45
    holdMs: number;          // 0..2000  step 10   default 200
    attackMs: number;        // 0..500   step 1    default 5
    releaseMs: number;       // 0..2000  step 10   default 80
    attenuationDb: number;   // 0..60    step 1    default 12
    fullMute: boolean;       //                    default false
  };
  rnnoise: { enabled: boolean; voiceProbThreshold: number }; // 0..1 step 0.05, default 0.5
}

export interface RealtimeTuning {
  model: string;                                  // REALTIME_MODELS, default 'gpt-realtime'
  voice: string;                                  // REALTIME_VOICES, default 'alloy'
  turnDetection: {
    type: 'server_vad' | 'semantic_vad';          // required, default 'server_vad'
    threshold?: number;                           // server_vad only, 0..1  step 0.05
    prefixPaddingMs?: number;                     // server_vad only, 0..5000
    silenceDurationMs?: number;                   // server_vad only, 0..10000
    eagerness?: 'low' | 'medium' | 'high' | 'auto'; // semantic_vad only
    interruptResponse?: boolean;                  // both types
  };
  noiseReduction?: 'off' | 'near_field' | 'far_field'; // see three-state note below
  transcriptCheck: { mode: 'off' | 'flag'; model: string }; // TEXT_MODELS
}

export interface CascadeTuning {
  deepgram: {                                     // ← the connection-level block
    model: string;                                // DEEPGRAM_MODELS, default 'nova-3'
    endpointingMs: number;                        // 0..5000,     default 500
    utteranceEndMs: number;                       // 1000..5000,  default 3000
    diarize: boolean;                             //              default true
  };
  segmentation: { mode: 'hybrid' | 'llm_priority'; model: string };
  denoise: {
    noisereduce:   { enabled: boolean; propDecrease: number; stationary: boolean }; // 0..1 step 0.05, default 1.0 / false
    deepfilternet: { enabled: boolean; attenuationLimitDb: number; postFilterBeta: number }; // 0..100 default 30 / 0..1 step 0.05 default 0.02
    offline:       { demucs: boolean; dns64: boolean };   // benchmark-only; live path ignores + logs
  };
  transcriptCheck: { mode: 'off' | 'flag' | 'correct'; model: string };
  translationModel: string;                       // TEXT_MODELS, default 'gpt-4o-mini'
  ttsVoiceA: string;                              // ELEVENLABS_VOICES ids
  ttsVoiceB: string;
}

export interface TuningConfig {
  schemaVersion: typeof TUNING_SCHEMA_VERSION;
  client: ClientTuning;
  realtime: RealtimeTuning;
  cascade: CascadeTuning;
}

/** The wire + hash document. `mode` is part of the hash on purpose: the same
 *  knobs in different modes are different runs. */
export type ModeTuningConfig =
  | { schemaVersion: 1; mode: 'realtime'; client: ClientTuning; realtime: RealtimeTuning }
  | { schemaVersion: 1; mode: 'cascade';  client: ClientTuning; cascade: CascadeTuning };

export function projectMode(c: TuningConfig, mode: 'cascade' | 'realtime'): ModeTuningConfig;
```

Pydantic mirror, side by side (`backend/app/tuning/schema.py`, **new module**, camelCase aliases + `populate_by_name`, matching `realtime.py:23-26`):

```python
class ClientTuning(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    microphone: Microphone = Field(default_factory=Microphone)
    rms_gate: RmsGate = Field(default_factory=RmsGate, alias="rmsGate")
    rnnoise: Rnnoise = Field(default_factory=Rnnoise)

class RealtimeTurnDetection(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    type: Literal["server_vad", "semantic_vad"] = "server_vad"
    threshold: float | None = None
    prefix_padding_ms: int | None = Field(default=None, alias="prefixPaddingMs")
    silence_duration_ms: int | None = Field(default=None, alias="silenceDurationMs")
    eagerness: Literal["low", "medium", "high", "auto"] | None = None
    interrupt_response: bool | None = Field(default=None, alias="interruptResponse")

class RealtimeTuning(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    model: str = REALTIME_MODEL                      # existing constant realtime.py:12
    voice: str = REALTIME_VOICE                      # existing constant realtime.py:13
    turn_detection: RealtimeTurnDetection = Field(default_factory=RealtimeTurnDetection, alias="turnDetection")
    noise_reduction: Literal["off", "near_field", "far_field"] | None = Field(default=None, alias="noiseReduction")
    transcript_check: TranscriptCheck = Field(default_factory=TranscriptCheck, alias="transcriptCheck")

class CascadeDeepgram(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")
    model: str = deepgram_stt.MODEL                  # 'nova-3', deepgram_stt.py:52
    endpointing_ms: int = Field(default=deepgram_stt.ENDPOINTING_MS, alias="endpointingMs")     # 500, :53
    utterance_end_ms: int = Field(default=deepgram_stt.UTTERANCE_END_MS, alias="utteranceEndMs") # 3000, :58
    diarize: bool = True                             # literal in _url(), deepgram_stt.py:162
# CascadeTuning, ModeTuningConfig follow the same shape.
```

**`undefined` / absent = "provider default".** Only these fields carry absent-key semantics, and they are exactly the fields that pass straight through to a provider: `realtime.turnDetection.{threshold, prefixPaddingMs, silenceDurationMs, eagerness, interruptResponse}` and `realtime.noiseReduction`. Absent ⇒ the key is **omitted from the outbound OpenAI payload entirely**, preserving `_turn_detection()`'s idiom (`realtime.py:88-98`, pinned by `test_realtime.py:127`). Every other field is required-with-a-default (they are our knobs, not the provider's).

`noiseReduction` is genuinely **three-state plus absent**, and the wireframe (§3 rule 1) calls this out:

| Panel state | JSON | Outbound `session.audio.input` |
|---|---|---|
| "Provider default" checked | key absent | no `noise_reduction` key at all |
| `off` selected | `"noiseReduction": "off"` | `"noise_reduction": null` (SDK: "can be set to `null` to turn off", `realtime_audio_config_input.py:14-20`) |
| `near_field` / `far_field` | `"noiseReduction": "near_field"` | `"noise_reduction": {"type": "near_field"}` |

### Fingerprint algorithm (exact — both languages must agree byte for byte)

```
fingerprint(config, mode):
  1. doc = projectMode(config, mode)                     # includes schemaVersion and mode
  2. strip: recursively delete every key whose value is undefined (TS) / None (Py).
     false, 0, "" and [] are NOT stripped.
  3. quantise: every float knob is clamped to its documented range and rounded to
     its documented step (see the schema table) before serialisation.
  4. serialise: canonical JSON, no whitespace at all:
       - object keys sorted ascending by UTF-16 code unit (TS Array.sort default)
         == Python sorted() default. All keys are ASCII [a-zA-Z0-9], so the two agree.
       - Python: json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
       - TS: hand-written emitter in tuningConfig.ts (do NOT rely on JSON.stringify
         key order); strings JSON-escaped, no non-ASCII escaping.
       - numbers: if the value is integral, emit as an integer with no decimal point
         (Python must emit `1`, not `1.0` — use int(x) when float(x).is_integer());
         otherwise emit the shortest decimal form (TS String(x); Py repr(round(x, 2))).
         Step-quantisation in (3) guarantees at most 2 decimal places.
  5. digest = sha256(utf8(json)).hexdigest()
  6. return "cfg:" + digest[:8]
```

Display form is the full `cfg:xxxxxxxx` string everywhere (chip, status line, report rows, COMPARISON.md).

**Parity is enforced by a committed fixture, not by a comment.** New file `shared/tuning-fingerprint-cases.json` (repo root, one file, new directory) holds `[{name, config, mode, expectedFingerprint}]`; `backend/tests/test_tuning_config.py` and `frontend/src/pages/tuningConfig.test.ts` both read that exact file and assert. A fixture that isn't literally the same bytes on both sides proves nothing.

### Curated allow-lists (named constants, mirrored TS ↔ Python, served by `/api/tuning/capabilities`)

Canonical home: `backend/app/tuning/allowlists.py`. The frontend never hardcodes these — it reads them from the capabilities response, with `tuningConfig.ts`'s copies used only as the offline fallback (wireframe §3 rule 5).

| Constant | Initial values | Verified against |
|---|---|---|
| `REALTIME_MODELS` | `gpt-realtime`, `gpt-realtime-mini` | `openai/types/realtime/realtime_session_create_request.py:60,72` |
| `REALTIME_VOICES` | `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar` | `openai/types/realtime/realtime_audio_config_output.py:20` |
| `DEEPGRAM_MODELS` | `nova-3`, `nova-2` | current default `deepgram_stt.py:52` |
| `TEXT_MODELS` | `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1-nano` | used for translation / segmentation / transcript-check pickers |
| `ELEVENLABS_VOICES` | `[{id: settings.elevenlabs_voice_id, label:"Rachel (voice A default)"}, {id: settings.elevenlabs_voice_id_speaker_b, label:"Antoni (voice B default)"}]` + any extra ids from a new optional `settings.elevenlabs_voice_ids_extra: list[str] = []` | `config.py:14,18` |
| `TURN_DETECTION_TYPES` / `EAGERNESS` / `NOISE_REDUCTION` | `server_vad,semantic_vad` / `low,medium,high,auto` / `off,near_field,far_field` | `realtime_audio_input_turn_detection.py:17,87,96`; `noise_reduction_type.py:7` |

### Deepgram connection-level fields (trigger a reconnect)

```ts
export const DEEPGRAM_CONNECTION_LEVEL_PATHS = [
  'cascade.deepgram.endpointingMs',
  'cascade.deepgram.utteranceEndMs',
  'cascade.deepgram.diarize',
  'cascade.deepgram.model',
] as const;
```
Everything else on the Cascade side applies without a reconnect. Mirrored in Python as `DEEPGRAM_CONNECTION_LEVEL_FIELDS` so the server decides the reconnect independently of what the client claims.

### localStorage keys (client-only; no tenant key, no server copy)

| Key | Shape |
|---|---|
| `boostlingo.tuning.v1` | `{ schemaVersion: 1, draft: TuningConfig, applied: { cascade: ModeTuningConfig, realtime: ModeTuningConfig } }` |
| `boostlingo.tuning.presets.v1` | `{ schemaVersion: 1, presets: [{ name: string, config: TuningConfig }] }` |

One `draft` document satisfies the Step-5 gate's "each mode keeps its own draft" for free (Cascade edits live in `draft.cascade`, Realtime in `draft.realtime`). `applied` is **per-mode** so pressing Apply in Cascade cannot commit Realtime's pending edits. Read path: parse → if `schemaVersion` missing/≠1, discard the whole entry with a `console.warn` and fall back to server defaults; else validate, drop unknown keys with a warning, fill missing keys from server defaults.

### New/changed on-disk JSON shapes

```jsonc
// backend/tests/fixtures/noisy/noisy_manifest.json           (NEW, git-ignored)
{ "generatedAt": "2026-08-15T09:12:04+00:00", "seed": 1234, "sampleRate": 16000,
  "items": [{ "id":"short-en-01__babble__10dB", "sourceItemId":"short-en-01",
              "audioFile":"short-en-01__babble__10dB.wav", "sourceLang":"en","targetLang":"es",
              "referenceText":"…","referenceTranslation":"…",
              "condition":"babble","snrDb":10,"measuredSnrDb":10.02,"peakScale":1.0 }] }

// backend/tests/fixtures/tuning_sweep.json                   (NEW, git-ignored)
{ "generatedAt":"…", "configs":[{"fingerprint":"cfg:7f3a9c21","file":"a.json","mode":"cascade"}],
  "rows":[{ "fingerprint":"cfg:7f3a9c21","itemId":"short-en-01","condition":"babble","snrDb":10,
            "wer":0.18,"correctedWer":0.12,"addedLatencyMs":41.3,"providerLatencyMs":812,
            "status":"ok","skipReason":null }] }

// realtime_quality/captures*.json envelope gains fingerprint  (realtime-quality-capture.mjs:271-276)
{ "baseUrl":"…","leadSilenceS":4,"fingerprint":"cfg:7f3a9c21","tuningFile":"configs/a.json","items":[…] }
// each item gains "fingerprint"; run_realtime_quality_report.py's _identity() (:171-179) gains it too,
// and the summary block (:136-148) gains "fingerprint".
```

`.gitignore` gains `backend/tests/fixtures/noisy/*.wav`, `backend/tests/fixtures/noisy/noisy_manifest.json`, `backend/tests/fixtures/tuning_sweep*.json` — matching the existing "generated/personal audio is not committed, the script + SCRIPT.md are" convention at `.gitignore:8-28`.

---

## Background flow / process flow

### 1. Session start (both modes)

Synchronous, on the Connect click. `WorkbenchPage` calls `session.connect(selectedPair.languages, appliedForMode)`.

- **Realtime**: `requestMicStream(constraintsFrom(tuning.client.microphone))` → build the DSP graph if any client stage is on → `POST /api/realtime/session` with `tuning` → mint token → SDP exchange → `dataChannel.onopen` flushes any queued `session.update`.
- **Cascade**: `requestMicStream(...)` → open WS → `start_session` **carrying `tuning`** as the strictly-first message (`orchestrator.py:400-412` requires this; `useCascadeSession.ts:448-462` already sends it before any worklet exists) → `clock_sync` → build the capture graph.

Server responds with the effective config + fingerprint (`appliedTuning`/`fingerprint` on the HTTP response; a `tuning_applied` message with `requestId: null, reconnectedStt: false` right after `session_started` on the WS). The panel displays the **server's** fingerprint, so UI and backend can never silently disagree.

### 2. Live apply — Realtime (client-only, no backend involvement)

`useRealtimeSession.applyTuning(config)`:
1. If a reply is streaming (between `response.output_audio_transcript.delta` and `response.done` + `REALTIME_MUTE_TAIL_MS`, `useRealtimeSession.ts:106-130`) **or** the data channel isn't `open`, store into a single `pendingTuningRef` slot and return `{ok:true, deferred:true}`. Last write wins → **rapid Applies coalesce for free**.
2. Otherwise `dataChannelRef.current.send(JSON.stringify(sessionUpdateEvent(tuning)))` and resolve `{ok:true, reconnectedStt:false, deferred:false}`.
3. `response.done`'s existing unmute timeout and `dataChannel.onopen` both call `flushPendingTuning()`.

`model` and `voice` are **not** live-updatable (`session_update_event.py:19`) — the panel marks those rows "applies at next connect" per wireframe §4.

### 3. Live apply — Cascade (the deliberate Deepgram reconnect)

New per-session object, constructed in `_start_new_session` alongside the four providers (`orchestrator.py:486-491`):

```python
class _SessionTuning:
    def __init__(self, tuning: CascadeTuning) -> None:
        self.current = tuning          # read by audio_iter / _run_stt / _process_segment
        self.previous = tuning         # revert target on exhausted retries
        self.pending: CascadeTuning | None = None   # single slot => coalescing
        self.request_id: str | None = None
        self.reconnecting = False
```

`_pump_client_messages` (`orchestrator.py:661-665`, today an `if/elif` with no `else`) gains one branch:

```python
elif message_type == "update_tuning":
    await _handle_update_tuning(payload, tuning_state, audio_queue, outgoing)
```

`_handle_update_tuning`:
1. `new = _parse_cascade_tuning(payload.get("tuning"))` — **tolerant**, per the documented asymmetric posture (`orchestrator.py:437-467`): each field that fails to parse or falls outside its allow-list/range keeps the current value and logs a warning. Never closes the session (story AC 5.7).
2. Split the diff by `DEEPGRAM_CONNECTION_LEVEL_FIELDS`.
3. **Non-connection-level** (segmentation mode/model, transcript-check mode/model, translation model, TTS voices, server denoise stages + params): assign `tuning_state.current = new` and reply immediately with `tuning_applied{requestId, fingerprint, reconnectedStt: false}`. These are read *per segment* (`_run_stt`'s clause-check call, `_process_segment`) or *per frame* (`audio_iter`'s denoise chain), so the next segment/frame picks them up with no restart (story AC 1.6).
4. **Connection-level**: set `tuning_state.pending = new`, `tuning_state.request_id = requestId`, then **`audio_queue.put_nowait(_RECONNECT)`** — an ordinary sentinel object placed in FIFO order behind every frame already enqueued. A second `update_tuning` arriving before the reconnect completes just overwrites `pending` (a fresh sentinel is only enqueued if `pending` was previously `None`), so **two Applies 200 ms apart produce exactly one reconnect** with the later config.

**Why no frame is lost — the ordering, spelled out.** `_pump_client_messages` is the *only* producer on `audio_queue` (`orchestrator.py:648-651`). `audio_iter()` (`orchestrator.py:813-818`) gains one line: popping `_RECONNECT` `return`s, ending *this* stream's iterator only. Frames enqueued after the sentinel remain in the queue, untouched, in order. The sequence:

1. `audio_iter()` returns → `deepgram_stt._pump_audio` (`:168-170`) finishes → the `async with websockets.connect(...)` block exits → Deepgram flushes and closes → `_receive_results` pushes `_STREAM_DONE` (`:196`) → `_stream_once`'s loop returns (`:109-110`) → `stream()` ends → `_run_stt`'s `next_item_task.result()` raises `StopAsyncIteration` (`orchestrator.py:891`).
2. Today that branch means "audio exhausted, clean finish". It gains a check: **if `tuning_state.pending is not None`**, then instead of returning:
   - park any in-flight clause check (`_park_stale`), and **flush a non-empty `buffer` via `_cut_segment(..., trigger="tuning_reconnect", ...)`** so the partial transcript becomes a real segment rather than being dropped;
   - `tuning_state.previous, tuning_state.current, tuning_state.pending = tuning_state.current, tuning_state.pending, None`; `tuning_state.reconnecting = True`; `attempt = 0`;
   - `continue` the existing outer `while True` (`orchestrator.py:854`), which constructs a fresh `audio_iter()` over the **same `audio_queue`** and calls `stt_provider.stream(..., params=DeepgramParams.from_tuning(tuning_state.current))`.
3. On the first successful result from the new connection, `_run_stt` sends `tuning_applied{requestId, fingerprint, reconnectedStt: true}` and clears `reconnecting`.
4. The client keeps sending frames throughout; they accumulate in the unbounded `audio_queue` and drain into the new socket. At 16 kHz mono PCM16 that is ~32 KB/s, bounded by the reconnect duration.

`trigger: "tuning_reconnect"` is a **new `segment_boundary` value**. This is additive-safe: unknown triggers already pass through `segmentTriggerLabel` (`segmentation.ts:47-49`) and unknown server message types are already warned-and-ignored client-side (`useCascadeSession.ts:316-317`). `segmentation.ts` gains an explicit `'tuning_reconnect' → 'reconfig'` mapping.

**Failure path** (Step 3 gate, incl. the human's addendum). The existing `except ProviderError` handler (`orchestrator.py:1026-1046`) gains a `tuning_state.reconnecting` branch:
- Every failed attempt: `logger.warning("tuning reconnect attempt %d/%d failed (%s) for request %s", ...)` **and** `tuning_failed{requestId, attempt, maxAttempts, message}` to the client (which logs a `console.warn` too — "log every failure", both sides).
- `maxAttempts = 1 + len(retry_backoffs(exc))` — reuses `_resilience.py`'s existing 3 attempts / 0.5-1-2 s budget, no new retry mechanism.
- On exhaustion: **revert** — `tuning_state.current = tuning_state.previous`, `reconnecting = False`, one more `continue` with the previous params so the session keeps running on the config the client still believes is live. The client shows the failure `<dialog>` (wireframe §6) with Retry / Revert to previous.
- If the reverted reconnect *also* fails, fall through to today's terminal path unchanged: `_send_error` + `_record_failure_and_maybe_trip` (`:1044-1045`).

Deferred Apply during Cascade TTS playback is handled **client-side**: `useCascadeSession.applyTuning()` holds the config in one `pendingTuningRef` slot while `isPlaybackActiveRef.current` is true (`useCascadeSession.ts:487`), flushing when playback clears — status line "Applying after the current reply…" (Step 5 gate outcome 2). Same slot coalesces rapid Applies before they ever hit the wire.

### 4. Server-side denoise chain (Cascade)

New `backend/app/providers/denoise.py`:

```python
class DenoiseStage(Protocol):
    name: str
    def process(self, frame: bytes) -> bytes: ...   # PCM16 mono 16k in, same byte length out
    def reset(self) -> None: ...

def build_denoise_chain(tuning: CascadeTuning) -> list[DenoiseStage]: ...
```

Applied in `audio_iter()` (`orchestrator.py:813-818`), the single choke point every mic frame passes through, **before** Deepgram. Frames are 960 bytes / 480 samples / 30 ms (worklet, `cascade-pcm-processor.js:16,21`) but nothing enforces size, so every stage must handle arbitrary lengths. When nothing is enabled `build_denoise_chain` returns `[]` and `audio_iter` skips the whole path — **zero cost when off**. The chain is rebuilt whenever `tuning_state.current` changes identity (non-connection-level applies included), with `reset()` called on the old chain.

Fixed chain order (cheap first): `noisereduce → deepfilternet`.

| Stage | Implementation |
|---|---|
| `NoopStage` | identity; the `name` is what the sweep reports for a bare config |
| `NoisereduceStage` | `noisereduce` has no streaming API. Keeps a `_NR_CONTEXT_MS = 480` ring buffer, runs `noisereduce.reduce_noise(y, sr=16000, prop_decrease=…, stationary=…)` over the buffer on each new frame, emits the **last 30 ms** of the result. Zero added algorithmic delay, but re-processes overlapping context — a real CPU cost, measured in tier 2. |
| `DeepFilterNetStage` | DFN runs at 48 kHz with a 480-sample (10 ms) hop. Resamples 16k→48k (`torchaudio.functional.resample`, ships with torch), runs 3 DFN hops per 30 ms frame, resamples back. `init_df()` is lazy on first use, cached; a load failure sets `_last_init_error` (surfaced by capabilities as `reason`) and the stage degrades to `NoopStage` for the rest of the session with one warning log. |
| Offline (`demucs`, `dns64`) | **Not constructed by `build_denoise_chain`.** If enabled in a live session the orchestrator logs `"offline-only denoise stage %s ignored in the live path"` once. Only `run_tuning_sweep.py` honours them, applied to the whole WAV before replay. |

All CPU-only, no GPU (locked decision, story out-of-scope line 128).

**No live per-frame latency readout.** Latency messages are per-segment and frames can't be attributed to segments. AC 2.7 ("added latency is attributed") is satisfied by the benchmark's `addedLatencyMs` / `providerLatencyMs` columns, not by the UI. Called out in Risks.

### 5. Transcript check

New `backend/app/providers/transcript_check.py`, shaped exactly like `segmentation_checker.py` (same "orchestration logic, not a swappable vendor boundary" framing at `segmentation_checker.py:8-13`, same one-client-per-object construction, same tight explicit timeout):

```python
@dataclass
class TranscriptCheckResult:
    flagged: bool
    corrected_text: str | None
    failed: bool

class TranscriptChecker:
    def __init__(self, api_key: str, model: str = "gpt-4o-mini") -> None:
        self._client = AsyncOpenAI(api_key=api_key, timeout=httpx.Timeout(6.0, connect=3.0))
    async def check(self, text: str, language: str, mode: Literal["flag", "correct"]) -> TranscriptCheckResult: ...
```
`response_format={"type":"json_object"}`, `max_tokens=200`, returns `{"suspicious": bool, "corrected": str|null}`. Any `OpenAIError` or parse failure → `TranscriptCheckResult(flagged=False, corrected_text=None, failed=True)` — never raises (mirrors `segmentation_checker.py:72-73`).

Called in `_process_segment` (`orchestrator.py:1219-1269`) **between `_resolve_direction` (:1231-1233) and the TTS/translation kickoff (:1245)** — `segment.text` is the finished source transcript there, and the language is already resolved. Sequence:

1. `mode == "off"` → no call, no latency message, no extra fields (story AC 4.6).
2. `mode == "flag"` → run the check **without blocking translation**: fire the task, let translation start immediately, and when the verdict lands re-send `source_transcript` for that segment with `flagged: true` (AC 4.3 — non-blocking, original text used).
3. `mode == "correct"` → `await` the check, then use `result.corrected_text or segment.text` for translation; re-send `source_transcript` with the corrected `text`, `flagged: true` and `correctedFrom: <original>` (AC 4.4).
4. Either way, emit `{"type":"latency","segmentId":…,"stage":"transcript_check","ms":<cumulative since speech_end>}` — cumulative, matching every stage except `stt_final` (`sessionHandle.ts:31-43`).
5. `result.failed` → the existing non-fatal error message with `retryable: true`, original text used, session continues (AC 4.7):
   `{"type":"error","provider":"transcript_check","kind":"UNKNOWN","message":"The transcript check could not run for this segment.","retryable":true}` — routed by the existing `routeCascadeError` into a toast.

No conflict with the Step-3 gate ("a small badge on the segment, no toast"): the *flag verdict* is a badge, the *check failure* is a toast. Different events.

`LatencyStage` gains `'transcript_check'`, ordered **after `speech_end`, before `translation_first_token`** in `LATENCY_STAGES` (`latencyTracking.ts:18-25`) and in the union (`sessionHandle.ts:37-43`).

**Realtime `flag` mode** has no backend seam — the backend sees nothing after minting the token (`sessionHandle.ts:121-127`). The browser has no API key. So Realtime `flag` calls a new thin endpoint (below) from `useRealtimeSession` when a source-transcript turn settles, and renders the badge. Best-effort and non-blocking; a failure is logged to the console and dropped.

### 6. Benchmark flow

```
generate_audio_fixtures.py  (existing)  →  backend/tests/fixtures/audio/*.wav   (33 clean items)
        │
        ▼
make_noisy_corpus.py  (new)  →  noisy/*.wav + noisy_manifest.json
        │                       (clean + babble/street/fan/white × 20/10/5 dB)
        ├──────────────► run_tuning_sweep.py --config a.json [--config b.json]     [Cascade half]
        │                 uses stt_replay.transcribe_wav_detailed(..., tuning=, offline_stages=)
        │                 → tuning_sweep.json rows + paste-ready markdown table
        │
        └──────────────► realtime-quality-capture.mjs --tuning a.json               [Realtime half]
                          → captures.json (envelope + items stamped with fingerprint)
                          → run_realtime_quality_report.py → realtime_quality_report.json
```

Both halves are report-only on noisy conditions (Step 3 gate answer 2). `test_quality_wer.py`'s `WER_THRESHOLD = 0.20` stays a clean-corpus-only assertion and is not touched. Real-recording set keeps its self-skip (`run_real_audio_report.py:82-103`).

---

## API changes

### 1. `POST /api/realtime/session` (`backend/app/api/realtime.py`)

**Request** — `RealtimeSessionRequest` (`:18-26`) gains one optional nested field. Decision: **nested `tuning`, not top-level fields**, so the wire document is byte-identical to what `fingerprint()` hashes.

```jsonc
{
  "sourceLanguage": "en",
  "targetLanguage": "es",
  "tuning": {                                  // optional; absent => today's behaviour exactly
    "schemaVersion": 1,
    "mode": "realtime",
    "client": { "microphone": {...}, "rmsGate": {...}, "rnnoise": {...} },
    "realtime": {
      "model": "gpt-realtime",
      "voice": "marin",
      "turnDetection": { "type": "server_vad", "silenceDurationMs": 300, "threshold": 0.6 },
      "noiseReduction": "near_field",
      "transcriptCheck": { "mode": "flag", "model": "gpt-4o-mini" }
    }
  }
}
```

**Mapping into the OpenAI payload** (`realtime.py:144-162`):

| Tuning field | Outbound |
|---|---|
| `realtime.model` | `session.model` |
| `realtime.voice` | `session.audio.output.voice` |
| `realtime.turnDetection.type` | `session.audio.input.turn_detection.type` (always present) |
| `.threshold`, `.prefixPaddingMs`, `.silenceDurationMs` | added **only if not None and `type == "server_vad"`** → `threshold`, `prefix_padding_ms`, `silence_duration_ms` |
| `.eagerness` | added **only if not None and `type == "semantic_vad"`** → `eagerness` |
| `.interruptResponse` | added **only if not None** (valid on both types) → `interrupt_response` |
| `realtime.noiseReduction` | absent → no key; `"off"` → `"noise_reduction": null`; else `"noise_reduction": {"type": "<value>"}` |
| `client.*`, `realtime.transcriptCheck` | **not sent to OpenAI**; echoed in `appliedTuning` and included in the fingerprint |

`_turn_detection()` (`:88-98`) becomes `_turn_detection(tuning: RealtimeTuning | None)`. **When `tuning` is absent it behaves exactly as today**, reading `settings.realtime_vad_silence_ms` / `settings.realtime_vad_interrupt_response`. That keeps `test_realtime.py:127` and `:130-151` green unchanged. When `tuning` is present, the request is authoritative and `.env` is not merged in (the client already received the `.env` defaults from `/api/tuning/capabilities` and sent them back).

**Validation → 400** (explicit `HTTPException(400, detail=…)` naming the offending field, matching the language-code idiom at `:123-131`, raised **before any OpenAI call**):

| Rule | Example detail |
|---|---|
| `schemaVersion != 1` | `Unsupported tuning schemaVersion 2. This server supports 1.` |
| `model ∉ REALTIME_MODELS` | `Unsupported realtime model 'gpt-5-audio'. Supported: [...]` |
| `voice ∉ REALTIME_VOICES` | `Unsupported realtime voice 'bob'. Supported: [...]` |
| `threshold ∉ [0,1]` | `tuning.realtime.turnDetection.threshold must be between 0 and 1.` |
| `prefixPaddingMs ∉ [0,5000]`, `silenceDurationMs ∉ [0,10000]` | same shape |
| `eagerness` set while `type == "server_vad"` | `eagerness applies only to semantic_vad.` |
| `transcriptCheck.mode == "correct"` | `correct is unavailable in Realtime mode.` |
| `transcriptCheck.model ∉ TEXT_MODELS` | same shape |

A malformed *JSON type* (e.g. `"threshold": "loud"`) still yields FastAPI's default 422 from pydantic parsing. Documented, accepted — the 400s above cover every semantically-invalid-but-parseable case, which is what tooling actually sends.

**Response** — `RealtimeSessionResponse` (`:29-43`) gains two fields:

```jsonc
{
  "client_secret": "ek_…",           // existing, snake_case mirroring OpenAI's own names
  "expires_at": 1755280600,          // existing
  "model": "gpt-realtime",           // existing
  "voice": "marin",                  // existing
  "fingerprint": "cfg:7f3a9c21",     // NEW, camelCase per house style
  "appliedTuning": { …ModeTuningConfig after defaults, absent keys still absent… }  // NEW
}
```
New fields use camelCase (house style, `orchestrator.py` wire messages); the four existing snake_case fields stay as they are because they mirror OpenAI's own field names and changing them breaks `useRealtimeSession.ts:27-32`.

`appliedTuning` **preserves the absent-key idiom**: a key the request omitted is omitted from `appliedTuning` too, so `fingerprint(appliedTuning) == fingerprint(request.tuning)` and the panel can verify it.

Auth/permissions: none, as today (single-user local app). Rate limiting: none.

### 2. `GET /api/tuning/capabilities` — **new** (`backend/app/api/tuning.py`, `APIRouter(prefix="/api/tuning", tags=["tuning"])`, registered in `main.py`)

No auth, no body, no side effects. This is how the panel greys stages and shows server defaults (story AC 1.11, 5.3).

```jsonc
{
  "schemaVersion": 1,
  "defaults": { "schemaVersion":1, "client":{…}, "realtime":{…}, "cascade":{…} },  // full TuningConfig from .env + constants
  "allowLists": {
    "realtimeModels": ["gpt-realtime","gpt-realtime-mini"],
    "realtimeVoices": ["alloy","ash","ballad","coral","echo","sage","shimmer","verse","marin","cedar"],
    "deepgramModels": ["nova-3","nova-2"],
    "textModels": ["gpt-4o-mini","gpt-4.1-mini","gpt-4.1-nano"],
    "elevenLabsVoices": [{"id":"21m00Tcm4TlvDq8ikWAM","label":"Rachel (voice A default)"},
                         {"id":"ErXwobaYiN019PkySvjV","label":"Antoni (voice B default)"}],
    "turnDetectionTypes": ["server_vad","semantic_vad"],
    "eagerness": ["low","medium","high","auto"],
    "noiseReduction": ["off","near_field","far_field"]
  },
  "stages": {
    "deepfilternet": {"installed": false, "liveCapable": true,  "reason": "torch not installed — run `uv sync --extra denoise` in backend/"},
    "noisereduce":   {"installed": true,  "liveCapable": true},
    "demucs":        {"installed": false, "liveCapable": false, "reason": "benchmark-only stage; install with `uv sync --extra denoise`"},
    "dns64":         {"installed": false, "liveCapable": false, "reason": "benchmark-only stage; install with `uv sync --extra denoise`"}
  }
}
```

Detection: `importlib.util.find_spec("df")` (DeepFilterNet imports as `df`), `find_spec("noisereduce")`, `find_spec("demucs")`, `find_spec("denoiser")`. **`find_spec` only** at request time — never `init_df()`, which is slow. The "installed but weights failed to load" case (`installed: true` + `reason: "model weights unavailable — see the server log."`) is reported from a module-level `_last_init_error` populated by the first real use, which is precisely the different-hint case the wireframe §5 and copy table call for.

Status codes: `200` always. A detection exception is caught per-stage and reported as `{"installed": false, "reason": "<exception class name>"}` rather than 500ing the panel.

### 3. `POST /api/tuning/transcript-check` — **new** (tier 4, Realtime `flag` only)

Needed because the browser has no OpenAI key and the backend has no Realtime seam.

```jsonc
// request
{"text":"i went to the store yesterday","language":"en","mode":"flag","model":"gpt-4o-mini"}
// 200
{"flagged": true, "correctedText": null, "elapsedMs": 143}
```
`mode ∈ {flag, correct}`; `model ∈ TEXT_MODELS` else 400; `text` length capped at 2000 chars else 400. A provider failure returns `200 {"flagged": false, "correctedText": null, "elapsedMs": …, "failed": true}` — the caller must never break on it. No auth (as everything else).

### 4. Cascade WebSocket (`/ws/cascade`, `backend/app/orchestrator.py`)

**Client → server, `start_session` gains `tuning`** (additive; the field is optional and parsed tolerantly):

```jsonc
{"type":"start_session","languages":["en","es"],
 "tuning":{"schemaVersion":1,"mode":"cascade",
           "client":{…},
           "cascade":{"deepgram":{"model":"nova-3","endpointingMs":300,"utteranceEndMs":3000,"diarize":true},
                      "segmentation":{"mode":"llm_priority","model":"gpt-4o-mini"},
                      "denoise":{"noisereduce":{"enabled":true,"propDecrease":0.9,"stationary":false},
                                 "deepfilternet":{"enabled":false,"attenuationLimitDb":30,"postFilterBeta":0.02},
                                 "offline":{"demucs":false,"dns64":false}},
                      "transcriptCheck":{"mode":"flag","model":"gpt-4o-mini"},
                      "translationModel":"gpt-4o-mini",
                      "ttsVoiceA":"21m00Tcm4TlvDq8ikWAM","ttsVoiceB":"ErXwobaYiN019PkySvjV"}}}
```
The legacy top-level `segmentationMode` (`orchestrator.py:472`, `useCascadeSession.ts:455-461`) stays supported for the `?segMode=` dev override. When both are present, `tuning.cascade.segmentation.mode` **wins**; the override path is only used when no `tuning` is sent.

**Client → server, new:**
```jsonc
{"type":"update_tuning","requestId":"a1b2c3d4","tuning":{ …same shape as above… }}
```

**Server → client, new:**
```jsonc
{"type":"tuning_applied","requestId":"a1b2c3d4","fingerprint":"cfg:7f3a9c21","reconnectedStt":true}
{"type":"tuning_failed","requestId":"a1b2c3d4","attempt":2,"maxAttempts":3,
 "message":"The connection to the provider was lost."}
```
`tuning_applied` is also sent unsolicited immediately after `session_started` with `"requestId": null, "reconnectedStt": false`, carrying the server's fingerprint for the start-of-session config.

`message` on `tuning_failed` is drawn from the existing `_CLIENT_ERROR_MESSAGES` map (`orchestrator.py:1276-1282`) — raw provider text never reaches the browser, per that block's stated rule.

**Server → client, changed:** `source_transcript` (`orchestrator.py:938-946`, `:966-974`) gains two optional fields, only present when the transcript check produced them:
```jsonc
{"type":"source_transcript","segmentId":"…","text":"…","isFinal":true,"speaker":0,
 "flagged":true,"correctedFrom":"the text before the rewrite"}
```
`segment_boundary.trigger` gains the value `"tuning_reconnect"`. The `latency.stage` union gains `"transcript_check"`.

Validation posture is unchanged and asymmetric by design (`orchestrator.py:437-467`): **the WebSocket never 400s or closes on a bad tuning field — it falls back to the default and logs** (story AC 5.7).

### 5. Realtime `session.update` over `oai-events` — exact event shape

**Verified against the pinned SDK, not guessed:**
- `session_update_event.py:15-35` — `{"type": "session.update", "session": <RealtimeSessionCreateRequest>}`, optional `event_id`.
- `realtime_session_create_request.py:21-22` — `session.type` is a **required** `Literal["realtime"]`.
- `realtime_audio_config_input.py:30-55` — `session.audio.input.{format, noise_reduction, transcription, turn_detection}`.
- `realtime_audio_input_turn_detection.py:12-110` — `server_vad`: `threshold`, `prefix_padding_ms`, `silence_duration_ms`, `interrupt_response`, `create_response`, `idle_timeout_ms`; `semantic_vad`: `eagerness`, `interrupt_response`, `create_response`.
- `noise_reduction_type.py:7` — `Literal["near_field", "far_field"]`.
- `session_update_event.py:19` — **`voice` and `model` cannot be updated** via this event (`voice` only before any audio output).

```jsonc
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "audio": {
      "input": {
        "turn_detection": { "type": "server_vad", "silence_duration_ms": 300, "threshold": 0.6 },
        "noise_reduction": { "type": "near_field" }
      }
    }
  }
}
```
Absent-key idiom is preserved identically to the session-create path: an unset knob means the key is not in the object. `noiseReduction: "off"` sends `"noise_reduction": null`. Only fields present in the event are updated (per the SDK docstring), so the event carries only `audio.input`.

**Data-channel readiness is mandatory.** `pc.createDataChannel('oai-events')` (`useRealtimeSession.ts:230`) is receive-only today and `dataChannelRef` is read nowhere but teardown (`:155`). Add `dataChannel.onopen = () => { dcReadyRef.current = true; flushPendingTuning(); }` and never `send()` unless `readyState === 'open'`. `MockRTCDataChannel` (`frontend/src/test/mockRealtimeApis.ts:70-84`) already has `send = vi.fn()` to assert against; it needs `readyState` and a way to fire `onopen`.

### 6. `DeepgramSTTProvider` per-stream params

```python
@dataclass(frozen=True)
class DeepgramParams:
    model: str = MODEL                       # 'nova-3'          deepgram_stt.py:52
    endpointing_ms: int = ENDPOINTING_MS     # 500               :53
    utterance_end_ms: int = UTTERANCE_END_MS # 3000              :58
    diarize: bool = True                     # literal in _url() :162
    @classmethod
    def from_tuning(cls, t: CascadeTuning) -> "DeepgramParams": ...

def stream(self, audio_chunks, *, languages: tuple[str, ...],
           params: DeepgramParams | None = None) -> AsyncIterator[...]:
```
`_url(params)` takes the params instead of reading module constants. **The module-level `Final` constants stay** as the defaults — which means `test_providers.py:291-320`'s three URL-substring assertions (`diarize=true`, `language=multi`, `model=nova-3`, `utterance_end_ms=3000`, `vad_events=true`, `endpointing=500`, `interim_results=true`) **pass unchanged**. That is a deliberate design constraint, not luck. New tests cover the non-default path.

`params` is a per-call argument, never provider state — see the tenant-boundary note.

---

## Frontend changes

**The approved wireframe is `.lavish/step5-wireframe-tuning-lab.html`, with notes at `.scratch/tuning-lab/03-wireframe-notes.md`. Builders must follow its layout, section order, states and copy exactly.** Every `data-testid` comes from wireframe §8 (not re-listed here); every user-visible string comes from wireframe §7. Intentional deviations are listed under Risks and open questions — nothing else may deviate.

Everything flat in `frontend/src/pages/`, matching the existing convention (research §F: no `components/` directory; pure logic extracted from hooks with co-located `*.test.ts`).

### New files

| File | Contents |
|---|---|
| `tuningConfig.ts` **(new, PURE)** | `TuningConfig`/`ModeTuningConfig` types, `TUNING_SCHEMA_VERSION`, `DEFAULT_TUNING_CONFIG`, `KNOB_METADATA` (mode, section, connection-level flag, range, step, wire field name for the muted-mono label), `projectMode()`, `canonicalize()`, `fingerprint()`, `diff()`, `parseImported()`, `migrate()`, `clampGateParams()`, the allow-list fallbacks, `DEEPGRAM_CONNECTION_LEVEL_PATHS`. Co-located `tuningConfig.test.ts`. |
| `tuningPresets.ts` **(new, PURE)** | `BUILT_IN_PRESETS` = `Provider defaults`, `Tuned turn-taking`, `Max denoise`; localStorage read/write for `boostlingo.tuning.v1` and `boostlingo.tuning.presets.v1`; schema-version handling. Co-located test. |
| `tuningCapabilities.ts` **(new)** | `fetchCapabilities(): Promise<TuningCapabilities>` against `GET /api/tuning/capabilities`, using the `VITE_API_BASE_URL` pattern already duplicated in `cascadeConfig.ts:7-8` / `realtimeConfig.ts:5-6` (deliberately not shared — see the comment at `cascadeConfig.ts:1-4`). |
| `useTuningConfig.ts` **(new)** | The hook: `draft`, `applied` (per mode), derived `pending = diff(applied[mode], projectMode(draft, mode))`, `applyState: 'idle'\|'applying'\|'failed'` + `attempt`, persistence effect, capabilities fetch + skeleton state, apply orchestration (calls `session.applyTuning`), retry counting, dialog state, preset/export/import actions. Co-located test. |
| `TuningPanel.tsx` **(new)** | The `<aside id="tuning-panel">`: header, six `<details class="collapse collapse-arrow bg-base-200 rounded-box">` sections in wireframe §5 signal order, sticky footer, apply-failure `<dialog role="alertdialog">`. Presentational + local open/closed state only. |
| `TuningSection.tsx` **(new, optional)** | Split out the `KnobRow`/`RangeKnob`/`NumberKnob`/`SegmentedKnob`/`ProviderDefaultKnob` primitives **only if `TuningPanel.tsx` exceeds ~400 lines** (wireframe §2). |
| `rmsGate.ts` **(new, PURE)** | The unit-tested source of truth for the gate math (see below). |
| `resample.ts` **(new, PURE)** | The unit-tested source of truth for the 48k→16k decimator. |
| `public/gate-processor.js` **(new)** | One shared gate/pass-through AudioWorklet used by **both** modes. |

### Contract changes

`sessionHandle.ts:73-132` — following the documented optional-member extension pattern (already used 5×):

```ts
export type ApplyResult =
  | { ok: true;  fingerprint: string; reconnectedStt: boolean; deferred: boolean }
  | { ok: false; fingerprint: string; attempt: number; maxAttempts: number; message: string };

export interface SessionHandle {
  …
  /** Live mid-session apply. Left `undefined` by a transport that can't. */
  applyTuning?: (config: ModeTuningConfig) => Promise<ApplyResult>;
  /** `tuning` is optional so existing call sites keep compiling. */
  connect: (languages: SessionLanguages, tuning?: ModeTuningConfig) => void;
  /** The fingerprint the transport is actually running on, once confirmed by the server. */
  appliedFingerprint?: string | null;
}
```
`connect` gains a **second argument** rather than a ref, per wireframe §2 — it is called from three places in `WorkbenchPage.tsx` (mic button `:283`, error-banner Try again `:338`, and mode-switch reconnect) and all three already pass `selectedPair.languages`.

`LatencyStage` gains `'transcript_check'`; `TranscriptSegment` gains `flagged?: boolean` and `correctedFrom?: string`.

### Capture-graph changes

**Cascade** (`useCascadeSession.ts:476-504`) — the single insertion point is `micSource.connect(workletNode)` at `:492`:

```
micSource ──▶ [gateNode] ──▶ [rnnoiseNode] ──▶ workletNode ──▶ destination
     └──▶ analyser (level meter, unchanged, still taps pre-processing at :501)
```
- `new AudioContext({ sampleRate: rnnoiseEnabled ? 48000 : 16000 })` (today hardcoded 16000 at `:480`). RNNoise requires a 48 kHz context; without it the graph stays at 16 kHz exactly as today.
- When the context is 48 kHz, `cascade-pcm-processor.js` must decimate 3:1 before Int16 conversion, because the backend expects 16 kHz PCM (`deepgram_stt.py:59`, `orchestrator.py`'s frame contract). The worklet gains `processorOptions: { targetSampleRate: 16000 }` and an 8-tap FIR low-pass + 3:1 decimator, active only when `sampleRate === 48000`. The formula lives in `resample.ts` and is **hand-mirrored** into the worklet, exactly as `floatSampleToInt16` already is (`cascade-pcm-processor.js:1-15` ↔ `pcm.ts:1-14`). The header comment must say so.
- Mic-mute during playback is unchanged (`:487`) — it withholds WS frames, so the DSP graph simply sees no consumer.

**Realtime** (`useRealtimeSession.ts:181-229`) — this is genuinely new plumbing (research §4):

```
getUserMedia(constraints) ──▶ rawStream
  if (anyClientStageEnabled):
      ctx = new AudioContext({ sampleRate: 48000 })
      src = ctx.createMediaStreamSource(rawStream)
      src ──▶ [gateNode] ──▶ [rnnoiseNode] ──▶ ctx.createMediaStreamDestination()
      sentTrack = dest.stream.getAudioTracks()[0]
  else:
      sentTrack = rawStream.getTracks()[0]          // unchanged raw path
  pc.addTrack(sentTrack, streamContaining(sentTrack))
```
- **The mute logic must target the sent track.** Today `:112-113` and `:126-127` set `mediaStreamRef.current.getAudioTracks()[0].enabled`. With a processed track that mutes nothing that is being sent. Add `sentTrackRef` and mute *that*; keep `mediaStreamRef` solely for `stopMediaStream` teardown (`:158-162`). This is story AC 3.5 and the one thing most likely to silently regress feedback suppression.
- When no client stage is enabled, keep the raw track and **do not** create the DSP context — the existing behaviour and its measured latency numbers must not move for the default config.
- The level-meter AudioContext (`:193`) stays separate and unchanged.

**RNNoise package: `@sapphi-red/web-noise-suppressor`.** Chosen over `@jitsi/rnnoise-wasm` because it ships a ready-made AudioWorklet processor that handles the 480-sample/48 kHz framing internally, is TypeScript-typed, and exposes its wasm as a URL importable with Vite's `?url` suffix. `@jitsi/rnnoise-wasm` is a bare wasm binding with no worklet — you would hand-write framing, ring buffering and resampling. **Resampling plan:** run the client DSP context at 48 kHz in both modes (native for Realtime's new context; a mode switch for Cascade's, with the worklet decimating back to 16 kHz). No manual resampler is written for RNNoise itself.

**RMS gate** lives in **one** worklet, `public/gate-processor.js`, used by both graphs — `cascade-pcm-processor.js` therefore only changes for the decimator, not for the gate. Params arrive via `processorOptions` at construction and `port.postMessage({type:'gateParams', …})` for live adjust (story AC 3.3, no reconnect). Math (in `rmsGate.ts`, hand-mirrored into the worklet):

```
per 128-sample render quantum:
  rms   = sqrt(mean(x[i]^2))
  dbfs  = 20 * log10(max(rms, 1e-10))
  open  = dbfs >= thresholdDbfs
  floorGain = fullMute ? 0 : 10 ** (-attenuationDb / 20)
  on open  : ramp gain toward 1        over attackMs
  on close : after holdMs below thr,   ramp gain toward floorGain over releaseMs
boundaries: thresholdDbfs clamped to [-80, 0]; -80 is treated as "always open";
            0 is "always closed" — both are documented, neither crashes or divides by zero.
```
`clampGateParams()` clamps on the main thread; the worklet clamps again defensively (it can be sent anything).

### Page wiring (`WorkbenchPage.tsx`)

- Navbar `navbar-end` gains the `Tuning` toggle **before** the connection badge (wireframe §1), with `aria-expanded` / `aria-controls="tuning-panel"`, the `{n} pending` badge and the fingerprint chip.
- Layout: while the panel is open the transcript grid drops from `sm:grid-cols-2` to one column (`:364`); the main column becomes `flex-1 min-w-0` (the `min-w-0` matters — without it the latency strip's `overflow-x-auto` won't shrink).
- Fingerprint reaches the latency strip as a **plain prop from `WorkbenchPage`**, not through `SessionHandle` and not on `CascadeSegmentLatency` (wireframe §2: it is UI metadata about the applied config, not a per-segment measurement). Rendered as a **sibling** of the existing badge content, with its own `data-testid="tuning-fingerprint-latency"` — deliberately not inside `realtime-latency-badge`, whose text the capture harness regexes with `/(\d+)\s*ms/` (`realtime-quality-capture.mjs:183-190`).
- `TranscriptPaneBody` (`:118-160`) renders the flag badge next to the existing trigger annotation (`:136-138`): `<span data-testid="segment-suspicious-badge" className="badge badge-warning badge-soft badge-xs" title="Transcript check flagged this segment as likely misrecognised">⚑ check</span>`. Badge only, **no toast** (Step 3 gate answer 3).
- Mode switch already tears the session down (`handleModeChange`, `:268-277`). The panel **stays open**, re-renders with the new mode's sections, and the pending badge counts the current mode only (Step 5 gate outcome 1). Nothing is discarded.

### States

| State | Treatment |
|---|---|
| Loading | Panel renders a `skeleton` section stack until `/api/tuning/capabilities` resolves (wireframe §3 rule 5). |
| Capabilities fetch failed | Fall back to `DEFAULT_TUNING_CONFIG`; every server-side denoise row renders in the `not installed` variant. |
| Empty | Not applicable — the panel always has values (server defaults or stored). |
| Pending | Three layers per wireframe §5: amber inset left rule, amber dot before the control, `was: <previous applied value>` badge. Connection-level rows also carry a `reconnects` ghost chip. |
| Applying | `Applying…` + `loading loading-spinner loading-xs`, button disabled; connection badge switches to the **existing** `CONNECTION_BADGE.reconnecting` (`WorkbenchPage.tsx:36`) — deliberate reuse, this reads to the user exactly like an unexpected WS drop. |
| Deferred | Status line `Applying after the current reply…`. |
| Success | `Applied · cfg:7f3a9c21 · 12:04:31` (browser-local clock, display-only), pending markers cleared. |
| Failed | After the retry budget: the `role="alertdialog" aria-modal="true"` modal (wireframe §6) with `Revert to previous` / `Retry`, no dismiss-by-backdrop. |
| Disabled (torch missing) | Row at 60 % opacity, genuinely `disabled`, `badge badge-warning badge-soft badge-xs` = `not installed`, plus visible hint text (never `title` alone — wireframe §9). |
| Disabled (offline-only) | `badge badge-neutral badge-xs` = `benchmark only`, one shared explanatory line. |

Copy strings: wireframe §7, verbatim. Accessibility: wireframe §9, in full (native `<details>`, real radio inputs in `role="radiogroup"`, `role="status" aria-live="polite"` footer, focus trap + restore on the dialog, Escape closes the panel and returns focus to the toggle, opening the panel does **not** steal focus).

---

## Tests required

Every entry names the acceptance criterion it covers. Existing tests that must be touched are called out inline.

### Success

| # | What is verified | Level | AC |
|---|---|---|---|
| S1 | `fingerprint()` in TS and in Python produce identical strings for every case in `shared/tuning-fingerprint-cases.json`; two configs differing only in key order hash identically | unit ×2 (Vitest + pytest) | 1.12 |
| S2 | `canonicalize()` omits absent keys, keeps `false`/`0`/`""`, sorts keys, emits integral floats without a decimal point | unit (both) | 1.12 |
| S3 | Panel shows a section per processing step for the active mode and every knob in locked decision 5 appears | component (`TuningPanel.test.tsx`) | 1.1 |
| S4 | `POST /api/realtime/session` with `tuning.turnDetection.silenceDurationMs = 300` puts it under `session.audio.input.turn_detection` in the outbound payload | integration (extends `test_realtime.py`) | 1.2 |
| S5 | `noiseReduction: "near_field"` → `session.audio.input.noise_reduction == {"type":"near_field"}`; `"off"` → `null` | integration | 3.6 |
| S6 | `start_session` carrying `tuning.cascade.deepgram.endpointingMs = 300` and `segmentation.mode = "llm_priority"` builds the Deepgram URL with `endpointing=300` and honours llm-priority | integration (`test_orchestrator.py`, fake STT + fake `websockets.connect` capturing the URL) | 1.4 |
| S7 | `applyTuning` on a connected Realtime session sends exactly one `session.update` with the GA shape on `oai-events` and does **not** tear the session down | unit (`useRealtimeSession.test.ts`, asserts `MockRTCDataChannel.send`) | 1.5 |
| S8 | A non-connection-level `update_tuning` replies `tuning_applied{reconnectedStt:false}` and does **not** reopen Deepgram | integration | 1.6 |
| S9 | **`update_tuning` reconnect keeps frames**: send frames A,B → `update_tuning` (connection-level) → frames C,D; assert the first Deepgram connection received A,B, the second received C,D, none were dropped or duplicated, and the second URL carries the new params | integration (`test_orchestrator.py`, two fake sockets) | 1.7 |
| S10 | Config survives reload (localStorage round trip) and nothing is written server-side | unit (`useTuningConfig.test.ts`) | 1.8 |
| S11 | Selecting each built-in preset sets every knob in one action; a user preset survives a simulated reload | unit | 1.9 |
| S12 | Export → import round-trips to an identical config and an identical fingerprint | unit | 1.10 |
| S13 | With no stored config, the panel displays the values from `/api/tuning/capabilities` `defaults`, not blanks | component (mocked fetch) | 1.11 |
| S14 | Switching tabs shows only that mode's knobs and copies no values across | component | 1.13 |
| S15 | `make_noisy_corpus.py` produces the expected file set, all mono/16-bit/16 kHz, and the measured SNR of each output is within ±0.5 dB of its label (**SNR maths**) | unit (`test_noisy_corpus.py`, synthetic 1 s tone, no real corpus needed) | 2.1 |
| S16 | `run_tuning_sweep.py` emits one row per (item, condition, SNR) with the fingerprint, and re-running with the same `--out` skips already-present rows | unit (fake `transcribe_wav_detailed`) | 2.2 |
| S17 | `--tuning` makes the capture harness import the config before Connect and stamp `fingerprint` on the envelope and every item | e2e smoke (Playwright, no live keys: asserts the import + chip text only) | 2.3 |
| S18 | `run_realtime_quality_report.py` carries the fingerprint through `_identity()`, the summary and the printed COMPARISON row | unit | 2.4 |
| S19 | Every sweep run includes a `condition: "clean", snrDb: null` row per item | unit | 2.5 |
| S20 | The sweep prints one paste-ready markdown row per fingerprint | unit (captured stdout) | 2.6 |
| S21 | `getUserMedia` is called with exactly the panel's EC/NS/AGC values, not hardcoded `true`s, in both modes | unit (`useCascadeSession.test.ts`, `useRealtimeSession.test.ts` — `installMockGetUserMedia`) | 3.1 |
| S22 | **Gate math**: below-threshold input is attenuated by exactly `attenuationDb`; above-threshold passes at unity; `fullMute` silences | unit (`rmsGate.test.ts`) | 3.2 |
| S23 | **Worklet param message**: changing the threshold on a connected session posts `{type:'gateParams', …}` to the gate worklet's port and does not reconnect | unit (`FakeAudioWorkletNode` gains `port.postMessage`) | 3.3 |
| S24 | With any client stage enabled in Realtime, `pc.addTrack` receives the `MediaStreamAudioDestinationNode` track, and mute targets **that** track | unit (`useRealtimeSession.test.ts`) | 3.5 |
| S25 | Cascade offers `off/flag/correct`; Realtime offers only `off/flag` with `correct` rendered disabled | component | 4.1, 4.2 |
| S26 | `correct` mode: the rewritten text is what reaches `translation_provider.translate`, the re-sent `source_transcript` carries it plus `correctedFrom`, and a `transcript_check` latency message is emitted | integration (fake `TranscriptChecker`) | 4.4 |
| S27 | `flag` mode: translation starts with the original text without awaiting the check; the segment gets `flagged: true` and renders `segment-suspicious-badge` | integration + component | 4.3 |
| S28 | DeepFilterNet selected → every mic frame passes through `DeepFilterNetStage.process` before Deepgram | integration (fake stage asserting call count == frame count) | 5.2 |
| S29 | With the extra installed (`find_spec` monkeypatched to a spec), capabilities reports `installed: true` and the panel enables the row | integration + component | 5.3 |
| S30 | Demucs/DNS rows are always disabled and tagged `benchmark only`, but a config file naming them is honoured by `run_tuning_sweep.py` | component + unit | 5.4 |
| S31 | Every model/voice picker renders a fixed list with no free-text input | component | 5.6 |

### Failure

| # | What is verified | Level | AC |
|---|---|---|---|
| F1 | Model/voice outside the allow-list on `POST /api/realtime/session` → 400 naming the field, **before any OpenAI call** | integration | 5.7 |
| F2 | Out-of-range `threshold`/`prefixPaddingMs`/`silenceDurationMs` → 400 | integration | 5.7 |
| F3 | `eagerness` sent with `server_vad`, or `transcriptCheck.mode: "correct"` in Realtime → 400 | integration | 5.7 |
| F4 | An out-of-allow-list model in a Cascade `start_session`/`update_tuning` **falls back to the default and logs**, session survives | integration | 5.7 |
| F5 | `schemaVersion: 2` → 400 (HTTP) / default fallback + warning (WS) | integration ×2 | — |
| F6 | Deepgram reconnect failing N times emits one `tuning_failed` per attempt with `attempt`/`maxAttempts`, logs each, then **reverts to the previous params** and the session keeps running | integration | Step 3 gate |
| F7 | After `maxAttempts`, the client opens `tuning-apply-failed-dialog`; `Retry` re-sends, `Revert to previous` sets `draft = applied` | unit (`useTuningConfig.test.ts`) + component | Step 3 gate |
| F8 | Transcript-check provider failure → original text translated, session continues, one `retryable: true` toast, no `transcript_check` correction applied | integration | 4.7 |
| F9 | `mode: "off"` makes **zero** transcript-check calls and emits no `transcript_check` latency stage | integration | 4.6 |
| F10 | Malformed JSON on import → inline `That file isn't a valid tuning config.`, draft untouched | unit | wireframe §4 |
| F11 | Valid JSON with unknown keys → known keys imported, `Imported. Ignored {n} unknown field(s): {names}.` warning | unit | wireframe §4 |
| F12 | A retired model id in a stored/imported config → falls back to the picker's default with `{model} is no longer available — using {default}.` | unit | edge case |
| F13 | Capabilities fetch failure → panel falls back to `DEFAULT_TUNING_CONFIG` and shows all server denoise rows as `not installed` | component | wireframe §3.5 |
| F14 | `find_spec` returning `None` → `stages.deepfilternet.installed == false` with the `uv sync --extra denoise` reason; row `disabled` and unselectable | integration + component | 5.3 |
| F15 | Torch installed but `init_df()` raises → `installed: true` with `reason: "model weights unavailable…"`, and the stage degrades to no-op mid-session rather than killing it | unit | edge case |
| F16 | A missing corpus WAV → per-item skip with the printed `ffmpeg` conversion command, run exits 0 | unit | 2.8, edge case |
| F17 | No real-recording manifest → friendly message, exit 0 | unit | 2.8 |

### Edge cases

| # | What is verified | Level | Source |
|---|---|---|---|
| E1 | Apply during Cascade TTS playback is accepted, queued, and fires once playback clears — nothing is sent while `isPlaybackActiveRef` is true | unit (`useCascadeSession.test.ts`) | Step 5 gate 2 |
| E2 | Apply during a streaming Realtime reply is queued and fires after `response.done` + `REALTIME_MUTE_TAIL_MS` | unit | Step 5 gate 2 |
| E3 | Apply while the data channel is `connecting` is queued and flushed by `onopen` | unit | research §5 |
| E4 | **Two connection-level Applies 200 ms apart produce exactly one Deepgram reconnect, using the later config** | integration + unit | edge case |
| E5 | Apply while disconnected commits `draft → applied`, stamps a new fingerprint, persists, clears pending — and the next `connect()` uses it | unit | wireframe §4 |
| E6 | A partial segment in flight at reconnect time is cut with `trigger: "tuning_reconnect"` and appears in the transcript; nothing is double-cut | integration | 1.7 |
| E7 | Gate at `thresholdDbfs = 0` and `= -80` neither crashes the worklet nor produces a silence-only transcript | unit (`rmsGate.test.ts`) | edge case |
| E8 | `attenuationDb = 0` is a no-op; `fullMute` overrides `attenuationDb` | unit | 3.2 |
| E9 | RNNoise enabled in Cascade: the 48 k context + 3:1 decimator still yields 960-byte/30 ms frames, and `resample.ts`'s output matches the worklet's | unit (`resample.test.ts` + worklet-parity assertion) | 3.4, edge case |
| E10 | RNNoise clean-baseline row exists in the sweep so a 16→48→16 round-trip regression is visible | unit (sweep row presence) | edge case |
| E11 | A `schemaVersion` bump changes every fingerprint (the version is inside the hash) — asserted by hashing the same knobs at v1 and a fabricated v2 | unit | edge case |
| E12 | Sweep above `_MAX_ROWS_WITHOUT_CONFIRM` refuses without `--limit`/`--yes` and prints an estimated wall-clock | unit | edge case |
| E13 | "Max denoise" preset (every stage on) produces a valid config, a distinct fingerprint, and does not error the live path | unit + integration | edge case |
| E14 | Real-recording manifest present but every file missing → zero-result report, exit 0 | unit | edge case |
| E15 | Playwright origin `http://localhost:5183` is accepted by the WS origin guard | integration (`test_orchestrator.py` origin test) | edge case |
| E16 | Unknown `update_tuning` fields are ignored; an unknown server message type is warned-and-ignored client-side | integration + unit | research §7 |

### Existing tests and fakes that must change

| File | Change |
|---|---|
| `backend/tests/test_realtime.py:127` and `:130-151` | **No change required** — `_turn_detection(None)` preserves today's `.env`-driven behaviour exactly. Verify green before adding new cases. |
| `backend/tests/test_providers.py:291-320` | **No change required** — `DeepgramParams` defaults to the existing module constants, so every URL substring assertion still holds. This is a design constraint; if a builder breaks it, they have made the wrong change. |
| `backend/tests/conftest.py` | Add a second autouse fixture stubbing `orchestrator.TranscriptChecker`, matching the existing `SegmentationChecker` stub, so legacy orchestrator tests never hit OpenAI. |
| `frontend/src/test/mockCascadeApis.ts` | `FakeAudioContext` gains `createMediaStreamDestination()`, `sampleRate` honouring the constructor option, and gain/biquad node stubs; `FakeAudioWorkletNode` gains `processorOptions` capture and a two-way `port` with `postMessage`. |
| `frontend/src/test/mockRealtimeApis.ts` | `MockRTCDataChannel` gains `readyState` and an `emitOpen()`; `MockRTCPeerConnection` records `addTrack` arguments so S24 can assert which track was sent. |
| `frontend/src/pages/useCascadeSession.test.ts` | Existing cases unaffected (`connect`'s second arg is optional); new cases for `start_session.tuning`, `update_tuning`, queued/coalesced apply. |
| `frontend/src/pages/WorkbenchPage.test.tsx` | Existing role/testid queries unaffected; new cases for the toggle, the pending badge, the fingerprint chips, and the flag badge. |
| `frontend/e2e/realtime-quality-capture.mjs` | `--tuning` added to the arg parser (`:310-327`); harness must still pass `assertServersUp()` (`:278-308`), which probes with `sourceLanguage: 'zz'` and expects the 400 — **the new `tuning` validation must not change that error's text or precedence** (language validation runs first, `realtime.py:123-131`). |

---

## Risks and open questions

### New third-party dependencies (one bullet each, as required)

- **`torch` (backend, optional extra `denoise`).** Large (~200 MB+ CPU wheel) and the only reason for an extras group. Existing infrastructure will not do: DeepFilterNet has no non-torch runtime. Mitigation: `[project.optional-dependencies] denoise = ["torch>=2.4", "deepfilternet>=0.5.6"]`, CPU wheel index pinned via a `[[tool.uv.index]]` entry (`https://download.pytorch.org/whl/cpu`) plus `[tool.uv.sources] torch = {index = "pytorch-cpu"}`; installed with `uv sync --extra denoise`. Core CI runs plain `uv sync` and stays torch-free. This is the **first** `[project.optional-dependencies]` section in `backend/pyproject.toml` (research §E).
- **`deepfilternet` (backend, optional extra `denoise`).** Downloads model weights on first `init_df()`. Distinct failure mode from "not installed" — hence the separate `reason` string and the F15 test.
- **`noisereduce` + `numpy` (backend, optional extra `bench`).** **Decision: `bench`, not main deps.** `noisereduce` pulls `scipy`/`numba` on some versions, which is not "light". Consequence, stated plainly: in a default install `noisereduce` is *also* a `not installed` stage in the panel. That is consistent with the capability-discovery design and keeps `uv sync` fast. `soundfile` is **not** needed — `make_noisy_corpus.py` uses the stdlib `wave` module, matching `stt_replay.py:73-103` and `realtime-quality-capture.mjs`'s hand-written WAV header (`:219-269`).
- **`@sapphi-red/web-noise-suppressor` (frontend, runtime dependency).** First runtime dependency added since React. Chosen over `@jitsi/rnnoise-wasm` because it ships a working AudioWorklet with the 48 kHz/480-sample framing already handled; the Jitsi package would mean hand-writing framing, ring buffering and resampling in a worklet realm that can't import TS. Vite handling: import the wasm and the worklet with `?url` so both are emitted as assets; `.wasm` needs no `assetsInclude` entry. Verify the `?url`-loaded worklet resolves under both `vite dev` and `vite build` **before** building on it.
- **No new scheduler, no new database, no new datastore.** The Deepgram reconnect reuses `_run_stt`'s existing outer retry loop and `_resilience.with_reconnect`'s 3-attempt/0.5-1-2 s budget (`orchestrator.py:842-853`, `_resilience.py:66-93`). The apply queue is one ref slot, not a queue library. Persistence is localStorage only.

### Intentional deviations from the approved artifacts (flagged, not silently taken)

1. **`transcriptCheck` lives per mode, not in the shared block.** Wireframe §3 rule 2 lists `transcriptCheck.mode` as shared. But Cascade allows `off/flag/correct` and Realtime only `off/flag`, so a shared field cannot be type-exact and would let a Cascade `correct` leak into a Realtime fingerprint. Placed in `realtime` and `cascade` respectively. **User decision needed if this is unwanted.**
2. **The RMS gate is a separate `gate-processor.js` worklet shared by both modes**, rather than being built into `cascade-pcm-processor.js` as the task brief suggested. One gate implementation instead of two, and it works unchanged in Realtime's graph. `cascade-pcm-processor.js` changes only to add the 48 k decimator.
3. **`shared/tuning-fingerprint-cases.json` introduces a new top-level directory** (one file). Justified: a cross-language hash-parity fixture that isn't literally the same bytes on both sides proves nothing. The alternative — duplicating the fixture — is the failure mode the test exists to catch.
4. **Realtime `flag` mode requires a new `POST /api/tuning/transcript-check` endpoint.** Not anticipated in the story, but unavoidable: the backend has zero visibility into a Realtime session and the browser has no API key.
5. **`segment_boundary.trigger` gains a new value `"tuning_reconnect"`.** Additive-safe (unknown triggers already pass through `segmentation.ts:47-49`), but it is a wire-contract addition.

### Sharp edges

- **The single biggest hazard: per-session vs module-global Deepgram params.** `deepgram_stt.py:52-59` are module-level `Final` constants today. Implementing live-apply by mutating them would silently re-parameterise every concurrent session. `DeepgramParams` must be a per-`stream()` argument. Called out again here because it is the one thing that would look like it works in a single-tab test and be wrong.
- **The `_RECONNECT` sentinel must never be raced against `audio_queue.get()`.** The obvious implementation — `asyncio.wait({queue.get(), event.wait()})` — can drop an item when the losing `get()` task is cancelled after a `put_nowait` has already handed it one. The sentinel-in-the-queue design is deliberate and is what makes "no frame is lost" true. Do not "simplify" it.
- **Audio accumulates in `audio_queue` during a reconnect.** Unbounded queue, ~32 KB/s, bounded in practice by the reconnect duration (≤3.5 s worst case with the full backoff budget). Acceptable; not fixed here. If the reverted reconnect also fails, the existing terminal path drains it.
- **`NoisereduceStage` re-processes a 480 ms window per 30 ms frame.** That is 16× redundant work per frame; on a slow CPU it can fall behind real time and back up `audio_queue`. Tier 2 measures it (`addedLatencyMs`); if the number is bad, the honest answer is to mark the stage benchmark-only rather than to optimise it in this slice.
- **No live per-frame denoise latency readout.** AC 2.7 is satisfied by the benchmark's `addedLatencyMs`/`providerLatencyMs` columns, not by the UI. Only `transcript_check` gets a live per-segment latency stage, because only it is per-segment.
- **RNNoise's 16 k → 48 k → 16 k round trip in Cascade may itself hurt WER**, independent of any denoising benefit. The clean-baseline row (AC 2.5) is the guard, and E9/E10 are the tests. This is the most likely place for a surprising negative result — which is the point of the feature.
- **Sweep runtime.** `stt_replay.py` paces with real `asyncio.sleep` (`:100`) so a sweep runs in roughly real time; the Realtime half needs one browser launch per clip (`realtime-quality-capture.mjs:129`, a hard Chromium constraint). 33 items × 4 conditions × 3 SNRs × 2 configs ≈ 792 rows ≈ hours. Hence the `_MAX_ROWS_WITHOUT_CONFIRM = 200` cap, `--limit`, `--only`, `--conditions`, `--snr`, and resume-by-skipping-existing-rows.
- **Playwright origin 5183 vs `cors_origins` default 5173** (research §9, `playwright.config.ts:26-31` vs `config.py:19`). **Decision: add `http://localhost:5183` to the `cors_origins` default.** The guard's purpose — blocking arbitrary third-party pages from opening sessions against real keys — is unaffected, because 5183 is a repo-owned dev port. Documented in `.env.example`. Flagging it anyway because it is a security-relevant default being widened.
- **Migration/ordering.** The uncommitted `_turn_detection()` / `realtime_vad_*` work (`git status`: `M backend/app/api/realtime.py`, `M backend/app/config.py`, `M backend/tests/test_realtime.py`) must be **absorbed, not reverted** (story assumption 5). Build on top of it; do not rebase it away. There is no data migration — localStorage is versioned and discarded on mismatch, and no backfill exists because nothing is persisted server-side.
- **Wave-U-Net** is absent from the panel entirely, per story AC 5.5 — no placeholder, no new decision.

### Open questions (each answerable in one sentence)

1. **`bench` extras vs main deps:** the brief asked for a decision and I chose `bench` (so `noisereduce` shows as *not installed* in a default install). If you would rather `noisereduce` + `numpy` always work out of the box, say so and they move to `[project].dependencies`.
2. **`transcriptCheck` per-mode vs shared** (deviation 1 above) — confirm or override.
3. **`ELEVENLABS_VOICES` beyond the two `.env` defaults:** should the picker offer a curated list of other premade ElevenLabs voice ids, or only the two the server is configured with plus a new `ELEVENLABS_VOICE_IDS_EXTRA` env list (what I've specified)?
4. **Widening `cors_origins` to include 5183 by default** — confirm, or would you rather the harness set `CORS_ORIGINS` in its environment?
5. **Realtime `flag` mode's extra round trip** through `POST /api/tuning/transcript-check`: acceptable, or should Realtime `flag` be dropped from tier 4 as well?

### Out of scope (from the story, restated so builders don't drift)

Server-side or account-based preset storage; any GPU requirement; Demucs / DNS64 / Wave-U-Net in the live path; `correct` transcript-check mode in Realtime; a per-device mic calibration wizard; new language pairs (EN↔ES, EN↔FR only); supplying the real noisy recording set; auto-generating `COMPARISON.md` prose; multi-user concerns, authentication, or per-user config isolation.

### Assumptions

1. Wire key names are camelCase, Python snake_case, bridged by pydantic alias — as everywhere else.
2. Apply is an explicit action, never auto-apply on keystroke.
3. The uncommitted `_turn_detection()` work is absorbed, and the panel supersedes `realtime_vad_*` as the primary source while they remain the server defaults.
4. Generated noisy audio is git-ignored; the script and SCRIPT.md are committed.
5. Live keys may be absent in the build environment; every key-gated test self-skips with a message naming the exact env var (`AGENTS.md:91-105`).

---

## Files that will change

### Backend

| Path | Change |
|---|---|
| `backend/app/tuning/__init__.py` | **(new)** package marker |
| `backend/app/tuning/schema.py` | **(new)** pydantic mirror of `TuningConfig`/`ModeTuningConfig` with camelCase aliases |
| `backend/app/tuning/fingerprint.py` | **(new)** `canonicalize()` + `fingerprint()`, the Python half of the parity contract |
| `backend/app/tuning/allowlists.py` | **(new)** `REALTIME_MODELS`, `REALTIME_VOICES`, `DEEPGRAM_MODELS`, `TEXT_MODELS`, `elevenlabs_voices()`, `DEEPGRAM_CONNECTION_LEVEL_FIELDS` |
| `backend/app/tuning/defaults.py` | **(new)** builds the effective `TuningConfig` from `settings` + provider constants |
| `backend/app/api/tuning.py` | **(new)** `GET /api/tuning/capabilities`, `POST /api/tuning/transcript-check` |
| `backend/app/api/realtime.py` | `RealtimeSessionRequest` gains `tuning`; `_turn_detection(tuning)`; noise-reduction mapping; allow-list/range 400s; response gains `fingerprint` + `appliedTuning` |
| `backend/app/main.py` | register the new `tuning` router |
| `backend/app/config.py` | `cors_origins` default gains `http://localhost:5183`; new optional `elevenlabs_voice_ids_extra: list[str] = []` |
| `backend/app/orchestrator.py` | `_SessionTuning`; `_parse_cascade_tuning`; `update_tuning` branch in `_pump_client_messages`; `_RECONNECT` sentinel in `audio_iter`; reconnect + revert in `_run_stt`'s `StopAsyncIteration` / `ProviderError` branches; denoise chain in `audio_iter`; transcript check in `_process_segment`; `tuning_applied`/`tuning_failed`; `flagged`/`correctedFrom` on `source_transcript`; `transcript_check` latency stage; `tuning_reconnect` trigger |
| `backend/app/providers/deepgram_stt.py` | `DeepgramParams` dataclass (defaults = today's constants); `stream(..., params=)`; `_url(params)` |
| `backend/app/providers/denoise.py` | **(new)** `DenoiseStage` protocol, `NoopStage`, `NoisereduceStage`, `DeepFilterNetStage`, `build_denoise_chain()`, `find_spec`-based detection + `_last_init_error` |
| `backend/app/providers/transcript_check.py` | **(new)** `TranscriptChecker`, `TranscriptCheckResult` |
| `backend/pyproject.toml` | first `[project.optional-dependencies]`: `denoise`, `bench`; `[[tool.uv.index]]` + `[tool.uv.sources]` for the CPU torch wheel |
| `backend/.env.example` | document `CORS_ORIGINS` and `ELEVENLABS_VOICE_IDS_EXTRA` |
| `backend/tests/fixtures/make_noisy_corpus.py` | **(new)** babble/street/fan/white synthesis, RMS-matched SNR mixing, manifest writer |
| `backend/tests/fixtures/noisy/SCRIPT.md` | **(new)** how to regenerate, what each condition is, why the audio isn't committed |
| `backend/tests/fixtures/stt_replay.py` | add `transcribe_wav_detailed(..., tuning=, offline_stages=) -> ReplayResult`; `transcribe_wav` delegates and keeps returning `str` so existing callers are untouched |
| `backend/tests/fixtures/run_tuning_sweep.py` | **(new)** the sweep runner, resume, cap, paste-ready table |
| `backend/tests/fixtures/run_realtime_quality_report.py` | `_identity()` (:171-179) + summary (:136-148) + printed row (:164-168) gain the fingerprint |
| `backend/tests/conftest.py` | second autouse fixture stubbing `TranscriptChecker` |
| `backend/tests/test_tuning_config.py` | **(new)** fingerprint parity + canonicalisation |
| `backend/tests/test_tuning_api.py` | **(new)** capabilities + transcript-check endpoints |
| `backend/tests/test_denoise.py` | **(new)** chain construction, detection, weights-failure degradation |
| `backend/tests/test_transcript_check.py` | **(new)** modes off/flag/correct, failure safety |
| `backend/tests/test_noisy_corpus.py` | **(new)** SNR maths, output format |
| `backend/tests/test_realtime.py` | new cases (existing ones unchanged) |
| `backend/tests/test_orchestrator.py` | new cases: `start_session.tuning`, `update_tuning`, frame-preserving reconnect, coalescing, revert, 5183 origin |
| `backend/tests/test_providers.py` | new cases for non-default `DeepgramParams` (:291-320 unchanged) |

### Frontend

| Path | Change |
|---|---|
| `frontend/src/pages/tuningConfig.ts` (+`.test.ts`) | **(new)** schema, defaults, `KNOB_METADATA`, canonicalize/fingerprint/diff/parseImported/migrate/clamp |
| `frontend/src/pages/tuningPresets.ts` (+`.test.ts`) | **(new)** built-in presets + localStorage |
| `frontend/src/pages/tuningCapabilities.ts` | **(new)** capabilities fetch |
| `frontend/src/pages/useTuningConfig.ts` (+`.test.ts`) | **(new)** draft/applied/pending, apply orchestration, retry + dialog state |
| `frontend/src/pages/TuningPanel.tsx` (+`.test.tsx`) | **(new)** the panel per wireframe §5–§7 |
| `frontend/src/pages/TuningSection.tsx` | **(new, conditional)** knob primitives, only if the panel exceeds ~400 lines |
| `frontend/src/pages/rmsGate.ts` (+`.test.ts`) | **(new)** gate math, source of truth for the worklet |
| `frontend/src/pages/resample.ts` (+`.test.ts`) | **(new)** 48 k→16 k decimator, source of truth for the worklet |
| `frontend/public/gate-processor.js` | **(new)** shared gate worklet with `processorOptions` + `port.onmessage` |
| `frontend/public/cascade-pcm-processor.js` | add the 3:1 decimator gated on `sampleRate === 48000`, driven by `processorOptions.targetSampleRate`; header comment gains the `resample.ts` hand-sync note |
| `frontend/src/pages/sessionHandle.ts` | `applyTuning?`, `connect(languages, tuning?)`, `appliedFingerprint?`, `'transcript_check'` in `LatencyStage`, `flagged`/`correctedFrom` on `TranscriptSegment` |
| `frontend/src/pages/useCascadeSession.ts` | constraints from tuning (:425-428); `tuning` in `start_session` (:456-462); gate/RNNoise nodes at :492; 48 k context switch (:480); `applyTuning` with queue + coalescing; `update_tuning`/`tuning_applied`/`tuning_failed` handling; `flagged`/`correctedFrom` plumbing |
| `frontend/src/pages/useRealtimeSession.ts` | constraints from tuning (:181-184); DSP graph + `sentTrackRef`; mute targets the sent track (:112-113, :126-127); `dataChannel.onopen` + `applyTuning` sending `session.update`; `tuning` in the session POST body (:206) |
| `frontend/src/pages/WorkbenchPage.tsx` | navbar Tuning toggle + pending badge + fingerprint chip; panel render + single-column grid while open; fingerprint prop into both latency components; flag badge in `TranscriptPaneBody` (:136-138); `connect(..., appliedForMode)` at all three call sites |
| `frontend/src/pages/latencyTracking.ts` | `'transcript_check'` in `LATENCY_STAGES` (:18-25) |
| `frontend/src/pages/segmentation.ts` | `'tuning_reconnect' → 'reconfig'` in `segmentTriggerLabel` (:47-49) |
| `frontend/src/test/mockCascadeApis.ts` | `createMediaStreamDestination`, constructor `sampleRate`, gain nodes, `processorOptions`, two-way worklet port |
| `frontend/src/test/mockRealtimeApis.ts` | `MockRTCDataChannel.readyState` + `emitOpen()`; `addTrack` argument capture |
| `frontend/src/pages/useCascadeSession.test.ts` | new cases (existing unaffected) |
| `frontend/src/pages/useRealtimeSession.test.ts` | new cases |
| `frontend/src/pages/WorkbenchPage.test.tsx` | new cases |
| `frontend/e2e/realtime-quality-capture.mjs` | `--tuning` arg (:310-327); panel import before Connect; `fingerprint` on the envelope (:271-276) and every item |
| `frontend/package.json` | `@sapphi-red/web-noise-suppressor` in `dependencies` |

### Repo root

| Path | Change |
|---|---|
| `shared/tuning-fingerprint-cases.json` | **(new)** the cross-language hash-parity fixture |
| `.gitignore` | `backend/tests/fixtures/noisy/*.wav`, `noisy_manifest.json`, `tuning_sweep*.json` |
| `COMPARISON.md` | new **§7 Tuning-config comparisons** section skeleton: one table (`fingerprint / mode / condition / SNR / WER / corrected WER / judge acceptance / added latency / provider latency`), a "what each fingerprint is" list, and the exact reproduce commands — following the existing per-table provenance convention (`:106-110`) |
| `README.md` | document `uv sync --extra denoise`, `--extra bench`, and the two new harness commands |

---

Relevant absolute paths I verified against: `f:\Users\rubas\Documents\Gauntlet_AI\boostlingo_v2\backend\app\api\realtime.py`, `backend\app\orchestrator.py`, `backend\app\providers\deepgram_stt.py`, `backend\app\providers\segmentation_checker.py`, `backend\app\config.py`, `backend\app\languages.py`, `backend\tests\fixtures\stt_replay.py`, `backend\tests\fixtures\run_realtime_quality_report.py`, `backend\tests\test_realtime.py`, `backend\tests\test_providers.py`, `backend\pyproject.toml`, `frontend\src\pages\sessionHandle.ts`, `frontend\src\pages\useCascadeSession.ts`, `frontend\src\pages\useRealtimeSession.ts`, `frontend\src\pages\WorkbenchPage.tsx`, `frontend\src\pages\latencyTracking.ts`, `frontend\src\pages\transcriptPane.ts`, `frontend\public\cascade-pcm-processor.js`, `frontend\e2e\realtime-quality-capture.mjs`, `frontend\package.json`, `.gitignore`, `AGENTS.md`, and the pinned SDK types under `backend\.venv\Lib\site-packages\openai\types\realtime\`.

---

## Step 7 gate outcome (2026-08-15): APPROVED

Brief approved as drafted. The five open questions are decided per the recommendations:
1. `noisereduce` + `numpy` stay in the `bench` extra (not main deps); default install shows the stage as "not installed" with the `uv sync --extra bench` hint.
2. `transcriptCheck` is per mode (`realtime.transcriptCheck.mode ∈ {off,flag}`, `cascade.transcriptCheck.mode ∈ {off,flag,correct}`) — deviation 1 confirmed.
3. ElevenLabs voice picker = the two configured voices + `ELEVENLABS_VOICE_IDS_EXTRA` (env list); no hard-coded premade list.
4. `cors_origins` default gains `http://localhost:5183`; documented in `.env.example`.
5. Realtime `flag` mode stays in tier 4, implemented via `POST /api/tuning/transcript-check` (best-effort, non-blocking).
