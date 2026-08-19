"""Curated allow-lists for every picker in the tuning panel.

This module is the canonical home; the frontend reads these through
`GET /api/tuning/capabilities` and keeps a copy in `tuningConfig.ts` only as
an offline fallback. Serving them (rather than hardcoding them in the UI) is
what lets the server reject a value it never offered, and what lets the panel
show exactly what this server supports.

Each list is small and deliberate -- "every model OpenAI has" is not a useful
picker for a latency lab, and an unvalidated free-text model id reaches a
provider call.
"""

from typing import Any, Final

from app.config import settings

# Verified against the pinned SDK's generated types:
# openai/types/realtime/realtime_session_create_request.py.
REALTIME_MODELS: Final[tuple[str, ...]] = ("gpt-realtime", "gpt-realtime-mini")

# openai/types/realtime/realtime_audio_config_output.py.
REALTIME_VOICES: Final[tuple[str, ...]] = (
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
    "marin",
    "cedar",
)

# `nova-3` is today's default (`deepgram_stt.MODEL`); `nova-2` is the previous
# generation, kept so a regression can be attributed to the model.
DEEPGRAM_MODELS: Final[tuple[str, ...]] = ("nova-3", "nova-2")

# Shared by the translation, segmentation and transcript-check pickers: all
# three are small/fast chat models on the per-segment critical path.
TEXT_MODELS: Final[tuple[str, ...]] = ("gpt-4o-mini", "gpt-4.1-mini", "gpt-4.1-nano")

# openai/types/realtime/realtime_audio_input_turn_detection.py and
# noise_reduction_type.py. `off` is ours, not OpenAI's: it maps to an
# explicit `null` on the wire (see `schema.RealtimeTuning.noise_reduction`).
TURN_DETECTION_TYPES: Final[tuple[str, ...]] = ("server_vad", "semantic_vad")
EAGERNESS: Final[tuple[str, ...]] = ("low", "medium", "high", "auto")
NOISE_REDUCTION: Final[tuple[str, ...]] = ("off", "near_field", "far_field")

SEGMENTATION_MODES: Final[tuple[str, ...]] = ("hybrid", "llm_priority")

# Changing any of these four means the Deepgram query string changes, which
# means the socket has to be reopened -- everything else on the Cascade side
# applies to the next segment or frame with no reconnect. Named in terms of
# `schema.CascadeDeepgram` field names so the server can diff two parsed
# configs and decide the reconnect for itself, rather than trusting the
# client's claim. The TS mirror is `DEEPGRAM_CONNECTION_LEVEL_PATHS`
# (`cascade.deepgram.<camelCase>`) in `tuningConfig.ts`.
DEEPGRAM_CONNECTION_LEVEL_FIELDS: Final[frozenset[str]] = frozenset(
    {"model", "endpointing_ms", "utterance_end_ms", "diarize"}
)


def elevenlabs_voices() -> list[dict[str, str]]:
    """The TTS voice picker: the two voices this server is actually configured
    with, plus anything in `ELEVENLABS_VOICE_IDS_EXTRA`.

    There is no hard-coded list of premade ElevenLabs voices (Step 7 gate
    outcome 3) -- a voice id the server cannot speak with has no business in
    the picker. Extra ids are labelled with the id itself: the server knows
    nothing else about them. Read from `settings` at call time so a test (or a
    `.env` edit plus restart) is reflected without reimporting.
    """
    voices = [
        {"id": settings.elevenlabs_voice_id, "label": "Rachel (voice A default)"},
        {
            "id": settings.elevenlabs_voice_id_speaker_b,
            "label": "Antoni (voice B default)",
        },
    ]
    seen = {voice["id"] for voice in voices}
    for voice_id in settings.elevenlabs_voice_ids_extra:
        if voice_id and voice_id not in seen:
            voices.append({"id": voice_id, "label": voice_id})
            seen.add(voice_id)
    return voices


def allow_lists() -> dict[str, Any]:
    """The `allowLists` block of `GET /api/tuning/capabilities`, camelCase for
    the wire. Lists, not tuples, so the JSON is arrays."""
    return {
        "realtimeModels": list(REALTIME_MODELS),
        "realtimeVoices": list(REALTIME_VOICES),
        "deepgramModels": list(DEEPGRAM_MODELS),
        "textModels": list(TEXT_MODELS),
        "elevenLabsVoices": elevenlabs_voices(),
        "turnDetectionTypes": list(TURN_DETECTION_TYPES),
        "eagerness": list(EAGERNESS),
        "noiseReduction": list(NOISE_REDUCTION),
    }
