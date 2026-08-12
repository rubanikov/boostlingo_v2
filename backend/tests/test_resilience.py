"""Ticket 7 tests: per-segment bounded retry (one policy per
`ProviderErrorKind`), the 5-consecutive-failure circuit breaker, and the
browser<->backend grace-window `resume_session` reconnect. Drives the real
`/ws/cascade` route end-to-end with fake providers, same style as
`test_orchestrator.py`; backend<->provider WebSocket reconnect (Deepgram/
ElevenLabs) is provider-boundary territory and is tested in
`test_providers.py` instead.
"""

import json
import time

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import orchestrator
from app.config import settings
from app.main import app
from app.providers.base import (
    ProviderError,
    ProviderErrorKind,
    TranscriptSegment,
    TTSFlush,
    TTSText,
)

# ---------------------------------------------------------------------------
# Shared fakes
# ---------------------------------------------------------------------------


class _FakeOneSegmentPerAudioChunkSTT:
    """Yields exactly one final+speech_final segment per audio chunk
    received, in order -- lets a test control precisely how many segments
    flow through the pipeline, and when, instead of a fixed STT script
    racing ahead of the test's own message reads."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del languages
        i = 0
        async for _ in audio_chunks:
            i += 1
            yield TranscriptSegment(text=f"segment {i}", is_final=True, speech_final=True)


class _FakeFailingSTT:
    """Raises immediately -- for testing STT's own connect-time retry/drop
    path (distinct from `deepgram_stt.py`'s internal reconnect, tested in
    `test_providers.py`; this is `_run_stt`'s outer retry loop)."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        raise ProviderError(ProviderErrorKind.TIMEOUT, "deepgram", "boom", retryable=True)
        yield  # pragma: no cover -- makes this an async generator function


class _FakeIdleSTT:
    """Never yields a segment -- for tests that only exercise session
    start/resume protocol, not a full segment."""

    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        return
        yield  # pragma: no cover


class _FakeTTS:
    """Ignores individual TTSText chunks and only emits audio on flush --
    same shape as `test_orchestrator.py`'s fake, except it also matches a
    real provider's behavior for a flush with *no* preceding text (e.g. a
    segment whose translation failed outright): no audio at all, not a
    stray chunk. That distinction matters here specifically because
    `_process_segment` always flushes TTS's input queue regardless of
    whether translation succeeded (see orchestrator.py) -- several tests in
    this file depend on a fully-failed segment producing *no* TTS
    messages."""

    def __init__(self, api_key: str, voice_id: str) -> None:
        pass

    async def synthesize(self, input_events, *, voice):
        received_text = False
        async for event in input_events:
            if isinstance(event, TTSText):
                received_text = True
                continue
            if isinstance(event, TTSFlush):
                if received_text:
                    yield b"\x01"
                return


class _UnreachableTranslation:
    """Never actually called -- for tests where STT fails/idles before any
    segment reaches translation, used only so the monkeypatched provider
    class has the right constructor shape."""

    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang):
        raise AssertionError("translate() should never be called in this test")
        yield  # pragma: no cover


def _message_kind(raw_message: dict) -> str:
    if raw_message.get("bytes") is not None:
        return "binary_audio"
    return json.loads(raw_message["text"])["type"]


def _start_session(ws, languages: list[str] | None = None) -> str:
    payload: dict = {"type": "start_session"}
    if languages is not None:
        payload["languages"] = languages
    ws.send_json(payload)
    session_started = json.loads(ws.receive()["text"])
    assert session_started["type"] == "session_started"
    assert session_started["sessionId"]
    return session_started["sessionId"]


def _mock_orchestrator_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Replaces `orchestrator`'s `asyncio.sleep` with an instant no-op that
    records every delay -- retry backoffs would otherwise slow these tests
    down (harmless here since it only affects retry paths exercised in
    each test, never the grace-window timer unless a test explicitly waits
    on it)."""
    calls: list[float] = []

    async def _fake_sleep(seconds: float) -> None:
        calls.append(seconds)

    monkeypatch.setattr(orchestrator.asyncio, "sleep", _fake_sleep)
    return calls


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def shared_portal_client():
    """A `TestClient` entered as a context manager, unlike the plain
    `client` fixture: `TestClient.__enter__` pins one shared anyio portal
    (one background thread/event loop) for every `websocket_connect()` made
    through it afterwards. Needed specifically by the resume tests, which
    open two separate connections in one test and need the second one's
    `_resume_session` to `await`/`cancel` asyncio state (the first
    connection's `stt_task`/`pipeline_task`/`expiry_task`) that's bound to
    the first connection's event loop -- without a shared portal, each
    `websocket_connect()` spins up its own portal/thread (see
    `TestClient._portal_factory`), and awaiting a task from a different
    event loop than the one it was created on hangs forever rather than
    raising, which is exactly as unpleasant to debug as it sounds."""
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Per-segment retry: attempt counts and backoff timing per failure mode
# ---------------------------------------------------------------------------


class TestPerSegmentRetry:
    def test_rate_limit_retries_twice_then_succeeds(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        attempts = {"n": 0}

        class _FlakyThenSucceeds:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                attempts["n"] += 1
                if attempts["n"] < 3:
                    raise ProviderError(
                        ProviderErrorKind.RATE_LIMIT, "openai", "rate limited", retryable=True
                    )
                    yield  # pragma: no cover
                yield "Hola"

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FlakyThenSucceeds)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            raw = [ws.receive() for _ in range(10)]

        assert [_message_kind(m) for m in raw] == [
            "source_transcript",
            "segment_boundary",
            "latency",
            "latency",
            "target_transcript",
            "latency",
            "target_transcript",
            "latency",
            "tts_audio_meta",
            "binary_audio",
        ]
        assert attempts["n"] == 3  # 1 initial + 2 retries
        assert sleeps == [0.2, 0.4]
        final_target = json.loads(raw[6]["text"])
        assert final_target == {
            "type": "target_transcript",
            "segmentId": final_target["segmentId"],
            "text": "Hola",
            "isFinal": True,
            "speaker": None,
        }

    def test_rate_limit_exhausted_drops_segment_and_sends_error(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        attempts = {"n": 0}

        class _AlwaysRateLimited:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                attempts["n"] += 1
                raise ProviderError(
                    ProviderErrorKind.RATE_LIMIT, "openai", "rate limited", retryable=True
                )
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysRateLimited)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            raw = [ws.receive() for _ in range(4)]

        assert [_message_kind(m) for m in raw] == [
            "source_transcript",
            "segment_boundary",
            "latency",
            "error",
        ]
        error = json.loads(raw[3]["text"])
        assert error["provider"] == "openai"
        assert error["kind"] == "RATE_LIMIT"
        assert error["retryable"] is True
        assert attempts["n"] == 3  # 1 initial + 2 retries, then drop
        assert sleeps == [0.2, 0.4]

    def test_timeout_retries_once_then_drops(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        attempts = {"n": 0}

        class _AlwaysTimesOut:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                attempts["n"] += 1
                raise ProviderError(ProviderErrorKind.TIMEOUT, "openai", "timed out", retryable=True)
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysTimesOut)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            raw = [ws.receive() for _ in range(4)]

        error = json.loads(raw[3]["text"])
        assert error["kind"] == "TIMEOUT"
        assert attempts["n"] == 2  # 1 initial + 1 retry, then drop
        assert sleeps == [0.0]

    def test_empty_translation_result_retries_once_then_drops(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        attempts = {"n": 0}

        class _AlwaysEmpty:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                attempts["n"] += 1
                return
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysEmpty)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            raw = [ws.receive() for _ in range(4)]

        error = json.loads(raw[3]["text"])
        assert error["provider"] == "translation"
        assert error["kind"] == "EMPTY_RESULT"
        assert attempts["n"] == 2  # 1 initial + 1 retry, then drop+log
        assert sleeps == [0.0]

    def test_non_retryable_error_drops_without_any_retry(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        attempts = {"n": 0}

        class _AlwaysNonRetryable:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                attempts["n"] += 1
                raise ProviderError(
                    ProviderErrorKind.UNKNOWN, "openai", "bad request", retryable=False
                )
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysNonRetryable)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            raw = [ws.receive() for _ in range(4)]

        error = json.loads(raw[3]["text"])
        assert error["kind"] == "UNKNOWN"
        assert error["retryable"] is False
        assert attempts["n"] == 1  # non-retryable -- no retry attempted at all
        assert sleeps == []

    def test_stt_connect_failure_retries_once_then_drops_and_sends_error(self, client, monkeypatch):
        sleeps = _mock_orchestrator_sleep(monkeypatch)
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeFailingSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _UnreachableTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            error = json.loads(ws.receive()["text"])

        assert error["provider"] == "deepgram"
        assert error["kind"] == "TIMEOUT"
        assert error["retryable"] is True
        assert sleeps == [0.0]  # 1 initial attempt + 1 retry, then drop


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


class TestCircuitBreaker:
    def test_four_consecutive_failures_do_not_trip_breaker(self, client, monkeypatch):
        _mock_orchestrator_sleep(monkeypatch)

        class _AlwaysTimesOut:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                raise ProviderError(ProviderErrorKind.TIMEOUT, "openai", "timed out", retryable=True)
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysTimesOut)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            for _ in range(4):
                ws.send_bytes(b"\x00")
                messages = [json.loads(ws.receive()["text"]) for _ in range(4)]
                assert messages[3]["type"] == "error"
                assert messages[3]["kind"] == "TIMEOUT"

            # Prove no circuit_open snuck in: the very next message is the
            # clock_sync_ack, not a 5th error.
            ws.send_json({"type": "clock_sync", "clientTime": 1_000})
            ack = json.loads(ws.receive()["text"])

        assert ack["type"] == "clock_sync_ack"

    def test_fifth_consecutive_failure_trips_breaker_and_stops_further_segments(
        self, client, monkeypatch
    ):
        _mock_orchestrator_sleep(monkeypatch)

        class _AlwaysTimesOut:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                raise ProviderError(ProviderErrorKind.TIMEOUT, "openai", "timed out", retryable=True)
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysTimesOut)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])

            for _ in range(4):
                ws.send_bytes(b"\x00")
                messages = [json.loads(ws.receive()["text"]) for _ in range(4)]
                assert messages[3]["type"] == "error"

            # 5th segment: the usual 4 messages, plus the breaker trip.
            ws.send_bytes(b"\x00")
            messages = [json.loads(ws.receive()["text"]) for _ in range(5)]
            assert messages[3]["type"] == "error"
            assert messages[4] == {
                "type": "error",
                "provider": "orchestrator",
                "kind": "circuit_open",
                "message": messages[4]["message"],
                "retryable": False,
            }

            # 6th segment: STT (a separate task, unaware of the breaker)
            # still transcribes it -- source_transcript, segment_boundary,
            # latency -- but the pipeline never attempts it: no error, no
            # second circuit_open. Confirmed by reading a known-good
            # follow-up message right after instead of a message that
            # shouldn't come.
            ws.send_bytes(b"\x00")
            for _ in range(3):
                ws.receive()
            ws.send_json({"type": "clock_sync", "clientTime": 1_000})
            ack = json.loads(ws.receive()["text"])

        assert ack["type"] == "clock_sync_ack"

    def test_success_resets_consecutive_failure_count(self, client, monkeypatch):
        _mock_orchestrator_sleep(monkeypatch)

        class _FailsUnlessSegmentFive:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                if source_text == "segment 5":
                    yield "ok"
                    return
                raise ProviderError(ProviderErrorKind.TIMEOUT, "openai", "timed out", retryable=True)
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FailsUnlessSegmentFive)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])

            # Segments 1-4: fail (4 messages each) -- streak reaches 4.
            for _ in range(4):
                ws.send_bytes(b"\x00")
                messages = [json.loads(ws.receive()["text"]) for _ in range(4)]
                assert messages[3]["type"] == "error"

            # Segment 5: succeeds end-to-end (10 messages) -- resets the
            # streak to 0.
            ws.send_bytes(b"\x00")
            for _ in range(10):
                ws.receive()

            # Segments 6-9: fail again -- only 4 more, one short of a fresh
            # 5-in-a-row, so the breaker must not trip.
            for _ in range(4):
                ws.send_bytes(b"\x00")
                messages = [json.loads(ws.receive()["text"]) for _ in range(4)]
                assert messages[3]["type"] == "error"

            ws.send_json({"type": "clock_sync", "clientTime": 1_000})
            ack = json.loads(ws.receive()["text"])

        assert ack["type"] == "clock_sync_ack"


# ---------------------------------------------------------------------------
# Browser<->backend grace-window resume
# ---------------------------------------------------------------------------


class TestSessionResume:
    def test_resume_session_for_unknown_session_id_gets_not_found_error(self, client):
        with client.websocket_connect("/ws/cascade") as ws:
            ws.send_json({"type": "resume_session", "sessionId": "does-not-exist"})
            error = json.loads(ws.receive()["text"])

        assert error == {
            "type": "error",
            "provider": "session",
            "kind": "not_found",
            "message": "Session expired or unknown -- please start a new session.",
            "retryable": False,
        }

    def test_resume_session_reattaches_to_same_underlying_state_within_grace_window(
        self, shared_portal_client, monkeypatch
    ):
        """Ticket 7's required resume test: an unexpected drop mid-session,
        followed by a `resume_session` on a new connection, continues the
        *same* orchestrator state rather than starting fresh -- proven
        behaviorally via the circuit breaker's consecutive-failure count,
        which only reaches 5 (and trips) if it carried over across the
        reconnect rather than resetting."""

        class _AlwaysTimesOut:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                # 0.0s backoff (TIMEOUT's policy) -- fast enough to leave
                # `GRACE_WINDOW_S` (5s, real, unmocked here) with plenty of
                # room, so this test doesn't need to touch the grace-window
                # timer at all.
                raise ProviderError(ProviderErrorKind.TIMEOUT, "openai", "timed out", retryable=True)
                yield  # pragma: no cover

        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeOneSegmentPerAudioChunkSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _AlwaysTimesOut)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with shared_portal_client.websocket_connect("/ws/cascade") as ws1:
            session_id = _start_session(ws1, languages=["en", "es"])

            # 4 consecutive failures -- one short of tripping the breaker.
            for _ in range(4):
                ws1.send_bytes(b"\x00")
                messages = [json.loads(ws1.receive()["text"]) for _ in range(4)]
                assert messages[3]["type"] == "error"

            # Unexpected drop, not a clean client-initiated close.
            ws1.close(code=1006)
            # Lets the backend's own event-loop thread finish processing
            # the disconnect (registering the detached session) before this
            # thread proceeds -- see `shared_portal_client`'s docstring for
            # why this specific cross-thread wait is needed here (no wire
            # message signals "detach complete" back to a party that's
            # already gone).
            time.sleep(0.1)

        assert session_id in orchestrator._detached_sessions

        with shared_portal_client.websocket_connect("/ws/cascade") as ws2:
            ws2.send_json({"type": "resume_session", "sessionId": session_id})

            # 5th consecutive failure -- trips the breaker *only* if the
            # streak (4, from before the drop) carried over rather than
            # resetting on reconnect.
            ws2.send_bytes(b"\x00")
            messages = [json.loads(ws2.receive()["text"]) for _ in range(5)]

        assert session_id not in orchestrator._detached_sessions  # reclaimed, not left behind
        assert messages[3]["type"] == "error"
        assert messages[4] == {
            "type": "error",
            "provider": "orchestrator",
            "kind": "circuit_open",
            "message": messages[4]["message"],
            "retryable": False,
        }

    def test_grace_window_expiry_tears_down_and_evicts_unreclaimed_session(
        self, client, monkeypatch
    ):
        monkeypatch.setattr(orchestrator, "GRACE_WINDOW_S", 0.05)
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeIdleSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _UnreachableTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws1:
            session_id = _start_session(ws1, languages=["en", "es"])
            ws1.close(code=1006)
            time.sleep(0.3)  # well past the shrunk 0.05s grace window

        assert session_id not in orchestrator._detached_sessions

        with client.websocket_connect("/ws/cascade") as ws2:
            ws2.send_json({"type": "resume_session", "sessionId": session_id})
            error = json.loads(ws2.receive()["text"])

        assert error["kind"] == "not_found"


# ---------------------------------------------------------------------------
# WebSocket Origin validation -- a malicious page with no getUserMedia()/mic
# permission can still open a raw `new WebSocket(...)` to this endpoint from
# a developer's browser (browsers don't apply CORS/Same-Origin Policy to
# WebSocket connects), so `/ws/cascade` has to check `Origin` itself rather
# than relying on `CORSMiddleware` (which never sees WebSocket upgrades).
# ---------------------------------------------------------------------------


class TestOriginValidation:
    def test_disallowed_origin_is_rejected_before_any_session_state_is_created(self, client):
        with (
            pytest.raises(WebSocketDisconnect) as exc_info,
            client.websocket_connect("/ws/cascade", headers={"origin": "https://evil.example"}),
        ):
            pass  # pragma: no cover -- rejected during the connect handshake itself

        assert exc_info.value.code == 1008
        # No `session_started` was ever sent, so no session could have been
        # registered anywhere session state lives.
        assert not orchestrator._detached_sessions

    def test_allowed_origin_proceeds_to_a_normal_session(self, client, monkeypatch):
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeIdleSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _UnreachableTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect(
            "/ws/cascade", headers={"origin": settings.cors_origins[0]}
        ) as ws:
            session_id = _start_session(ws, languages=["en", "es"])

        assert session_id

    def test_missing_origin_header_proceeds_to_a_normal_session(self, client, monkeypatch):
        """A non-browser client (a legitimate local dev/testing tool) sends
        no `Origin` header at all -- this endpoint defends against
        *browser*-originated cross-site abuse specifically, not all
        non-browser clients."""
        monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeIdleSTT)
        monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _UnreachableTranslation)
        monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

        with client.websocket_connect("/ws/cascade") as ws:
            session_id = _start_session(ws, languages=["en", "es"])

        assert session_id
