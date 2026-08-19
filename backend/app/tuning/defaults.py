"""The effective `TuningConfig` this server starts from: `.env` plus the
provider constants that were hardcoded before the panel existed.

This is the "`.env` becomes *server defaults*" half of the feature. Every
value here already governed a session; the difference is that it is now
published (`GET /api/tuning/capabilities` -> the panel shows real numbers, not
blanks -- story AC 1.11) instead of being invisible.

`default_tuning_config()` is a function, not a module constant, so a `.env`
edit plus a restart -- or a monkeypatched `settings` in a test -- is reflected
immediately, and so nothing here is evaluated at import time.

The provider modules are imported as *modules* and read at call time. That is
deliberate: `app.api.realtime` will import `app.tuning.schema` in ticket 04,
and reading `realtime_api.REALTIME_MODEL` inside the function keeps a
partially-initialised module during a circular import from turning into an
ImportError at start-up.
"""

from app.api import realtime as realtime_api
from app.config import settings
from app.providers import deepgram_stt, openai_translation, segmentation_checker
from app.tuning.schema import (
    CascadeDeepgram,
    CascadeSegmentation,
    CascadeTuning,
    ClientTuning,
    RealtimeTuning,
    RealtimeTurnDetection,
    TuningConfig,
)


def default_realtime_tuning() -> RealtimeTuning:
    """Today's Realtime session, expressed as tuning.

    `silenceDurationMs`/`interruptResponse` stay **absent** when their
    settings are unset, because that is exactly what `_turn_detection()` does
    today: an unset knob is genuinely OpenAI's own default rather than a
    re-statement of it. This is the ticket's tracer bullet -- setting
    `REALTIME_VAD_SILENCE_MS` in `backend/.env` adds the key and therefore
    moves the fingerprint.
    """
    return RealtimeTuning(
        model=realtime_api.REALTIME_MODEL,
        voice=realtime_api.REALTIME_VOICE,
        turn_detection=RealtimeTurnDetection(
            type="server_vad",
            silence_duration_ms=settings.realtime_vad_silence_ms,
            interrupt_response=settings.realtime_vad_interrupt_response,
        ),
    )


def default_cascade_tuning() -> CascadeTuning:
    """Today's Cascade pipeline, expressed as tuning: the Deepgram connection
    constants (`deepgram_stt.py`), the segmentation and translation models,
    and the two configured ElevenLabs voices. `diarize=True` mirrors the
    literal in `deepgram_stt._url()`; `segmentation.mode="hybrid"` mirrors
    `orchestrator._parse_segmentation_mode`'s fallback."""
    return CascadeTuning(
        deepgram=CascadeDeepgram(
            model=deepgram_stt.MODEL,
            endpointing_ms=deepgram_stt.ENDPOINTING_MS,
            utterance_end_ms=deepgram_stt.UTTERANCE_END_MS,
            diarize=True,
        ),
        segmentation=CascadeSegmentation(
            mode="hybrid", model=segmentation_checker.MODEL
        ),
        translation_model=openai_translation.MODEL,
        tts_voice_a=settings.elevenlabs_voice_id,
        tts_voice_b=settings.elevenlabs_voice_id_speaker_b,
    )


def default_tuning_config() -> TuningConfig:
    """The full document (both modes) the panel loads when nothing is stored."""
    return TuningConfig(
        client=ClientTuning(),
        realtime=default_realtime_tuning(),
        cascade=default_cascade_tuning(),
    )
