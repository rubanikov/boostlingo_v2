"""Orchestrator-level tests: drive the real `/ws/cascade` route end-to-end
with fake STT/Translation/TTS providers substituted in via
`app.orchestrator`'s module-level provider classes (proving the pipeline
only ever reaches providers through the `Protocol` interfaces -- swapping
one out, as done here, touches no orchestrator code), and assert the
WebSocket message sequence matches the documented contract.

Provider-boundary contract tests (the mocked-SDK, per-provider tests the
ticket calls out explicitly) live in `test_providers.py`; this file is
about the wiring between them.
"""

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import ClassVar

import pytest
from starlette.testclient import TestClient

from app import orchestrator
from app.config import settings
from app.main import app
from app.providers import denoise
from app.providers.base import (
    ProviderError,
    ProviderErrorKind,
    TranscriptSegment,
    TTSFlush,
    TTSText,
    UtteranceEndSignal,
)
from app.providers.transcript_check import TranscriptCheckResult
from app.tuning.defaults import default_cascade_tuning
from app.tuning.fingerprint import fingerprint
from app.tuning.schema import CascadeModeTuning, CascadeTuning, ClientTuning


class _FakeSTT:
    """Emits one interim segment, then a final+speech_final segment."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        # Doesn't need to consume `audio_chunks` to satisfy the Protocol --
        # draining it fully would block until the client disconnects, which
        # these tests read messages before doing.
        del audio_chunks
        yield TranscriptSegment(text="hello", is_final=False, speech_final=False)
        yield TranscriptSegment(text="hello world", is_final=True, speech_final=True)


class _FakeIdleSTT:
    """Never yields a `TranscriptSegment` -- for tests that only exercise
    the clock-sync/playback-started protocol, not a full segment, so
    there's no unrelated STT-driven traffic on the wire to account for."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del audio_chunks, languages
        return
        yield  # pragma: no cover -- makes this an async generator function


class _FakeSilentThenSpeechSTT:
    """Silence (empty final+speech_final) followed by real speech -- proves
    the empty segment produces no downstream messages but doesn't wedge the
    pipeline for the segment after it."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del audio_chunks
        yield TranscriptSegment(text="", is_final=True, speech_final=True)
        yield TranscriptSegment(text="hi", is_final=True, speech_final=True)


class _FakeTranslation:
    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang, model=None):
        for piece in ["Hola", " mundo"]:
            yield piece


class _FakeTTS:
    """Ignores individual TTSText chunks and only emits audio on flush --
    keeps the resulting WebSocket message sequence deterministic for
    assertions (a real provider may emit audio earlier; that's exercised
    directly in test_providers.py)."""

    def __init__(self, api_key: str, voice_id: str) -> None:
        pass

    async def synthesize(self, input_events, *, voice):
        async for event in input_events:
            if isinstance(event, TTSText):
                continue
            if isinstance(event, TTSFlush):
                yield b"\x01\x02\x03"
                return


def _message_kind(raw_message: dict) -> str:
    if raw_message.get("bytes") is not None:
        return "binary_audio"
    return json.loads(raw_message["text"])["type"]


def _sequential_clock(monkeypatch, values: list[int]) -> None:
    """Monkeypatches `orchestrator._now_ms` to return `values` in order, one
    per call -- turns elapsed-ms latency math into something assertable
    against literal expected numbers instead of real (flaky) wall-clock
    deltas."""
    iterator = iter(values)
    monkeypatch.setattr(orchestrator, "_now_ms", lambda: next(iterator))


def _start_session(ws, languages: list[str] | None = None, **extra: object) -> str:
    """Sends `start_session` and drains the two messages that always open a
    session -- `session_started` (Ticket 7) and the unsolicited
    `tuning_applied` (Ticket 6) -- returning the `sessionId`, so every other
    test's message-count/order assertions stay about the pipeline rather
    than needing a `+2` everywhere.

    `extra` carries the session-scoped fields a tuning test needs
    (`tuning=`, `segmentationMode=`) without every other caller growing a
    parameter it doesn't use."""
    payload: dict = {"type": "start_session", **extra}
    if languages is not None:
        payload["languages"] = languages
    ws.send_json(payload)
    session_started = json.loads(ws.receive()["text"])
    assert session_started["type"] == "session_started"
    assert session_started["sessionId"]
    tuning_applied = json.loads(ws.receive()["text"])
    assert tuning_applied["type"] == "tuning_applied"
    return session_started["sessionId"]


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


class TestCascadeOrchestrator:
    def test_full_pipeline_message_sequence(self, client, monkeypatch):
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(13)]

        assert [_message_kind(m) for m in raw_messages] == [
            "source_transcript",
            "source_transcript",
            "segment_boundary",
            "latency",  # stt_final
            "latency",  # speech_end
            "latency",  # translation_first_token
            "target_transcript",
            "target_transcript",
            "latency",
            "target_transcript",
            "latency",
            "tts_audio_meta",
            "binary_audio",
        ]

        interim, final_source = (json.loads(m["text"]) for m in raw_messages[:2])
        segment_id = interim["segmentId"]
        assert segment_id  # a non-empty id (uuid4 hex), threaded through every message below
        assert interim == {
            "type": "source_transcript",
            "segmentId": segment_id,
            "text": "hello",
            "isFinal": False,
            "speaker": None,
        }
        assert final_source == {
            "type": "source_transcript",
            "segmentId": segment_id,
            "text": "hello world",
            "isFinal": True,
            "speaker": None,
        }

        boundary = json.loads(raw_messages[2]["text"])
        assert boundary == {
            "type": "segment_boundary",
            "segmentId": segment_id,
            "trigger": "deepgram_speech_final",
        }

        stt_final_latency = json.loads(raw_messages[3]["text"])
        assert stt_final_latency["stage"] == "stt_final"
        assert stt_final_latency["segmentId"] == segment_id
        assert isinstance(stt_final_latency["ms"], int)
        assert stt_final_latency["ms"] >= 0

        speech_end_latency = json.loads(raw_messages[4]["text"])
        assert speech_end_latency == {
            "type": "latency",
            "segmentId": segment_id,
            "stage": "speech_end",
            "ms": 0,
        }

        # The three timing-dependent stages -- real wall-clock deltas here,
        # not a mocked clock (see TestCascadeLatency for exact-value
        # assertions against a controlled clock): each is a `latency`
        # message for the same segment, a non-negative int `ms`, at the
        # positions the pipeline emits them.
        timed_stages = [json.loads(raw_messages[i]["text"]) for i in (5, 8, 10)]
        assert [m["stage"] for m in timed_stages] == [
            "translation_first_token",
            "translation_complete",
            "tts_first_byte",
        ]
        for message in timed_stages:
            assert message["type"] == "latency"
            assert message["segmentId"] == segment_id
            assert isinstance(message["ms"], int)
            assert message["ms"] >= 0

        final_target = json.loads(raw_messages[9]["text"])
        assert final_target == {
            "type": "target_transcript",
            "segmentId": segment_id,
            "text": "Hola mundo",
            "isFinal": True,
            "speaker": None,
        }

        audio_meta = json.loads(raw_messages[11]["text"])
        assert audio_meta == {
            "type": "tts_audio_meta",
            "segmentId": segment_id,
            "sampleRate": 16000,
            "speaker": None,
        }
        assert raw_messages[12]["bytes"] == b"\x01\x02\x03"

    def test_silent_segment_produces_no_downstream_messages(self, client, monkeypatch):
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSilentThenSpeechSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(12)]

        kinds = [_message_kind(m) for m in raw_messages]
        # Only one segment's worth of messages -- the silent segment
        # contributed no source_transcript, no segment_boundary, no
        # latency, nothing.
        assert kinds == [
            "source_transcript",
            "segment_boundary",
            "latency",  # stt_final
            "latency",  # speech_end
            "latency",  # translation_first_token
            "target_transcript",
            "target_transcript",
            "latency",
            "target_transcript",
            "latency",
            "tts_audio_meta",
            "binary_audio",
        ]
        # If the silent segment had wrongly produced a segment_boundary or
        # queued a translation, its segmentId would appear here instead.
        source = json.loads(raw_messages[0]["text"])
        assert source["text"] == "hi"
        boundary = json.loads(raw_messages[1]["text"])
        assert boundary["segmentId"] == source["segmentId"]

    def test_non_default_language_pair_reaches_stt_and_translation_providers(
        self, client, monkeypatch
    ):
        stt_calls = []
        translation_calls = []

        class _CapturingSTT:
            def __init__(self, api_key: str) -> None:
                pass

            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks
                stt_calls.append(languages)
                yield TranscriptSegment(text="hola", is_final=True, speech_final=True)

        class _CapturingTranslation:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang, model=None):
                del source_text
                translation_calls.append((source_lang, target_lang))
                yield "hello"

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _CapturingSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _CapturingTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["es", "en"])
            ws.send_bytes(b"\x00\x01")

            for _ in range(10):
                ws.receive()

        assert stt_calls == [("es", "en")]
        assert translation_calls == [("es", "en")]

    def test_missing_languages_defaults_to_en_es(self, client, monkeypatch):
        stt_calls = []

        class _CapturingSTT:
            def __init__(self, api_key: str) -> None:
                pass

            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks
                stt_calls.append(languages)
                yield TranscriptSegment(text="hi", is_final=True, speech_final=True)

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _CapturingSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws)  # no `languages` field at all
            ws.send_bytes(b"\x00\x01")

            for _ in range(11):
                ws.receive()

        assert stt_calls == [("en", "es")]

    def test_unsupported_language_code_defaults_to_en_es(self, client, monkeypatch):
        """Security/cost fix: `languages` is shape-checked but wasn't
        content-checked, so any string flowed verbatim into LLM system
        prompts for the whole session. `"xx"` isn't in
        `app.languages.SUPPORTED_LANGUAGES` (the same allow-list
        `app.api.realtime` validates against), so this falls back to
        `DEFAULT_LANGUAGES` exactly like a malformed-shape `languages`
        already does -- not used verbatim."""
        stt_calls = []

        class _CapturingSTT:
            def __init__(self, api_key: str) -> None:
                pass

            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks
                stt_calls.append(languages)
                yield TranscriptSegment(text="hi", is_final=True, speech_final=True)

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _CapturingSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["xx", "es"])  # "xx" isn't a supported code
            ws.send_bytes(b"\x00\x01")

            for _ in range(11):
                ws.receive()

        assert stt_calls == [("en", "es")]


class _FakeDiarizedSTT:
    """Three back-to-back utterances exercising the three direction-
    resolution branches together with distinct speakers: speaker 0 in the
    configured source language (default direction), speaker 1 in the
    configured target language (flipped direction), speaker 2 with no
    detected language at all (falls back to the default direction, and
    its voice wraps back to speaker 0's)."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del audio_chunks
        yield TranscriptSegment(
            text="hello", is_final=True, speech_final=True, speaker=0, detected_language="en"
        )
        yield TranscriptSegment(
            text="hola", is_final=True, speech_final=True, speaker=1, detected_language="es"
        )
        yield TranscriptSegment(
            text="hey", is_final=True, speech_final=True, speaker=2, detected_language=None
        )


class TestCascadeDiarization:
    def test_diarization_drives_direction_resolution_and_voice_selection(
        self, client, monkeypatch
    ):
        translation_calls = []
        tts_voices = []

        class _CapturingTranslation:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang, model=None):
                translation_calls.append((source_lang, target_lang))
                yield source_text  # echo, so the direction is legible below too

        class _CapturingTTS:
            def __init__(self, api_key: str, voice_id: str) -> None:
                pass

            async def synthesize(self, input_events, *, voice):
                tts_voices.append(voice)
                async for event in input_events:
                    if isinstance(event, TTSFlush):
                        yield b"\x00"
                        return

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeDiarizedSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _CapturingTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _CapturingTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            # 3 segments x (source_transcript, segment_boundary, latency
            # stt_final, latency speech_end, latency translation_first_token,
            # target_transcript interim, latency translation_complete,
            # target_transcript final, latency tts_first_byte,
            # tts_audio_meta, binary_audio) = 33 messages. STT keeps flowing
            # while a prior segment's translate/TTS is still in flight (see
            # orchestrator's concurrency shape), so segments' messages can
            # interleave on the wire -- group by segmentId below instead of
            # asserting one fixed order.
            raw_messages = [ws.receive() for _ in range(33)]

        kinds = [_message_kind(m) for m in raw_messages]
        assert sorted(kinds) == sorted(
            [
                "source_transcript",
                "segment_boundary",
                "latency",
                "latency",
                "latency",
                "latency",
                "latency",
                "target_transcript",
                "target_transcript",
                "tts_audio_meta",
                "binary_audio",
            ]
            * 3
        )

        source_speaker_by_segment = {}
        target_final_speaker_by_segment = {}
        meta_speaker_by_segment = {}
        for message, kind in zip(raw_messages, kinds, strict=True):
            if kind not in ("source_transcript", "target_transcript", "tts_audio_meta"):
                continue
            payload = json.loads(message["text"])
            if kind == "source_transcript":
                source_speaker_by_segment[payload["segmentId"]] = payload["speaker"]
            elif kind == "target_transcript" and payload["isFinal"]:
                target_final_speaker_by_segment[payload["segmentId"]] = payload["speaker"]
            elif kind == "tts_audio_meta":
                meta_speaker_by_segment[payload["segmentId"]] = payload["speaker"]

        # All three speakers were labeled, and consistently across every
        # message type for the same segment.
        assert sorted(source_speaker_by_segment.values()) == [0, 1, 2]
        assert target_final_speaker_by_segment == source_speaker_by_segment
        assert meta_speaker_by_segment == source_speaker_by_segment

        # `_run_pipeline` processes queued segments strictly in FIFO order
        # (one task, one segment fully handled before the next), so these
        # stay in STT emission order regardless of wire interleaving:
        # speaker 0/"en" -> default direction, speaker 1/"es" -> flipped
        # direction, speaker 2/no detected_language -> falls back to the
        # default direction rather than erroring.
        assert translation_calls == [("en", "es"), ("es", "en"), ("en", "es")]
        # Speaker 0 and speaker 2 (wrapping back to speaker 0) share a
        # voice; speaker 1 gets the distinct second voice.
        assert tts_voices == [
            settings.elevenlabs_voice_id,
            settings.elevenlabs_voice_id_speaker_b,
            settings.elevenlabs_voice_id,
        ]


class TestCascadeLatency:
    """Ticket 6: the `latency` message sequence for a segment (all 6
    stages, including the pre-reference `stt_final`), and the
    `clock_sync`/`playback_started` protocol that drives the final
    `playback_start` stage.
    """

    def test_latency_stage_sequence_for_a_segment(self, client, monkeypatch):
        # `_now_ms()` calls in order: the final transcript's
        # `finalized_at_ms` (10_000), `mark_speech_end` (10_050), the
        # `stt_final` message's own read (10_050 -> ms = 50), then one
        # `elapsed_since_speech_end()` call each for
        # translation_first_token (10_100), translation_complete (10_300),
        # tts_first_byte (10_450) -- by hand: ms = 50, 0, 50, 250, 400.
        _sequential_clock(monkeypatch, [10_000, 10_050, 10_050, 10_100, 10_300, 10_450])
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(13)]

        latency_messages = [
            json.loads(m["text"]) for m in raw_messages if _message_kind(m) == "latency"
        ]
        segment_ids = {m["segmentId"] for m in latency_messages}
        assert len(segment_ids) == 1  # all 5 stages are for the same segment

        assert [(m["stage"], m["ms"]) for m in latency_messages] == [
            ("stt_final", 50),
            ("speech_end", 0),
            ("translation_first_token", 50),
            ("translation_complete", 250),
            ("tts_first_byte", 400),
        ]
        # Monotonically non-decreasing from `speech_end` onward, as the
        # wire contract requires (`stt_final` is the one pre-reference
        # stage: a standalone duration, exempt from the cumulative order).
        ms_values = [m["ms"] for m in latency_messages[1:]]
        assert ms_values == sorted(ms_values)

    def test_clock_sync_round_trip(self, client, monkeypatch):
        _sequential_clock(monkeypatch, [20_000])
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeIdleSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_json({"type": "clock_sync", "clientTime": 5_000})

            ack = json.loads(ws.receive()["text"])

        assert ack == {"type": "clock_sync_ack", "clientTime": 5_000, "serverTime": 20_000}

    def test_playback_started_converts_client_time_using_clock_offset(self, client, monkeypatch):
        # Values 1-6 are the segment's server-side stages (matching
        # test_latency_stage_sequence_for_a_segment); value 7 is the
        # clock_sync serverTime, read only after the segment is fully
        # drained below (so there's no ambiguity about which call produced
        # which value).
        _sequential_clock(monkeypatch, [10_000, 10_050, 10_050, 10_100, 10_300, 10_450, 10_000])
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(13)]
            latency_messages = [
                json.loads(m["text"]) for m in raw_messages if _message_kind(m) == "latency"
            ]
            segment_id = latency_messages[0]["segmentId"]

            # clientTime=5_000 answered by the mocked server clock's 7th
            # call (10_000) -- offset = 10_000 - 5_000 = 5_000.
            ws.send_json({"type": "clock_sync", "clientTime": 5_000})
            ack = json.loads(ws.receive()["text"])
            assert ack == {"type": "clock_sync_ack", "clientTime": 5_000, "serverTime": 10_000}

            # Client reports playback scheduled at clientTime=20_000 ->
            # converted to server-time via the offset: 20_000 + 5_000 =
            # 25_000. That segment's speech_end was 10_050 (the second
            # mocked clock value above), so ms = 25_000 - 10_050 = 14_950.
            ws.send_json(
                {"type": "playback_started", "segmentId": segment_id, "clientTime": 20_000}
            )
            playback_latency = json.loads(ws.receive()["text"])

        assert playback_latency == {
            "type": "latency",
            "segmentId": segment_id,
            "stage": "playback_start",
            "ms": 14_950,
        }

    def test_playback_started_for_unknown_segment_id_is_dropped_silently(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeIdleSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_json(
                {"type": "playback_started", "segmentId": "no-such-segment", "clientTime": 1_000}
            )
            # No stored speech_end for that segmentId -- dropped silently
            # rather than erroring or crashing the session. Prove it by
            # sending a second, well-formed message and confirming the
            # very next message off the wire is its response (not a stray
            # `latency` message the bogus report shouldn't have produced).
            ws.send_json({"type": "clock_sync", "clientTime": 2_000})
            ack = json.loads(ws.receive()["text"])

        assert ack["type"] == "clock_sync_ack"
        assert ack["clientTime"] == 2_000


# ---------------------------------------------------------------------------
# Ticket 6: start-of-session tuning and non-connection-level live apply
# ---------------------------------------------------------------------------


def _tuning_message(**cascade: object) -> dict:
    """A `ModeTuningConfig` wire document carrying only the cascade fields a
    test cares about. Everything absent is what a tolerant parse should fill
    from the configuration already in force, which is the point."""
    return {
        "schemaVersion": 1,
        "mode": "cascade",
        "client": {},
        "cascade": dict(cascade),
    }


def _expected_fingerprint(cascade: CascadeTuning) -> str:
    """What the client computes for the same document -- the fingerprint the
    server reports has to agree with it, or the panel and the pipeline are
    silently describing different configs."""
    return fingerprint(CascadeModeTuning(client=ClientTuning(), cascade=cascade), "cascade")


def _with_endpointing(endpointing_ms: int) -> CascadeTuning:
    """The default config with one connection-level knob moved -- the
    smallest change that can only be applied by reopening Deepgram's
    socket."""
    cascade = default_cascade_tuning()
    return cascade.model_copy(
        update={"deepgram": cascade.deepgram.model_copy(update={"endpointing_ms": endpointing_ms})}
    )


def _receive_until(ws, message_type: str, limit: int = 25) -> dict:
    """The next message of `message_type`, skipping whatever pipeline
    traffic precedes it -- lets a tuning test assert on one message without
    restating the full per-segment message sequence (already pinned by
    `test_full_pipeline_message_sequence`)."""
    for _ in range(limit):
        raw = ws.receive()
        if _message_kind(raw) == message_type:
            return raw
    raise AssertionError(f"no {message_type!r} message within {limit} messages")


class _RecordingSTT:
    """Records every `stream()` call's `params`, and turns each audio frame
    the client sends into one finished segment -- so a test can put an
    `update_tuning` *between* two segments deterministically, and see
    whether the STT connection was reopened (a second `params` entry) or
    not."""

    calls: ClassVar[list] = []

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        type(self).calls.append(params)
        async for _ in audio_chunks:
            yield TranscriptSegment(text="hello", is_final=True, speech_final=True)


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


class _SpeechFinalThenUtteranceEndSTT:
    """One `speech_final` result followed by an `UtteranceEnd`: in `hybrid`
    the first cuts the segment, in `llm_priority` it's ignored and the
    second does -- so `segment_boundary.trigger` alone reports which
    segmentation mode was actually in force."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del audio_chunks, languages, params
        yield TranscriptSegment(text="hello", is_final=True, speech_final=True)
        yield UtteranceEndSignal()


@pytest.fixture()
def recording_providers(monkeypatch):
    """The three recording fakes wired in, with their class-level records
    cleared -- returns them so a test can assert on what each stage was
    handed."""
    _RecordingSTT.calls = []
    _RecordingTranslation.models = []
    _RecordingTTS.voices = []
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _RecordingSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _RecordingTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _RecordingTTS)
    return _RecordingSTT, _RecordingTranslation, _RecordingTTS


class TestSessionStartTuning:
    def test_session_opens_with_the_fingerprint_of_the_config_in_force(
        self, client, recording_providers
    ):
        """The unsolicited `tuning_applied` right after `session_started`:
        the panel shows the *server's* fingerprint, so the two can never
        silently disagree."""
        with client.websocket_connect("/ws/cascade") as ws:
            ws.send_json({"type": "start_session", "languages": ["en", "es"]})
            assert json.loads(ws.receive()["text"])["type"] == "session_started"
            applied = json.loads(ws.receive()["text"])

        assert applied == {
            "type": "tuning_applied",
            "requestId": None,
            "fingerprint": _expected_fingerprint(default_cascade_tuning()),
            "reconnectedStt": False,
        }

    def test_start_session_tuning_reaches_the_deepgram_connection(
        self, client, recording_providers
    ):
        """S6: `start_session.tuning` is what the STT connection is opened
        with -- `endpointingMs: 300` reaches `DeepgramParams`, which
        `test_providers.py` pins to `endpointing=300` in the URL."""
        stt, _, _ = recording_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(
                    deepgram={"model": "nova-2", "endpointingMs": 300, "diarize": False}
                ),
            )
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "binary_audio")

        assert stt.calls == [
            orchestrator.DeepgramParams(
                model="nova-2", endpointing_ms=300, utterance_end_ms=3000, diarize=False
            )
        ]

    def test_start_session_tuning_selects_the_segmentation_mode(self, client, monkeypatch):
        """S6's other half: `llm_priority` from the tuning document makes
        `speech_final` stop cutting segments."""
        monkeypatch.setattr(
            orchestrator, "DeepgramSTTProvider", _SpeechFinalThenUtteranceEndSTT
        )
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(segmentation={"mode": "llm_priority"}),
            )
            ws.send_bytes(b"\x00\x01")
            boundary = json.loads(_receive_until(ws, "segment_boundary")["text"])

        assert boundary["trigger"] == "deepgram_utterance_end"

    def test_legacy_segmentation_mode_is_honoured_when_no_tuning_is_sent(
        self, client, monkeypatch
    ):
        """The `?segMode=` dev override still works on its own."""
        monkeypatch.setattr(
            orchestrator, "DeepgramSTTProvider", _SpeechFinalThenUtteranceEndSTT
        )
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"], segmentationMode="llm_priority")
            ws.send_bytes(b"\x00\x01")
            boundary = json.loads(_receive_until(ws, "segment_boundary")["text"])

        assert boundary["trigger"] == "deepgram_utterance_end"

    def test_tuning_wins_over_the_legacy_segmentation_mode(self, client, monkeypatch):
        """Both present: the tuning document decides, even where -- as here
        -- it decides by saying nothing and leaving the default in place."""
        monkeypatch.setattr(
            orchestrator, "DeepgramSTTProvider", _SpeechFinalThenUtteranceEndSTT
        )
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                segmentationMode="llm_priority",
                tuning=_tuning_message(),
            )
            ws.send_bytes(b"\x00\x01")
            boundary = json.loads(_receive_until(ws, "segment_boundary")["text"])

        assert boundary["trigger"] == "deepgram_speech_final"

    def test_out_of_allow_list_values_fall_back_and_keep_the_session_alive(
        self, client, recording_providers, caplog
    ):
        """F4: a model this server never offered falls back to the default
        and logs, rather than 400-ing or closing a live session (AC 5.7)."""
        stt, translation, _ = recording_providers

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(
                    deepgram={"model": "whisper-9", "endpointingMs": 99_999},
                    translationModel="gpt-9",
                ),
            )
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "binary_audio")

        assert stt.calls == [orchestrator.DeepgramParams()]
        assert translation.models == [default_cascade_tuning().translation_model]
        rejected = [record.message for record in caplog.records if "rejected" in record.message]
        assert len(rejected) == 3

    def test_unsupported_schema_version_falls_back_to_defaults(
        self, client, recording_providers, caplog
    ):
        """F5 (WS half): the HTTP endpoint 400s on `schemaVersion: 2`; the
        WebSocket keeps the session and runs on the defaults."""
        stt, _, _ = recording_providers
        tuning = _tuning_message(deepgram={"endpointingMs": 300})
        tuning["schemaVersion"] = 2

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(ws, languages=["en", "es"], tuning=tuning)
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "binary_audio")

        assert stt.calls == [orchestrator.DeepgramParams()]
        assert any("schemaVersion" in record.message for record in caplog.records)


class TestLiveApply:
    def test_non_connection_level_update_applies_to_the_next_segment(
        self, client, recording_providers
    ):
        """S8: the translation model and TTS voices are read per segment, so
        the reply is `tuning_applied{reconnectedStt: false}` and the STT
        connection is never reopened -- `stt.calls` stays at one entry."""
        stt, translation, tts = recording_providers
        updated = default_cascade_tuning().model_copy(
            update={
                "translation_model": "gpt-4.1-mini",
                "tts_voice_a": settings.elevenlabs_voice_id_speaker_b,
            }
        )

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "binary_audio")

            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-1",
                    "tuning": _tuning_message(
                        translationModel="gpt-4.1-mini",
                        ttsVoiceA=settings.elevenlabs_voice_id_speaker_b,
                    ),
                }
            )
            applied = json.loads(_receive_until(ws, "tuning_applied")["text"])

            ws.send_bytes(b"\x02\x03")
            _receive_until(ws, "binary_audio")

        assert applied == {
            "type": "tuning_applied",
            "requestId": "req-1",
            "fingerprint": _expected_fingerprint(updated),
            "reconnectedStt": False,
        }
        assert len(stt.calls) == 1  # no reconnect: same connection throughout
        assert translation.models == [
            default_cascade_tuning().translation_model,
            "gpt-4.1-mini",
        ]
        assert tts.voices == [
            settings.elevenlabs_voice_id,
            settings.elevenlabs_voice_id_speaker_b,
        ]

    def test_unknown_update_tuning_fields_are_ignored(self, client, recording_providers):
        """E16: a newer panel's extra keys are dropped, not rejected -- the
        fields this server does know still apply."""
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            tuning = _tuning_message(translationModel="gpt-4.1-nano", futureKnob=True)
            tuning["cascade"]["deepgram"] = {"model": "nova-3", "futureKnob": 7}
            tuning["somethingElse"] = {"nested": 1}
            ws.send_json({"type": "update_tuning", "requestId": "req-2", "tuning": tuning})
            applied = json.loads(_receive_until(ws, "tuning_applied")["text"])

        assert applied["requestId"] == "req-2"
        assert applied["fingerprint"] == _expected_fingerprint(
            default_cascade_tuning().model_copy(update={"translation_model": "gpt-4.1-nano"})
        )

    def test_update_tuning_with_a_bad_value_keeps_the_session_and_the_old_value(
        self, client, recording_providers, caplog
    ):
        """F4's live-apply half: the Apply still succeeds, minus the field
        that couldn't be honoured."""
        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(ws, languages=["en", "es"])
            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-3",
                    "tuning": _tuning_message(translationModel="gpt-9"),
                }
            )
            applied = json.loads(_receive_until(ws, "tuning_applied")["text"])

        assert applied["fingerprint"] == _expected_fingerprint(default_cascade_tuning())
        assert any("cascade.translationModel" in record.message for record in caplog.records)

    def test_connection_level_update_reopens_the_stt_connection(
        self, client, recording_providers
    ):
        """The other half of S8's contrast: `endpointingMs` can only change
        on a new Deepgram socket, so this Apply *does* reopen one and is
        answered `reconnectedStt: true`. What that reconnect does to the
        audio in flight is `TestConnectionLevelReconnect`'s subject."""
        stt, _, _ = recording_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")
            _receive_until(ws, "binary_audio")

            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-4",
                    "tuning": _tuning_message(deepgram={"endpointingMs": 300}),
                }
            )
            ws.send_bytes(b"\x02\x03")
            applied = json.loads(_receive_until(ws, "tuning_applied")["text"])

        assert applied == {
            "type": "tuning_applied",
            "requestId": "req-4",
            "fingerprint": _expected_fingerprint(_with_endpointing(300)),
            "reconnectedStt": True,
        }
        assert stt.calls == [
            orchestrator.DeepgramParams(),
            orchestrator.DeepgramParams(endpointing_ms=300),
        ]


class _CollectingOutgoing:
    """`_OutgoingSocket`-shaped double for the handler-level tests below,
    which are about `_SessionTuning`'s state rather than the wire."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class TestUpdateTuningHandler:
    """`_handle_update_tuning` directly: the `pending`/`request_id` state and
    the queued `_RECONNECT` sentinel a WebSocket test can't see, and which
    `_run_stt`'s reconnect consumes."""

    @pytest.mark.asyncio
    async def test_connection_level_change_is_parked_and_sentinelled(self):
        state = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        outgoing = _CollectingOutgoing()
        audio_queue: asyncio.Queue = asyncio.Queue()
        audio_queue.put_nowait(b"already enqueued")

        await orchestrator._handle_update_tuning(
            {
                "type": "update_tuning",
                "requestId": "req-5",
                "tuning": _tuning_message(deepgram={"endpointingMs": 300}),
            },
            state,
            audio_queue,
            outgoing,
        )

        assert state.pending is not None
        assert state.pending.deepgram.endpointing_ms == 300
        assert state.request_id == "req-5"
        # Not applied yet, and the revert target is untouched: the Apply
        # only lands when `_run_stt` promotes it.
        assert state.current == state.previous == default_cascade_tuning()
        # No reply yet either -- and the sentinel sits *behind* the frame
        # that was already queued, which is what makes it a boundary rather
        # than an interrupt.
        assert outgoing.sent == []
        assert audio_queue.get_nowait() == b"already enqueued"
        assert audio_queue.get_nowait() is orchestrator._RECONNECT
        assert audio_queue.empty()

    @pytest.mark.asyncio
    async def test_second_apply_coalesces_into_the_single_pending_slot(self):
        """One slot, last write wins, and only one sentinel -- which is what
        makes two Applies landing before the socket closes produce one
        reconnect rather than two (E4)."""
        state = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        outgoing = _CollectingOutgoing()
        audio_queue: asyncio.Queue = asyncio.Queue()

        for request_id, endpointing in (("req-6", 300), ("req-7", 400)):
            await orchestrator._handle_update_tuning(
                {
                    "requestId": request_id,
                    "tuning": _tuning_message(deepgram={"endpointingMs": endpointing}),
                },
                state,
                audio_queue,
                outgoing,
            )

        assert state.pending is not None
        assert state.pending.deepgram.endpointing_ms == 400
        assert state.request_id == "req-7"
        assert audio_queue.get_nowait() is orchestrator._RECONNECT
        assert audio_queue.empty()

    @pytest.mark.asyncio
    async def test_a_non_connection_level_apply_rides_along_with_a_parked_reconnect(self):
        """A knob that needs no reconnect, changed while one is already
        parked, goes into the same slot: promoting `pending` must not throw
        away a change made after it was parked."""
        state = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        outgoing = _CollectingOutgoing()
        audio_queue: asyncio.Queue = asyncio.Queue()

        await orchestrator._handle_update_tuning(
            {"requestId": "req-8a", "tuning": _tuning_message(deepgram={"endpointingMs": 300})},
            state,
            audio_queue,
            outgoing,
        )
        await orchestrator._handle_update_tuning(
            {"requestId": "req-8b", "tuning": _tuning_message(translationModel="gpt-4.1-mini")},
            state,
            audio_queue,
            outgoing,
        )

        assert state.pending is not None
        assert state.pending.deepgram.endpointing_ms == 300
        assert state.pending.translation_model == "gpt-4.1-mini"
        assert outgoing.sent == []
        assert audio_queue.get_nowait() is orchestrator._RECONNECT
        assert audio_queue.empty()

    @pytest.mark.asyncio
    async def test_missing_request_id_is_reported_as_null(self):
        state = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        outgoing = _CollectingOutgoing()

        await orchestrator._handle_update_tuning(
            {"tuning": _tuning_message(translationModel="gpt-4.1-mini")},
            state,
            asyncio.Queue(),
            outgoing,
        )

        assert outgoing.sent == [
            {
                "type": "tuning_applied",
                "requestId": None,
                "fingerprint": _expected_fingerprint(
                    default_cascade_tuning().model_copy(
                        update={"translation_model": "gpt-4.1-mini"}
                    )
                ),
                "reconnectedStt": False,
            }
        ]


class TestParseCascadeTuning:
    """`_parse_cascade_tuning`'s tolerance, field by field -- the WebSocket
    tests above prove it's wired in; these prove what it does."""

    def _parse(self, raw: object) -> CascadeTuning:
        cascade, _ = orchestrator._parse_cascade_tuning(
            raw, cascade=default_cascade_tuning(), client=ClientTuning()
        )
        return cascade

    def test_absent_tuning_keeps_the_config_in_force(self):
        assert self._parse(None) == default_cascade_tuning()

    def test_a_bad_field_costs_only_that_field(self):
        parsed = self._parse(
            _tuning_message(
                deepgram={"endpointingMs": "loud", "model": "nova-2"},
                segmentation={"mode": "vibes"},
                translationModel="gpt-4.1-mini",
            )
        )

        assert parsed.deepgram.endpointing_ms == default_cascade_tuning().deepgram.endpointing_ms
        assert parsed.segmentation.mode == "hybrid"
        assert parsed.deepgram.model == "nova-2"
        assert parsed.translation_model == "gpt-4.1-mini"

    def test_out_of_range_numbers_keep_the_value_in_force(self):
        parsed = self._parse(
            _tuning_message(deepgram={"endpointingMs": -1, "utteranceEndMs": 900})
        )

        assert parsed.deepgram.endpointing_ms == 500
        assert parsed.deepgram.utterance_end_ms == 3000

    def test_a_voice_this_server_cannot_speak_with_is_refused(self):
        parsed = self._parse(_tuning_message(ttsVoiceB="some-other-voice-id"))

        assert parsed.tts_voice_b == settings.elevenlabs_voice_id_speaker_b

    def test_a_document_that_is_not_an_object_is_ignored_whole(self):
        assert self._parse("nova-2") == default_cascade_tuning()

    def test_the_reported_fingerprint_matches_the_cross_language_fixture(self, monkeypatch):
        """The fingerprint the panel is shown has to be the one the browser
        computed for the same document, so this hashes a case from
        `shared/tuning-fingerprint-cases.json` -- the file
        `tuningConfig.test.ts` reads too -- through the session's own
        reporting path. `settings` is pointed at the fixture's voices first,
        since a voice this server can't speak with is (correctly) refused."""
        case = next(
            c
            for c in json.loads(
                (
                    Path(__file__).resolve().parents[2]
                    / "shared"
                    / "tuning-fingerprint-cases.json"
                ).read_text(encoding="utf-8")
            )
            if c["mode"] == "cascade" and c["config"]["schemaVersion"] == 1
        )
        config = case["config"]
        monkeypatch.setattr(settings, "elevenlabs_voice_id", config["cascade"]["ttsVoiceA"])
        monkeypatch.setattr(
            settings, "elevenlabs_voice_id_speaker_b", config["cascade"]["ttsVoiceB"]
        )

        cascade, client = orchestrator._parse_cascade_tuning(
            {
                "schemaVersion": 1,
                "mode": "cascade",
                "client": config["client"],
                "cascade": config["cascade"],
            },
            cascade=default_cascade_tuning(),
            client=ClientTuning(),
        )

        state = orchestrator._SessionTuning(cascade, client)
        assert state.current_fingerprint() == case["expectedFingerprint"]

    def test_the_client_block_round_trips_into_the_fingerprint(self):
        """The server never acts on the `client` block, but it is inside the
        hash, so it has to survive the parse or the fingerprint the panel
        sees won't be the one it computed."""
        state = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        document = _tuning_message()
        document["client"] = {"rmsGate": {"enabled": True, "thresholdDbfs": -30}}

        cascade, client = orchestrator._parse_cascade_tuning(
            document, cascade=state.current, client=state.client
        )
        state.current, state.client = cascade, client

        assert client.rms_gate.enabled is True
        assert state.current_fingerprint() == fingerprint(
            CascadeModeTuning(client=client, cascade=cascade), "cascade"
        )
        assert state.current_fingerprint() != _expected_fingerprint(default_cascade_tuning())


# ---------------------------------------------------------------------------
# Ticket 07: the deliberate Deepgram reconnect for a connection-level Apply
# ---------------------------------------------------------------------------


@dataclass
class _SttConnection:
    """One `stream()` call: the `DeepgramParams` it was opened with, and
    every audio frame that connection actually received."""

    params: object
    frames: list[bytes] = field(default_factory=list)


class _ConnectionRecordingSTT:
    """Records an `_SttConnection` per `stream()` call and turns each frame
    into one finished segment whose text *is* that frame, so a test can tell
    from the transcript alone which connection got which frame.

    `failures[i]`, when set, is the `ProviderErrorKind` the i-th connection
    raises instead of yielding -- at connect time, before any frame is
    consumed, the same way `deepgram_stt.py` fails when `websockets.connect`
    is rejected."""

    connections: ClassVar[list[_SttConnection]] = []
    failures: ClassVar[list[object]] = []

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        index = len(type(self).connections)
        connection = _SttConnection(params)
        type(self).connections.append(connection)
        kind = type(self).failures[index] if index < len(type(self).failures) else None
        if kind is not None:
            raise ProviderError(kind, "deepgram", "fake connect failure", retryable=True)
        async for chunk in audio_chunks:
            connection.frames.append(chunk)
            yield TranscriptSegment(text=chunk.decode(), is_final=True, speech_final=True)


class _FrameEchoSTT:
    """`_ConnectionRecordingSTT`'s instance-level twin, for the tests that
    drive `_run_stt` directly instead of the route (so per-connection state
    doesn't have to live on the class)."""

    def __init__(self) -> None:
        self.connections: list[_SttConnection] = []

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        connection = _SttConnection(params)
        self.connections.append(connection)
        async for chunk in audio_chunks:
            connection.frames.append(chunk)
            yield TranscriptSegment(text=chunk.decode(), is_final=True, speech_final=True)


class _PartialSegmentSTT(_FrameEchoSTT):
    """Finalises words without ever ending the utterance
    (`speech_final=False`), so a segment is always in flight when the
    reconnect happens."""

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        connection = _SttConnection(params)
        self.connections.append(connection)
        async for chunk in audio_chunks:
            connection.frames.append(chunk)
            yield TranscriptSegment(text=chunk.decode(), is_final=True, speech_final=False)


class _GatedCloseSTT(_FrameEchoSTT):
    """Waits for the test to release it once its audio iterator has ended,
    standing in for the real socket's close handshake -- the window in which
    a second Apply coalesces into the reconnect already under way."""

    def __init__(self) -> None:
        super().__init__()
        self.closing = asyncio.Event()
        self._closed = asyncio.Event()

    def release(self) -> None:
        self._closed.set()

    async def stream(self, audio_chunks, *, languages, params=None):
        del languages
        connection = _SttConnection(params)
        self.connections.append(connection)
        async for chunk in audio_chunks:
            connection.frames.append(chunk)
            yield TranscriptSegment(text=chunk.decode(), is_final=True, speech_final=True)
        self.closing.set()
        await self._closed.wait()


@pytest.fixture()
def reconnect_providers(monkeypatch):
    """`_ConnectionRecordingSTT` wired in with its class-level records
    cleared, plus the two downstream fakes the pipeline needs to keep
    running."""
    _ConnectionRecordingSTT.connections = []
    _ConnectionRecordingSTT.failures = []
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _ConnectionRecordingSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)
    return _ConnectionRecordingSTT


def _drain_until(ws, matches, limit: int = 80) -> list[dict]:
    """Every JSON message up to and including the first one `matches`
    accepts (binary TTS frames skipped) -- these tests assert on the *order*
    of several messages, not just one, which `_receive_until` throws away."""
    messages: list[dict] = []
    for _ in range(limit):
        raw = ws.receive()
        if raw.get("bytes") is not None:
            continue
        payload = json.loads(raw["text"])
        messages.append(payload)
        if matches(payload):
            return messages
    raise AssertionError(f"no matching message within {limit} messages: {messages}")


def _transcript(text: str):
    return lambda message: message["type"] == "source_transcript" and message["text"] == text


class _QueueingOutgoing:
    """`_OutgoingSocket`-shaped double that also queues every message, so the
    `_run_stt`-level tests below can await the next one of a given kind
    deterministically instead of racing real time (same pattern as
    `test_segmentation.py`)."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.queue: asyncio.Queue[dict] = asyncio.Queue()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)
        self.queue.put_nowait(payload)


class _NeverCompleteChecker:
    """Segmentation clause-check that never cuts -- keeps these tests about
    the reconnect rather than Ticket 5's race."""

    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del text, language, model
        return False


async def _await_message(outgoing: _QueueingOutgoing, matches) -> dict:
    while True:
        message = await asyncio.wait_for(outgoing.queue.get(), timeout=2)
        if matches(message):
            return message


def _start_run_stt(stt_provider, tuning, audio_queue):
    """`orchestrator._run_stt` as a background task over real (not faked)
    bookkeeping objects -- the seam `test_segmentation.py` already uses, and
    the only one from which a test can drive `audio_queue` and
    `_handle_update_tuning` in the same event loop as the reconnect."""
    outgoing = _QueueingOutgoing()
    segment_queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(
        orchestrator._run_stt(
            stt_provider,
            audio_queue,
            segment_queue,
            outgoing,
            orchestrator._LatencyTracker(),
            "en",
            "es",
            orchestrator._CircuitBreaker(),
            _NeverCompleteChecker(),
            tuning,
        )
    )
    return task, outgoing, segment_queue


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    with contextlib.suppress(BaseException):
        await task


async def _apply(tuning, audio_queue, outgoing, request_id: str, **cascade) -> None:
    await orchestrator._handle_update_tuning(
        {"type": "update_tuning", "requestId": request_id, "tuning": _tuning_message(**cascade)},
        tuning,
        audio_queue,
        outgoing,
    )


class TestConnectionLevelReconnect:
    """S9/E4/E6/F6: applying a connection-level knob by deliberately
    reopening Deepgram's socket, without losing a frame or a segment."""

    def test_no_frame_is_dropped_or_duplicated_across_the_reconnect(
        self, client, reconnect_providers
    ):
        """S9: frames A,B -> connection-level Apply -> frames C,D. The first
        connection got exactly A,B, the second exactly C,D, the second was
        opened with the new endpointing, and `tuning_applied` went out once,
        after the second connection's first result proved it works."""
        stt = reconnect_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"A")
            ws.send_bytes(b"B")
            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-s9",
                    "tuning": _tuning_message(deepgram={"endpointingMs": 300}),
                }
            )
            ws.send_bytes(b"C")
            ws.send_bytes(b"D")
            messages = _drain_until(ws, _transcript("D"))

        assert [connection.frames for connection in stt.connections] == [
            [b"A", b"B"],
            [b"C", b"D"],
        ]
        assert stt.connections[0].params == orchestrator.DeepgramParams()
        assert stt.connections[1].params == orchestrator.DeepgramParams(endpointing_ms=300)

        assert [message for message in messages if message["type"] == "tuning_applied"] == [
            {
                "type": "tuning_applied",
                "requestId": "req-s9",
                "fingerprint": _expected_fingerprint(_with_endpointing(300)),
                "reconnectedStt": True,
            }
        ]
        # Ordering, not just presence: the reply lands between the old
        # connection's last transcript and the new one's first.
        assert [
            message["text"] if message["type"] == "source_transcript" else message["type"]
            for message in messages
            if message["type"] in ("source_transcript", "tuning_applied")
        ] == ["A", "B", "tuning_applied", "C", "D"]

    def test_every_failed_reconnect_attempt_is_reported_then_the_old_params_come_back(
        self, client, reconnect_providers, caplog
    ):
        """F6: the new parameters fail to connect for the whole retry
        budget. Each attempt is logged *and* sent as `tuning_failed`; then
        the session reverts to the parameters the client still believes are
        live and keeps transcribing -- including the frame that was queued
        behind the sentinel the whole time."""
        stt = reconnect_providers
        stt.failures = [None, ProviderErrorKind.TIMEOUT, ProviderErrorKind.TIMEOUT]

        with (
            caplog.at_level(logging.WARNING, logger="app.orchestrator"),
            client.websocket_connect("/ws/cascade") as ws,
        ):
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"A")
            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-f6",
                    "tuning": _tuning_message(deepgram={"endpointingMs": 300}),
                }
            )
            ws.send_bytes(b"C")
            messages = _drain_until(ws, _transcript("C"))

        assert [message for message in messages if message["type"] == "tuning_failed"] == [
            {
                "type": "tuning_failed",
                "requestId": "req-f6",
                "attempt": 1,
                "maxAttempts": 2,
                "message": "The provider took too long to respond.",
            },
            {
                "type": "tuning_failed",
                "requestId": "req-f6",
                "attempt": 2,
                "maxAttempts": 2,
                "message": "The provider took too long to respond.",
            },
        ]
        assert not [message for message in messages if message["type"] == "error"]
        assert not [message for message in messages if message["type"] == "tuning_applied"]

        logged = [record.getMessage() for record in caplog.records]
        assert [line for line in logged if "tuning reconnect attempt" in line] == [
            "tuning reconnect attempt 1/2 failed (TIMEOUT) for request req-f6",
            "tuning reconnect attempt 2/2 failed (TIMEOUT) for request req-f6",
        ]

        assert [connection.params for connection in stt.connections] == [
            orchestrator.DeepgramParams(),
            orchestrator.DeepgramParams(endpointing_ms=300),
            orchestrator.DeepgramParams(endpointing_ms=300),
            orchestrator.DeepgramParams(),  # reverted, and still running
        ]
        # The frame sent during the failed reconnect was never handed to a
        # connection that couldn't take it.
        assert stt.connections[3].frames == [b"C"]

    def test_a_reverted_reconnect_that_also_fails_ends_in_the_terminal_error(
        self, client, reconnect_providers
    ):
        """F6's tail: reverting is not a second retry mechanism. If the
        connection with the *previous* parameters fails too, that's an
        ordinary lost STT connection and takes the terminal path unchanged."""
        stt = reconnect_providers
        stt.failures = [None, ProviderErrorKind.CONNECTION, ProviderErrorKind.CONNECTION]

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"A")
            ws.send_json(
                {
                    "type": "update_tuning",
                    "requestId": "req-f6b",
                    "tuning": _tuning_message(deepgram={"endpointingMs": 300}),
                }
            )
            messages = _drain_until(ws, lambda message: message["type"] == "error")

        assert [message for message in messages if message["type"] == "tuning_failed"] == [
            {
                "type": "tuning_failed",
                "requestId": "req-f6b",
                "attempt": 1,
                "maxAttempts": 1,
                "message": "The connection to the provider was lost.",
            }
        ]
        assert messages[-1] == {
            "type": "error",
            "provider": "deepgram",
            "kind": "CONNECTION",
            "message": "The connection to the provider was lost.",
            "retryable": True,
        }
        assert len(stt.connections) == 3

    @pytest.mark.asyncio
    async def test_two_applies_before_the_socket_closes_produce_one_reconnect(self):
        """E4: the second Apply lands while the first reconnect is still in
        flight (the window a real socket's close handshake opens). One
        sentinel, two connections total, and the later config is the one
        that reaches Deepgram and the fingerprint."""
        stt = _GatedCloseSTT()
        tuning = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        audio_queue: asyncio.Queue = asyncio.Queue()
        task, outgoing, _ = _start_run_stt(stt, tuning, audio_queue)

        audio_queue.put_nowait(b"A")
        await _await_message(outgoing, _transcript("A"))

        await _apply(tuning, audio_queue, outgoing, "req-e4a", deepgram={"endpointingMs": 300})
        await asyncio.wait_for(stt.closing.wait(), timeout=2)
        await _apply(tuning, audio_queue, outgoing, "req-e4b", deepgram={"endpointingMs": 400})
        stt.release()

        audio_queue.put_nowait(b"B")
        applied = await _await_message(outgoing, lambda m: m["type"] == "tuning_applied")

        assert applied == {
            "type": "tuning_applied",
            "requestId": "req-e4b",
            "fingerprint": _expected_fingerprint(_with_endpointing(400)),
            "reconnectedStt": True,
        }
        assert [connection.params for connection in stt.connections] == [
            orchestrator.DeepgramParams(),
            orchestrator.DeepgramParams(endpointing_ms=400),
        ]
        assert audio_queue.empty()  # the second Apply added no second sentinel
        await _stop(task)

    @pytest.mark.asyncio
    async def test_the_partial_in_flight_is_cut_as_a_tuning_reconnect_segment(self):
        """E6: the words Deepgram had already finalised but not yet cut
        become a real segment with `trigger: "tuning_reconnect"`, exactly
        once, rather than dying with the connection."""
        stt = _PartialSegmentSTT()
        tuning = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        audio_queue: asyncio.Queue = asyncio.Queue()
        task, outgoing, segment_queue = _start_run_stt(stt, tuning, audio_queue)

        audio_queue.put_nowait(b"hello")
        await _await_message(outgoing, _transcript("hello"))

        await _apply(tuning, audio_queue, outgoing, "req-e6", deepgram={"endpointingMs": 300})
        audio_queue.put_nowait(b"world")

        boundary = await _await_message(outgoing, lambda m: m["type"] == "segment_boundary")
        completed = await asyncio.wait_for(segment_queue.get(), timeout=2)
        await _await_message(outgoing, _transcript("world"))

        assert boundary["trigger"] == "tuning_reconnect"
        assert completed.segment_id == boundary["segmentId"]
        assert completed.text == "hello"
        # Nothing double-cut: one boundary, one completed segment, and the
        # new connection's words are accumulating into a fresh segment id.
        assert [m for m in outgoing.sent if m["type"] == "segment_boundary"] == [boundary]
        assert segment_queue.empty()
        transcript_ids = [
            m["segmentId"] for m in outgoing.sent if m["type"] == "source_transcript"
        ]
        assert transcript_ids[0] == completed.segment_id
        assert transcript_ids[1] != completed.segment_id
        await _stop(task)

    @pytest.mark.asyncio
    async def test_the_sentinel_survives_frames_enqueued_in_the_same_event_loop_turn(self):
        """The sharp edge this whole design exists for: a burst of frames
        put on the queue on either side of the sentinel, with no chance for
        `_run_stt` to run in between, still splits exactly at the sentinel
        with nothing dropped and nothing duplicated. (An `asyncio.Event`
        raced against `queue.get()` loses an item here.)"""
        stt = _FrameEchoSTT()
        tuning = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        audio_queue: asyncio.Queue = asyncio.Queue()
        task, outgoing, _ = _start_run_stt(stt, tuning, audio_queue)

        before = [f"before-{i}".encode() for i in range(10)]
        after = [f"after-{i}".encode() for i in range(10)]
        for frame in before:
            audio_queue.put_nowait(frame)
        await _apply(tuning, audio_queue, outgoing, "req-race", deepgram={"endpointingMs": 300})
        for frame in after:
            audio_queue.put_nowait(frame)

        await _await_message(outgoing, _transcript("after-9"))

        assert [connection.frames for connection in stt.connections] == [before, after]
        await _stop(task)


# ---------------------------------------------------------------------------
# Ticket 14: the per-segment transcript check (off / flag / correct)
# ---------------------------------------------------------------------------

# A classic ASR homophone failure and what it should have said -- the thing
# the check exists to catch, so a test can tell the two texts apart wherever
# one of them turns up.
MISHEARD = "wreck a nice beach"
CORRECTED = "recognise speech"


class _MisheardSTT:
    """One finished segment carrying `MISHEARD`, cut by `speech_final`."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages, params=None):
        del audio_chunks, languages, params
        yield TranscriptSegment(text=MISHEARD, is_final=True, speech_final=True)


class _ScriptedChecker:
    """Fake `TranscriptChecker`: records every call and answers with whatever
    `result` the test scripted.

    When `gate` is set, `check` waits on it, and `_GateReleasingTranslation`
    below is what releases it -- that pairing is how the `flag` test proves
    translation starts *before* the verdict rather than measuring a delay.
    The wait is bounded so an implementation that awaited a `flag` check
    would fail the ordering assertion instead of hanging the suite.
    """

    calls: ClassVar[list[dict]] = []
    result: ClassVar[TranscriptCheckResult] = TranscriptCheckResult(False, None, False)
    gate: ClassVar[asyncio.Event | None] = None

    def __init__(self, api_key: str, model: str = "gpt-4o-mini") -> None:
        pass

    async def check(self, text, language, mode, *, model=None):
        type(self).calls.append(
            {"text": text, "language": language, "mode": mode, "model": model}
        )
        gate = type(self).gate
        if gate is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(gate.wait(), timeout=2)
        return type(self).result


class _GateReleasingTranslation:
    """Records the text it was asked to translate -- the whole question
    `correct` mode answers -- and releases `_ScriptedChecker.gate` on its way
    past."""

    texts: ClassVar[list[str]] = []

    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang, model=None):
        del source_lang, target_lang, model
        type(self).texts.append(source_text)
        if _ScriptedChecker.gate is not None:
            _ScriptedChecker.gate.set()
        yield "Hola"


@pytest.fixture()
def transcript_check_providers(monkeypatch):
    """The scripted checker wired in over the conftest stub, with a
    translation provider that records what it was handed. Returns the checker
    class so a test can script its verdict."""
    _ScriptedChecker.calls = []
    _ScriptedChecker.result = TranscriptCheckResult(
        flagged=False, corrected_text=None, failed=False
    )
    _ScriptedChecker.gate = None
    _GateReleasingTranslation.texts = []
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _MisheardSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _GateReleasingTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)
    monkeypatch.setattr(orchestrator, "TranscriptChecker", _ScriptedChecker)
    return _ScriptedChecker


def _check_latencies(messages: list[dict]) -> list[dict]:
    return [m for m in messages if m["type"] == "latency" and m["stage"] == "transcript_check"]


def _flagged_transcripts(messages: list[dict]) -> list[dict]:
    return [m for m in messages if m["type"] == "source_transcript" and "flagged" in m]


class TestTranscriptCheck:
    """S26/S27/F8/F9: the check's three modes and its failure posture."""

    def test_correct_mode_translates_the_rewrite_and_re_sends_the_transcript(
        self, client, transcript_check_providers
    ):
        """S26: the rewritten text is what reaches `translate`, the re-sent
        `source_transcript` carries it plus `correctedFrom`, and one
        `transcript_check` latency message is emitted."""
        checker = transcript_check_providers
        checker.result = TranscriptCheckResult(
            flagged=True, corrected_text=CORRECTED, failed=False
        )

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(
                    transcriptCheck={"mode": "correct", "model": "gpt-4.1-mini"}
                ),
            )
            ws.send_bytes(b"\x00\x01")
            messages = _drain_until(
                ws, lambda m: m["type"] == "target_transcript" and m["isFinal"]
            )

        assert _GateReleasingTranslation.texts == [CORRECTED]
        segment_id = messages[0]["segmentId"]
        assert _flagged_transcripts(messages) == [
            {
                "type": "source_transcript",
                "segmentId": segment_id,
                "text": CORRECTED,
                "isFinal": True,
                "speaker": None,
                "flagged": True,
                "correctedFrom": MISHEARD,
            }
        ]
        assert checker.calls == [
            {
                "text": MISHEARD,
                "language": "en",
                "mode": "correct",
                "model": "gpt-4.1-mini",
            }
        ]
        latencies = _check_latencies(messages)
        assert len(latencies) == 1, messages
        assert latencies[0]["segmentId"] == segment_id
        assert isinstance(latencies[0]["ms"], int)

    def test_correct_mode_flags_a_suspicious_segment_it_could_not_improve(
        self, client, transcript_check_providers
    ):
        """A verdict of "suspicious, but nothing to rewrite" still earns the
        badge: the original text is translated, and the re-send carries
        `flagged` without a `correctedFrom` (there is no before/after to
        report)."""
        checker = transcript_check_providers
        checker.result = TranscriptCheckResult(
            flagged=True, corrected_text=None, failed=False
        )

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(transcriptCheck={"mode": "correct"}),
            )
            ws.send_bytes(b"\x00\x01")
            messages = _drain_until(
                ws, lambda m: m["type"] == "target_transcript" and m["isFinal"]
            )

        assert _GateReleasingTranslation.texts == [MISHEARD]
        assert _flagged_transcripts(messages) == [
            {
                "type": "source_transcript",
                "segmentId": messages[0]["segmentId"],
                "text": MISHEARD,
                "isFinal": True,
                "speaker": None,
                "flagged": True,
            }
        ]

    def test_flag_mode_does_not_hold_translation_up_for_the_verdict(
        self, client, transcript_check_providers
    ):
        """S27: the check is fired and translation starts immediately with
        the original text -- proven by gating the checker on the translation
        call itself, which deadlocks any implementation that awaits it. The
        flag reaches the client when the verdict lands."""
        checker = transcript_check_providers
        checker.result = TranscriptCheckResult(
            flagged=True, corrected_text=None, failed=False
        )
        checker.gate = asyncio.Event()

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(transcriptCheck={"mode": "flag"}),
            )
            ws.send_bytes(b"\x00\x01")
            messages = _drain_until(ws, lambda m: "flagged" in m)

        assert _GateReleasingTranslation.texts == [MISHEARD]
        assert any(m["type"] == "target_transcript" for m in messages[:-1]), (
            "translation must not wait for the flag verdict"
        )
        assert messages[-1] == {
            "type": "source_transcript",
            "segmentId": messages[0]["segmentId"],
            "text": MISHEARD,
            "isFinal": True,
            "speaker": None,
            "flagged": True,
        }
        assert [call["mode"] for call in checker.calls] == ["flag"]
        assert len(_check_latencies(messages)) == 1, messages

    def test_a_failed_check_drops_to_the_original_text_and_keeps_the_session(
        self, client, transcript_check_providers
    ):
        """F8: the provider failing costs one non-fatal `retryable` error and
        nothing else -- the original text is translated and the segment
        finishes through TTS."""
        checker = transcript_check_providers
        checker.result = TranscriptCheckResult(
            flagged=False, corrected_text=None, failed=True
        )

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(transcriptCheck={"mode": "correct"}),
            )
            ws.send_bytes(b"\x00\x01")
            messages = _drain_until(ws, lambda m: m["type"] == "tts_audio_meta")

        assert _GateReleasingTranslation.texts == [MISHEARD]
        assert [m for m in messages if m["type"] == "error"] == [
            {
                "type": "error",
                "provider": "transcript_check",
                "kind": "UNKNOWN",
                "message": "The transcript check could not run for this segment.",
                "retryable": True,
            }
        ]
        assert _flagged_transcripts(messages) == []

    def test_off_makes_no_call_and_emits_no_transcript_check_latency(
        self, client, transcript_check_providers
    ):
        """F9: `off` (the default) is genuinely off -- no provider call, no
        latency stage, no extra fields on the transcript."""
        checker = transcript_check_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")
            messages = _drain_until(ws, lambda m: m["type"] == "tts_audio_meta")

        assert checker.calls == []
        assert _check_latencies(messages) == []
        assert _flagged_transcripts(messages) == []
        assert _GateReleasingTranslation.texts == [MISHEARD]


class _CountingStage:
    """The fake `DenoiseStage` ticket 16's chain hands `audio_iter()`. It
    records every frame it was given *and* upper-cases it, so the frames the
    STT provider recorded prove the processed bytes reached Deepgram rather
    than the raw ones."""

    def __init__(self, name: str = "fake") -> None:
        self.name = name
        self.frames: list[bytes] = []
        self.resets = 0

    def process(self, frame: bytes) -> bytes:
        self.frames.append(frame)
        return frame.upper()

    def reset(self) -> None:
        self.resets += 1


def _chain_of(*stages: _CountingStage):
    """`build_denoise_chain` replaced by one that hands out `stages` in
    order, one per rebuild -- so a test can tell which chain a frame went
    through."""
    remaining = list(stages)
    return lambda tuning: [remaining.pop(0)] if remaining else []


class TestServerDenoiseChain:
    """S28 / story AC 5.2: every microphone frame passes through the chain
    before Deepgram, the chain is rebuilt (and the old one reset) whenever
    the config in force changes, and nothing enabled means no chain at all."""

    def test_s28_every_mic_frame_is_processed_before_deepgram_sees_it(
        self, client, reconnect_providers, monkeypatch
    ):
        stage = _CountingStage()
        monkeypatch.setattr(orchestrator, "build_denoise_chain", _chain_of(stage))
        stt = reconnect_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(denoise={"noisereduce": {"enabled": True}}),
            )
            ws.send_bytes(b"a")
            ws.send_bytes(b"b")
            _drain_until(ws, _transcript("B"))

        assert stage.frames == [b"a", b"b"]  # call count == frame count
        assert stt.connections[0].frames == [b"A", b"B"]

    def test_s28_deepfilternet_is_built_by_the_chain_and_sees_every_frame(
        self, client, reconnect_providers, monkeypatch
    ):
        """The DeepFilterNet half of S28 (ticket 17). No stubbed
        `build_denoise_chain` this time: the config enables the row, the real
        chain builder goes through `denoise._deepfilternet_factory` -- the
        seam the torch-backed stage is registered on -- and every mic frame
        passes through the stage it built before Deepgram sees it."""
        stage = _CountingStage(name="deepfilternet")
        monkeypatch.setattr(denoise, "_deepfilternet_factory", lambda tuning: stage)
        stt = reconnect_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(
                ws,
                languages=["en", "es"],
                tuning=_tuning_message(
                    denoise={"deepfilternet": {"enabled": True, "attenuationLimitDb": 12}}
                ),
            )
            ws.send_bytes(b"a")
            ws.send_bytes(b"b")
            _drain_until(ws, _transcript("B"))

        assert stage.frames == [b"a", b"b"]
        assert stt.connections[0].frames == [b"A", b"B"]

    def test_nothing_enabled_builds_no_chain_and_leaves_the_frames_alone(
        self, client, reconnect_providers, monkeypatch
    ):
        """The zero-cost half: the real `build_denoise_chain` over the
        default config returns `[]`, and `audio_iter` hands Deepgram exactly
        the bytes the client sent."""
        built = []
        real_build = orchestrator.build_denoise_chain

        def _spy(tuning):
            chain = real_build(tuning)
            built.append(chain)
            return chain

        monkeypatch.setattr(orchestrator, "build_denoise_chain", _spy)
        stt = reconnect_providers

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"a")
            _drain_until(ws, _transcript("a"))

        assert built == [[]]
        assert stt.connections[0].frames == [b"a"]

    @pytest.mark.asyncio
    async def test_a_live_apply_rebuilds_the_chain_and_resets_the_old_stages(
        self, monkeypatch
    ):
        """The non-connection-level path (no reconnect): the next frame goes
        through the new chain, and the outgoing stage is reset so its 480 ms
        of carried context can't leak into the new config's output."""
        first, second = _CountingStage(), _CountingStage()
        monkeypatch.setattr(orchestrator, "build_denoise_chain", _chain_of(first, second))
        tuning = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        outgoing = _CollectingOutgoing()
        audio_queue: asyncio.Queue = asyncio.Queue()

        assert tuning.denoise_chain == [first]

        await orchestrator._handle_update_tuning(
            {
                "requestId": "req-s28",
                "tuning": _tuning_message(denoise={"noisereduce": {"propDecrease": 0.5}}),
            },
            tuning,
            audio_queue,
            outgoing,
        )

        assert outgoing.sent[0]["reconnectedStt"] is False  # no reconnect for this knob
        assert tuning.denoise_chain == [second]
        assert (first.resets, second.resets) == (1, 0)
        assert audio_queue.empty()

    @pytest.mark.asyncio
    async def test_a_connection_level_apply_rebuilds_the_chain_when_it_is_promoted(
        self,
    ):
        """The reconnect path promotes `pending` to `current`, which is a
        chain rebuild too -- one Apply can carry both a Deepgram knob and a
        denoise knob."""
        stt = _FrameEchoSTT()
        tuning = orchestrator._SessionTuning(default_cascade_tuning(), ClientTuning())
        audio_queue: asyncio.Queue = asyncio.Queue()
        task, outgoing, _ = _start_run_stt(stt, tuning, audio_queue)

        audio_queue.put_nowait(b"a")
        await _await_message(outgoing, _transcript("a"))
        before = tuning.denoise_chain

        await _apply(
            tuning,
            audio_queue,
            outgoing,
            "req-s28b",
            deepgram={"endpointingMs": 300},
            denoise={"noisereduce": {"enabled": True}},
        )
        audio_queue.put_nowait(b"b")
        await _await_message(outgoing, lambda m: m["type"] == "tuning_applied")

        assert before == []
        assert [stage.name for stage in tuning.denoise_chain] == ["noisereduce"]
        assert tuning.current.denoise.noisereduce.enabled is True
        await _stop(task)
