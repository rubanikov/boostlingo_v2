"""Pydantic mirror of the shared `TuningConfig` document.

The TypeScript source of truth is `frontend/src/pages/tuningConfig.ts`; this
module is the byte-compatible server-side twin. Wire keys are camelCase and
Python attributes snake_case, bridged by `alias` + `populate_by_name`, exactly
as `app.api.realtime.RealtimeSessionRequest` already does. `extra="ignore"`
keeps a newer client's unknown keys from 422-ing an older server.

Two conventions worth knowing before adding a field:

* **Absent means "provider default".** Only the fields that pass straight
  through to a provider are `| None`: `realtime.turnDetection.{threshold,
  prefixPaddingMs, silenceDurationMs, eagerness, interruptResponse}` and
  `realtime.noiseReduction`. `None` there means the key is omitted from the
  outbound OpenAI payload entirely (preserving `_turn_detection()`'s idiom)
  and omitted from the hashed document. Every other field is
  required-with-a-default: those are our knobs, not the provider's.
* **Milliseconds are `int`, dB and unit-interval knobs are `float`.** The ms
  values are handed to providers as integers (Deepgram's `endpointing=500`
  query param, OpenAI's `silence_duration_ms`); the dB and 0..1 knobs are
  client-side maths with sub-integer steps.

This module deliberately imports nothing from `app`. `app.api.realtime` (the
`tuning` request field) and `app.providers.deepgram_stt`
(`DeepgramParams.from_tuning`) both import it, so it cannot import them back.
The literal defaults below therefore *duplicate* the provider constants they
mirror, and `tests/test_tuning_config.py` asserts they never drift apart.
`app.tuning.defaults` is the module that reads the real constants and
`settings`; that is what `/api/tuning/capabilities` serves.
"""

from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

TUNING_SCHEMA_VERSION: Final = 1

TuningMode = Literal["cascade", "realtime"]


class _TuningModel(BaseModel):
    """Shared config for every node of the document: camelCase aliases in,
    snake_case attributes here, unknown keys dropped rather than rejected."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class Microphone(_TuningModel):
    """`getUserMedia` audio constraints. All three are `true` today, hardcoded
    at `useCascadeSession.ts`/`useRealtimeSession.ts`; the panel makes them
    selectable without changing the default behaviour."""

    echo_cancellation: bool = Field(default=True, alias="echoCancellation")
    noise_suppression: bool = Field(default=True, alias="noiseSuppression")
    auto_gain_control: bool = Field(default=True, alias="autoGainControl")


class RmsGate(_TuningModel):
    """Client-side noise gate (`public/gate-processor.js`). Ranges/steps here
    are the same ones `fingerprint._KNOB_RANGES` quantises against."""

    enabled: bool = False
    threshold_dbfs: float = Field(default=-45, alias="thresholdDbfs")  # -80..0 step 1
    hold_ms: int = Field(default=200, alias="holdMs")  # 0..2000 step 10
    attack_ms: int = Field(default=5, alias="attackMs")  # 0..500 step 1
    release_ms: int = Field(default=80, alias="releaseMs")  # 0..2000 step 10
    attenuation_db: float = Field(default=12, alias="attenuationDb")  # 0..60 step 1
    full_mute: bool = Field(default=False, alias="fullMute")


class Rnnoise(_TuningModel):
    enabled: bool = False
    voice_prob_threshold: float = Field(
        default=0.5, alias="voiceProbThreshold"
    )  # 0..1 step 0.05


class ClientTuning(_TuningModel):
    """Everything that happens in the browser before audio leaves it. Shared
    by both modes, which is why it sits outside `realtime`/`cascade`."""

    microphone: Microphone = Field(default_factory=Microphone)
    rms_gate: RmsGate = Field(default_factory=RmsGate, alias="rmsGate")
    rnnoise: Rnnoise = Field(default_factory=Rnnoise)


class RealtimeTurnDetection(_TuningModel):
    """`session.audio.input.turn_detection`. Every field but `type` is
    absent-means-provider-default: `threshold`/`prefixPaddingMs`/
    `silenceDurationMs` apply to `server_vad` only, `eagerness` to
    `semantic_vad` only, `interruptResponse` to both."""

    type: Literal["server_vad", "semantic_vad"] = "server_vad"
    threshold: float | None = None  # 0..1 step 0.05
    prefix_padding_ms: int | None = Field(default=None, alias="prefixPaddingMs")
    silence_duration_ms: int | None = Field(default=None, alias="silenceDurationMs")
    eagerness: Literal["low", "medium", "high", "auto"] | None = None
    interrupt_response: bool | None = Field(default=None, alias="interruptResponse")


class RealtimeTranscriptCheck(_TuningModel):
    """Realtime has no `correct` mode (Step 7 gate outcome 2): the backend sees
    nothing after minting the token, so there is no text to rewrite in flight.
    `flag` is a best-effort round trip through `POST /api/tuning/transcript-check`."""

    mode: Literal["off", "flag"] = "off"
    model: str = "gpt-4o-mini"


class RealtimeTuning(_TuningModel):
    model: str = "gpt-realtime"  # == app.api.realtime.REALTIME_MODEL
    voice: str = "alloy"  # == app.api.realtime.REALTIME_VOICE
    turn_detection: RealtimeTurnDetection = Field(
        default_factory=RealtimeTurnDetection, alias="turnDetection"
    )
    # Three-state *plus absent*: absent => no `noise_reduction` key at all,
    # "off" => an explicit null (the SDK's documented "turn it off"), the two
    # field values => {"type": <value>}.
    noise_reduction: Literal["off", "near_field", "far_field"] | None = Field(
        default=None, alias="noiseReduction"
    )
    transcript_check: RealtimeTranscriptCheck = Field(
        default_factory=RealtimeTranscriptCheck, alias="transcriptCheck"
    )


class CascadeDeepgram(_TuningModel):
    """The connection-level block: changing any of these four means tearing
    down and reopening the Deepgram socket (see
    `allowlists.DEEPGRAM_CONNECTION_LEVEL_FIELDS`)."""

    model: str = "nova-3"  # == app.providers.deepgram_stt.MODEL
    endpointing_ms: int = Field(default=500, alias="endpointingMs")  # == ENDPOINTING_MS
    utterance_end_ms: int = Field(
        default=3000, alias="utteranceEndMs"
    )  # == UTTERANCE_END_MS
    diarize: bool = True  # literal in deepgram_stt._url()


class CascadeSegmentation(_TuningModel):
    mode: Literal["hybrid", "llm_priority"] = "hybrid"
    model: str = "gpt-4o-mini"  # == app.providers.segmentation_checker.MODEL


class NoisereduceTuning(_TuningModel):
    enabled: bool = False
    prop_decrease: float = Field(default=1.0, alias="propDecrease")  # 0..1 step 0.05
    stationary: bool = False


class DeepFilterNetTuning(_TuningModel):
    enabled: bool = False
    attenuation_limit_db: float = Field(
        default=30, alias="attenuationLimitDb"
    )  # 0..100 step 1
    post_filter_beta: float = Field(
        default=0.02, alias="postFilterBeta"
    )  # 0..1 step 0.05


class OfflineDenoise(_TuningModel):
    """Benchmark-only stages. The live path ignores them and logs once; only
    `run_tuning_sweep.py` honours them, applied to the whole WAV before replay."""

    demucs: bool = False
    dns64: bool = False


class CascadeDenoise(_TuningModel):
    """Fixed chain order, cheap first: noisereduce -> deepfilternet."""

    noisereduce: NoisereduceTuning = Field(default_factory=NoisereduceTuning)
    deepfilternet: DeepFilterNetTuning = Field(default_factory=DeepFilterNetTuning)
    offline: OfflineDenoise = Field(default_factory=OfflineDenoise)


class CascadeTranscriptCheck(_TuningModel):
    mode: Literal["off", "flag", "correct"] = "off"
    model: str = "gpt-4o-mini"


class CascadeTuning(_TuningModel):
    deepgram: CascadeDeepgram = Field(default_factory=CascadeDeepgram)
    segmentation: CascadeSegmentation = Field(default_factory=CascadeSegmentation)
    denoise: CascadeDenoise = Field(default_factory=CascadeDenoise)
    transcript_check: CascadeTranscriptCheck = Field(
        default_factory=CascadeTranscriptCheck, alias="transcriptCheck"
    )
    translation_model: str = Field(
        default="gpt-4o-mini", alias="translationModel"
    )  # == app.providers.openai_translation.MODEL
    tts_voice_a: str = Field(default="", alias="ttsVoiceA")
    tts_voice_b: str = Field(default="", alias="ttsVoiceB")


class TuningConfig(_TuningModel):
    """The full document: both modes, so one export/import round-trips
    everything. What goes on the wire and what gets hashed is the mode-scoped
    projection (`fingerprint.project_mode`).

    `schema_version` is a plain `int`, not `Literal[1]`, on purpose: a
    `schemaVersion: 2` document has to parse far enough for the route to
    answer with the documented 400 ("Unsupported tuning schemaVersion 2")
    instead of pydantic's generic 422.
    """

    schema_version: int = Field(default=TUNING_SCHEMA_VERSION, alias="schemaVersion")
    client: ClientTuning = Field(default_factory=ClientTuning)
    realtime: RealtimeTuning = Field(default_factory=RealtimeTuning)
    cascade: CascadeTuning = Field(default_factory=CascadeTuning)


class RealtimeModeTuning(_TuningModel):
    """`ModeTuningConfig` for `mode: "realtime"` -- the wire + hash document."""

    schema_version: int = Field(default=TUNING_SCHEMA_VERSION, alias="schemaVersion")
    mode: Literal["realtime"] = "realtime"
    client: ClientTuning = Field(default_factory=ClientTuning)
    realtime: RealtimeTuning = Field(default_factory=RealtimeTuning)


class CascadeModeTuning(_TuningModel):
    """`ModeTuningConfig` for `mode: "cascade"`."""

    schema_version: int = Field(default=TUNING_SCHEMA_VERSION, alias="schemaVersion")
    mode: Literal["cascade"] = "cascade"
    client: ClientTuning = Field(default_factory=ClientTuning)
    cascade: CascadeTuning = Field(default_factory=CascadeTuning)


ModeTuningConfig = RealtimeModeTuning | CascadeModeTuning


def to_wire(config: BaseModel) -> dict[str, Any]:
    """The document as the browser sends and receives it: camelCase keys, and
    absent optional keys genuinely absent rather than serialised as `null`.

    `exclude_none=True` is the whole absent-key idiom in one flag -- it is
    safe here because the only `None`-able fields in the schema are exactly
    the provider pass-through ones (see the module docstring)."""
    return config.model_dump(by_alias=True, exclude_none=True)
