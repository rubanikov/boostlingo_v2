"""Ticket 18: every curated model/voice picker, end to end through the
Cascade WebSocket.

Two halves, one per acceptance criterion:

- **Wired through (story AC 5.6, brief test S31's end-to-end half).** A valid
  non-default value picked in the panel is what the provider is actually
  called with -- `DeepgramParams` on the STT stream, `model=` on
  `translate()` and `is_complete_clause()`, `voice=` on `synthesize()`.
  A picker that renders but doesn't reach the provider is worse than no
  picker: the fingerprint would claim a config the run never used.
- **Tolerant fallback (story AC 5.7, brief test F4, extended from ticket
  06's two pickers to all six).** A value outside the server's allow-list --
  which the panel can't produce, but tooling and a stale export can -- keeps
  the value already in force, logs, and leaves the session running. The
  Realtime HTTP route 400s the same input (`test_realtime.py`); the
  asymmetry is deliberate and documented in `orchestrator`'s docstring.

The fakes here are local rather than imported from `test_orchestrator.py`.
They record what they were handed and nothing else, which is all these two
acceptance criteria need: every assertion below reads a recorded argument.
"""

import json
import logging
from typing import ClassVar

import pytest
from starlette.testclient import TestClient

from app import orchestrator
from app.config import settings
from app.main import app
from app.providers.base import TranscriptSegment, TTSFlush
from app.tuning.defaults import default_cascade_tuning
from app.tuning.fingerprint import fingerprint
from app.tuning.schema import CascadeModeTuning, CascadeTuning, ClientTuning

# A valid, entirely non-default setting for each of the six Cascade pickers,
# so "the provider got what was picked" can't pass by accident on a default.
PICKED = {
    "deepgram": {"model": "nova-2"},
    "segmentation": {"model": "gpt-4.1-mini"},
    "transcriptCheck": {"model": "gpt-4.1-nano"},
    "translationModel": "gpt-4.1-nano",
    "ttsVoiceA": settings.elevenlabs_voice_id_speaker_b,
    "ttsVoiceB": settings.elevenlabs_voice_id,
}

# The same six pickers, each naming something this server never offered: a
# model that doesn't exist, and voice ids it has no key to speak with.
REJECTED = {
    "deepgram": {"model": "whisper-9"},
    "segmentation": {"model": "gpt-9"},
    "transcriptCheck": {"model": "gpt-9"},
    "translationModel": "gpt-9",
    "ttsVoiceA": "not-a-configured-voice",
    "ttsVoiceB": "another-unconfigured-voice",
}

# `_reject_tuning_field` logs one line per refused field, named by its path in
# the wire document -- the log is the only place a fallback is visible
# server-side, so the paths are asserted rather than just the count.
REJECTED_PATHS = [
    "cascade.deepgram.model",
    "cascade.segmentation.model",
    "cascade.transcriptCheck.model",
    "cascade.translationModel",
    "cascade.ttsVoiceA",
    "cascade.ttsVoiceB",
]


def _picked_tuning() -> CascadeTuning:
    """`PICKED` as the parsed config the server should end up holding."""
    base = default_cascade_tuning()
    return base.model_copy(
        update={
            "deepgram": base.deepgram.model_copy(update={"model": "nova-2"}),
            "segmentation": base.segmentation.model_copy(update={"model": "gpt-4.1-mini"}),
            "transcript_check": base.transcript_check.model_copy(update={"model": "gpt-4.1-nano"}),
            "translation_model": "gpt-4.1-nano",
            "tts_voice_a": settings.elevenlabs_voice_id_speaker_b,
            "tts_voice_b": settings.elevenlabs_voice_id,
        }
    )


def _tuning_message(**cascade: object) -> dict:
    """A `ModeTuningConfig` wire document carrying only the cascade fields a
    test names. Everything absent is filled from the config already in
    force, which is what makes a per-field fallback observable."""
    return {"schemaVersion": 1, "mode": "cascade", "client": {}, "cascade": dict(cascade)}


def _expected_fingerprint(cascade: CascadeTuning) -> str:
    """What the panel computes for the same document. The server reports its
    own, so a knob that fell back moves the fingerprint the UI displays --
    that is how a silent fallback becomes visible."""
    return fingerprint(CascadeModeTuning(client=ClientTuning(), cascade=cascade), "cascade")


def _message_kind(raw_message: dict) -> str:
    if raw_message.get("bytes") is not None:
        return "binary_audio"
    return json.loads(raw_message["text"])["type"]


def _receive_until(ws, message_type: str, limit: int = 25) -> dict:
    for _ in range(limit):
        raw = ws.receive()
        if _message_kind(raw) == message_type:
            return json.loads(raw["text"]) if raw.get("bytes") is None else {}
    raise AssertionError(f"no {message_type!r} message within {limit} messages")


def _start_session(ws, tuning: dict | None = None) -> dict:
    """Opens a session and drains the two messages that always follow --
    `session_started` and the unsolicited `tuning_applied` -- returning the
    latter, which carries the fingerprint of the config actually in force."""
    payload: dict = {"type": "start_session", "languages": ["en", "es"]}
    if tuning is not None:
        payload["tuning"] = tuning
    ws.send_json(payload)
    started = json.loads(ws.receive()["text"])
    assert started["type"] == "session_started"
    applied = json.loads(ws.receive()["text"])
    assert applied["type"] == "tuning_applied"
    return applied


def _run_one_segment(ws) -> None:
    """One mic frame in, one full segment out -- the recording fakes below
    turn each frame into exactly one finished segment, so a test can put an
    `update_tuning` between two segments and see which config each used."""
    ws.send_bytes(b"\x00\x01")
    _receive_until(ws, "binary_audio")


class _RecordingSTT:
    """Records the `DeepgramParams` of every `stream()` call (one entry per
    connection, so a reconnect is visible as a second entry) and turns each
    audio frame into one finished segment."""

    calls: ClassVar[list] = []
    speaker: ClassVar[int | None] = None

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        type(self).calls.append(params)
        async for _ in audio_chunks:
            yield TranscriptSegment(
                text="hello", is_final=True, speech_final=True, speaker=type(self).speaker
            )


class _RecordingTranslation:
    models: ClassVar[list] = []

    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang, model=None):
        del source_text, source_lang, target_lang
        type(self).models.append(model)
        yield "Hola"


class _RecordingTTS:
    voices: ClassVar[list] = []

    def __init__(self, api_key: str, voice_id: str) -> None:
        pass

    async def synthesize(self, input_events, *, voice):
        type(self).voices.append(voice)
        async for event in input_events:
            if isinstance(event, TTSFlush):
                yield b"\x00"
                return


class _RecordingSegmentationChecker:
    """Records the clause-check model, and never completes a clause so
    segmentation stays driven by Deepgram's `speech_final` (as in every other
    orchestrator test).

    `is_complete_clause` is a plain `def` returning a coroutine rather than an
    `async def` on purpose: the orchestrator wraps it in `create_task` and,
    on a `speech_final` result, parks that task before the event loop ever
    runs it. An `async def` body would record nothing.
    """

    models: ClassVar[list] = []

    def __init__(self, api_key: str) -> None:
        pass

    def is_complete_clause(self, text: str, language: str, *, model: str | None = None):
        del text, language
        type(self).models.append(model)
        return self._incomplete()

    async def _incomplete(self) -> bool:
        return False


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def recording_providers(monkeypatch):
    """All four per-session collaborators replaced by recorders, with their
    class-level records cleared. Returns them so a test can assert on exactly
    what each stage was handed."""
    _RecordingSTT.calls = []
    _RecordingSTT.speaker = None
    _RecordingTranslation.models = []
    _RecordingTTS.voices = []
    _RecordingSegmentationChecker.models = []
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _RecordingSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _RecordingTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _RecordingTTS)
    monkeypatch.setattr(orchestrator, "SegmentationChecker", _RecordingSegmentationChecker)
    return _RecordingSTT, _RecordingTranslation, _RecordingTTS, _RecordingSegmentationChecker


class TestPickersReachTheProviders:
    """S31, end-to-end half: what the panel picked is what the providers are
    called with."""

    def test_start_session_pickers_reach_every_provider(self, client, recording_providers):
        stt, translation, tts, checker = recording_providers

        with client.websocket_connect("/ws/cascade") as ws:
            applied = _start_session(ws, _tuning_message(**PICKED))
            _run_one_segment(ws)

        assert applied["fingerprint"] == _expected_fingerprint(_picked_tuning())
        assert stt.calls == [
            orchestrator.DeepgramParams(
                model="nova-2", endpointing_ms=500, utterance_end_ms=3000, diarize=True
            )
        ]
        assert checker.models == ["gpt-4.1-mini"]
        assert translation.models == ["gpt-4.1-nano"]
        assert tts.voices == [settings.elevenlabs_voice_id_speaker_b]

    def test_the_speaker_b_voice_picker_reaches_tts_for_a_diarized_second_speaker(
        self, client, recording_providers
    ):
        """`ttsVoiceB` is only reachable through a segment Deepgram attributed
        to speaker 1 -- the other picker's wiring proves nothing about it."""
        _, _, tts, _ = recording_providers
        _RecordingSTT.speaker = 1

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, _tuning_message(**PICKED))
            _run_one_segment(ws)

        assert tts.voices == [settings.elevenlabs_voice_id]

    def test_a_voice_added_by_the_environment_is_accepted_and_spoken_with(
        self, client, recording_providers, monkeypatch, caplog
    ):
        """The TTS voice picker has no hard-coded list of premade ElevenLabs
        voices (Step 7 gate outcome 3): it is the two configured voices plus
        `ELEVENLABS_VOICE_IDS_EXTRA`. Adding an id there is the whole
        mechanism, so it has to widen what the socket accepts, not just what
        `/api/tuning/capabilities` displays."""
        _, _, tts, _ = recording_providers
        monkeypatch.setattr(settings, "elevenlabs_voice_ids_extra", ["pNInz6obpgDQGcFmaJgB"])

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(ws, _tuning_message(ttsVoiceA="pNInz6obpgDQGcFmaJgB"))
            _run_one_segment(ws)

        assert tts.voices == ["pNInz6obpgDQGcFmaJgB"]
        assert not [record for record in caplog.records if "rejected" in record.message]

    def test_a_live_update_moves_every_per_segment_picker_to_the_next_segment(
        self, client, recording_providers
    ):
        """The translation model, clause-check model and TTS voices are read
        per segment, so they change without reopening the STT socket: one
        `stream()` call for both segments."""
        stt, translation, tts, checker = recording_providers
        defaults = default_cascade_tuning()

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws)
            _run_one_segment(ws)

            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-18a",
                    "tuning": _tuning_message(
                        segmentation={"model": "gpt-4.1-mini"},
                        translationModel="gpt-4.1-nano",
                        ttsVoiceA=settings.elevenlabs_voice_id_speaker_b,
                    ),
                }
            )
            applied = _receive_until(ws, "tuning_applied")
            _run_one_segment(ws)

        assert applied["reconnectedStt"] is False
        assert len(stt.calls) == 1
        assert checker.models == [defaults.segmentation.model, "gpt-4.1-mini"]
        assert translation.models == [defaults.translation_model, "gpt-4.1-nano"]
        assert tts.voices == [settings.elevenlabs_voice_id, settings.elevenlabs_voice_id_speaker_b]


class TestOutOfAllowListPickersFallBack:
    """F4, extended from ticket 06's two pickers to all six: the WebSocket
    never 400s and never closes (story AC 5.7)."""

    def test_start_session_falls_back_to_the_defaults_and_logs(
        self, client, recording_providers, caplog
    ):
        stt, translation, tts, checker = recording_providers
        defaults = default_cascade_tuning()

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            applied = _start_session(ws, _tuning_message(**REJECTED))
            # The session is alive and translating: a rejected picker costs
            # that picker, not the run.
            _run_one_segment(ws)

        assert applied["fingerprint"] == _expected_fingerprint(defaults)
        assert stt.calls == [orchestrator.DeepgramParams()]
        assert checker.models == [defaults.segmentation.model]
        assert translation.models == [defaults.translation_model]
        assert tts.voices == [defaults.tts_voice_a]

        rejected = [record.message for record in caplog.records if "rejected" in record.message]
        assert len(rejected) == len(REJECTED_PATHS)
        for path in REJECTED_PATHS:
            assert any(path in message for message in rejected), path

    def test_update_tuning_keeps_the_values_already_in_force_and_logs(
        self, client, recording_providers, caplog
    ):
        """Fallback is to the config *in force*, not to the shipped defaults:
        an Apply that names one bad model must not quietly undo the five good
        choices made before it."""
        stt, translation, tts, checker = recording_providers
        picked = _picked_tuning()

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(ws, _tuning_message(**PICKED))
            _run_one_segment(ws)

            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-18b",
                    "tuning": _tuning_message(**REJECTED),
                }
            )
            applied = _receive_until(ws, "tuning_applied")
            _run_one_segment(ws)

        # An Apply whose every field was refused is still an applied Apply --
        # the client is told what is running, which is what it was already.
        assert applied == {
            "type": "tuning_applied",
            "requestId": "req-18b",
            "fingerprint": _expected_fingerprint(picked),
            "reconnectedStt": False,
        }
        # No reconnect: the refused `deepgram.model` never became a
        # connection-level change, because it never became a change at all.
        assert len(stt.calls) == 1
        assert checker.models == ["gpt-4.1-mini", "gpt-4.1-mini"]
        assert translation.models == ["gpt-4.1-nano", "gpt-4.1-nano"]
        assert tts.voices == [settings.elevenlabs_voice_id_speaker_b] * 2

        rejected = [record.message for record in caplog.records if "rejected" in record.message]
        for path in REJECTED_PATHS:
            assert any(path in message for message in rejected), path

    def test_one_bad_picker_does_not_cost_the_good_ones_in_the_same_apply(
        self, client, recording_providers, caplog
    ):
        """The per-field overlay, from the client's point of view: a document
        mixing one refused model with five valid picks applies the five."""
        _, translation, tts, checker = recording_providers

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            applied = _start_session(ws, _tuning_message(**{**PICKED, "translationModel": "gpt-9"}))
            _run_one_segment(ws)

        expected = _picked_tuning().model_copy(
            update={"translation_model": default_cascade_tuning().translation_model}
        )
        assert applied["fingerprint"] == _expected_fingerprint(expected)
        assert checker.models == ["gpt-4.1-mini"]
        assert translation.models == [default_cascade_tuning().translation_model]
        assert tts.voices == [settings.elevenlabs_voice_id_speaker_b]
        assert sum("rejected" in record.message for record in caplog.records) == 1
