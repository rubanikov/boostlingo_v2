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

import json

import pytest
from starlette.testclient import TestClient

from app import orchestrator
from app.config import settings
from app.main import app
from app.providers.base import TranscriptSegment, TTSFlush, TTSText


class _FakeSTT:
    """Emits one interim segment, then a final+speech_final segment."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
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

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        return
        yield  # pragma: no cover -- makes this an async generator function


class _FakeSilentThenSpeechSTT:
    """Silence (empty final+speech_final) followed by real speech -- proves
    the empty segment produces no downstream messages but doesn't wedge the
    pipeline for the segment after it."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks
        yield TranscriptSegment(text="", is_final=True, speech_final=True)
        yield TranscriptSegment(text="hi", is_final=True, speech_final=True)


class _FakeTranslation:
    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang):
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


def _start_session(ws, languages: list[str] | None = None) -> str:
    """Sends `start_session` and drains the `session_started` message
    (Ticket 7) that's always the very next thing off the wire, returning
    its `sessionId` -- keeps every other test's message-count/order
    assertions unchanged rather than needing a `+1` everywhere."""
    payload: dict = {"type": "start_session"}
    if languages is not None:
        payload["languages"] = languages
    ws.send_json(payload)
    session_started = json.loads(ws.receive()["text"])
    assert session_started["type"] == "session_started"
    assert session_started["sessionId"]
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

            raw_messages = [ws.receive() for _ in range(12)]

        assert [_message_kind(m) for m in raw_messages] == [
            "source_transcript",
            "source_transcript",
            "segment_boundary",
            "latency",
            "latency",
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

        speech_end_latency = json.loads(raw_messages[3]["text"])
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
        timed_stages = [json.loads(raw_messages[i]["text"]) for i in (4, 7, 9)]
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

        final_target = json.loads(raw_messages[8]["text"])
        assert final_target == {
            "type": "target_transcript",
            "segmentId": segment_id,
            "text": "Hola mundo",
            "isFinal": True,
            "speaker": None,
        }

        audio_meta = json.loads(raw_messages[10]["text"])
        assert audio_meta == {
            "type": "tts_audio_meta",
            "segmentId": segment_id,
            "sampleRate": 16000,
            "speaker": None,
        }
        assert raw_messages[11]["bytes"] == b"\x01\x02\x03"

    def test_silent_segment_produces_no_downstream_messages(self, client, monkeypatch):
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSilentThenSpeechSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(11)]

        kinds = [_message_kind(m) for m in raw_messages]
        # Only one segment's worth of messages -- the silent segment
        # contributed no source_transcript, no segment_boundary, no
        # latency, nothing.
        assert kinds == [
            "source_transcript",
            "segment_boundary",
            "latency",
            "latency",
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

            async def stream(self, audio_chunks, *, languages):
                del audio_chunks
                stt_calls.append(languages)
                yield TranscriptSegment(text="hola", is_final=True, speech_final=True)

        class _CapturingTranslation:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
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

            async def stream(self, audio_chunks, *, languages):
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

            async def stream(self, audio_chunks, *, languages):
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

    async def stream(self, audio_chunks, *, languages):
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

            async def translate(self, source_text, *, source_lang, target_lang):
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
            # speech_end, latency translation_first_token, target_transcript
            # interim, latency translation_complete, target_transcript
            # final, latency tts_first_byte, tts_audio_meta, binary_audio)
            # = 30 messages. STT keeps flowing while a prior segment's
            # translate/TTS is still in flight (see orchestrator's
            # concurrency shape), so segments' messages can interleave on
            # the wire -- group by segmentId below instead of asserting one
            # fixed order.
            raw_messages = [ws.receive() for _ in range(30)]

        kinds = [_message_kind(m) for m in raw_messages]
        assert sorted(kinds) == sorted(
            [
                "source_transcript",
                "segment_boundary",
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
    """Ticket 6: the `latency` message sequence for a segment (all 5
    stages), and the `clock_sync`/`playback_started` protocol that drives
    the final `playback_start` stage.
    """

    def test_latency_stage_sequence_for_a_segment(self, client, monkeypatch):
        # One `_now_ms()` call per stage: `mark_speech_end` (10_050), then
        # one `elapsed_since_speech_end()` call each for
        # translation_first_token (10_100), translation_complete (10_300),
        # tts_first_byte (10_450) -- by hand: ms = 0, 50, 250, 400.
        _sequential_clock(monkeypatch, [10_050, 10_100, 10_300, 10_450])
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(12)]

        latency_messages = [
            json.loads(m["text"]) for m in raw_messages if _message_kind(m) == "latency"
        ]
        segment_ids = {m["segmentId"] for m in latency_messages}
        assert len(segment_ids) == 1  # all 4 stages are for the same segment

        assert [(m["stage"], m["ms"]) for m in latency_messages] == [
            ("speech_end", 0),
            ("translation_first_token", 50),
            ("translation_complete", 250),
            ("tts_first_byte", 400),
        ]
        # Monotonically non-decreasing, as the wire contract requires.
        ms_values = [m["ms"] for m in latency_messages]
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
        # Values 1-4 are the segment's 4 server-side stages (matching
        # test_latency_stage_sequence_for_a_segment); value 5 is the
        # clock_sync serverTime, read only after the segment is fully
        # drained below (so there's no ambiguity about which call produced
        # which value).
        _sequential_clock(monkeypatch, [10_050, 10_100, 10_300, 10_450, 10_000])
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")

            raw_messages = [ws.receive() for _ in range(12)]
            latency_messages = [
                json.loads(m["text"]) for m in raw_messages if _message_kind(m) == "latency"
            ]
            segment_id = latency_messages[0]["segmentId"]

            # clientTime=5_000 answered by the mocked server clock's 5th
            # call (10_000) -- offset = 10_000 - 5_000 = 5_000.
            ws.send_json({"type": "clock_sync", "clientTime": 5_000})
            ack = json.loads(ws.receive()["text"])
            assert ack == {"type": "clock_sync_ack", "clientTime": 5_000, "serverTime": 10_000}

            # Client reports playback scheduled at clientTime=20_000 ->
            # converted to server-time via the offset: 20_000 + 5_000 =
            # 25_000. That segment's speech_end was 10_050 (the first
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
