"""Provider-boundary contract tests, per the ticket's "targeted tests on...
provider boundaries": for each of the three `Protocol` implementations,
mock the underlying transport (a fake WebSocket for Deepgram/ElevenLabs, a
mocked OpenAI client for translation) so no live network call is ever made,
and assert normal streaming maps to the right typed events, each documented
failure mode maps to the right `ProviderError` kind + `retryable` flag, and
an empty/silent STT result never raises.
"""

import asyncio
import base64
import json
from typing import Any, Self
from unittest.mock import AsyncMock

import httpx2
import openai as openai_errors
import pytest
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from app.providers import _resilience
from app.providers.base import (
    ProviderError,
    ProviderErrorKind,
    TTSFlush,
    TTSText,
    UtteranceEndSignal,
)
from app.providers.deepgram_stt import DeepgramSTTProvider
from app.providers.deepgram_stt import websockets as deepgram_websockets
from app.providers.elevenlabs_tts import ElevenLabsTTSProvider
from app.providers.elevenlabs_tts import websockets as elevenlabs_websockets
from app.providers.openai_translation import OpenAITranslationProvider
from app.providers.segmentation_checker import SegmentationChecker


def _mock_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Replaces `_resilience`'s `asyncio.sleep` with an instant no-op that
    records every delay it was called with -- Ticket 7's reconnect backoff
    (500ms->1s->2s) would otherwise make these tests take several real
    seconds."""
    calls: list[float] = []

    async def _fake_sleep(seconds: float) -> None:
        calls.append(seconds)

    monkeypatch.setattr(_resilience.asyncio, "sleep", _fake_sleep)
    return calls

# ---------------------------------------------------------------------------
# Shared fake WebSocket -- both DeepgramSTTProvider and ElevenLabsTTSProvider
# talk to `websockets.connect(...)` used as `async with ... as socket:`,
# where `socket` is both an async context manager and an async iterable of
# incoming messages. This fake stands in for both.
# ---------------------------------------------------------------------------


class FakeSocket:
    def __init__(self, incoming: list[str] | None = None, raise_on_enter: Exception | None = None):
        self._incoming = incoming or []
        self._raise_on_enter = raise_on_enter
        self.sent: list[Any] = []

    async def __aenter__(self) -> Self:
        if self._raise_on_enter is not None:
            raise self._raise_on_enter
        return self

    async def __aexit__(self, *exc_info: object) -> bool:
        return False

    async def send(self, data: Any) -> None:
        self.sent.append(data)

    def __aiter__(self):
        return self._drain()

    async def _drain(self):
        for message in self._incoming:
            yield message


async def _no_audio():
    return
    yield  # pragma: no cover -- makes this an async generator with no items


# ---------------------------------------------------------------------------
# DeepgramSTTProvider
# ---------------------------------------------------------------------------


def _deepgram_result(text: str, *, is_final: bool, speech_final: bool) -> str:
    return json.dumps(
        {
            "type": "Results",
            "is_final": is_final,
            "speech_final": speech_final,
            "channel": {"alternatives": [{"transcript": text}]},
        }
    )


def _deepgram_result_with_words(
    text: str, *, is_final: bool, speech_final: bool, words: list[dict]
) -> str:
    return json.dumps(
        {
            "type": "Results",
            "is_final": is_final,
            "speech_final": speech_final,
            "channel": {"alternatives": [{"transcript": text, "words": words}]},
        }
    )


class TestDeepgramSTTProvider:
    @pytest.mark.asyncio
    async def test_streams_interim_and_final_segments(self, monkeypatch):
        socket = FakeSocket(
            incoming=[
                _deepgram_result("hello", is_final=False, speech_final=False),
                _deepgram_result("hello world", is_final=True, speech_final=True),
            ]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert [(s.text, s.is_final, s.speech_final) for s in segments] == [
            ("hello", False, False),
            ("hello world", True, True),
        ]
        assert segments[0].speaker is None
        assert segments[1].is_empty is False

    @pytest.mark.asyncio
    async def test_empty_final_result_does_not_raise(self, monkeypatch):
        socket = FakeSocket(
            incoming=[_deepgram_result("", is_final=True, speech_final=True)]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert len(segments) == 1
        assert segments[0].is_empty is True
        assert segments[0].is_final is True
        assert segments[0].speech_final is True

    @pytest.mark.asyncio
    async def test_ignores_non_results_messages(self, monkeypatch):
        socket = FakeSocket(
            incoming=[
                json.dumps({"type": "Metadata"}),
                _deepgram_result("hi", is_final=True, speech_final=True),
            ]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert len(segments) == 1
        assert segments[0].text == "hi"

    @pytest.mark.asyncio
    async def test_auth_failure_maps_to_connection_not_retryable(self, monkeypatch):
        response = httpx2.Response(401, request=httpx2.Request("GET", "https://api.deepgram.com/v1/listen"))
        socket = FakeSocket(raise_on_enter=InvalidStatus(response))
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="bad-key")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.stream(_no_audio(), languages=("en", "es")):
                pass

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.retryable is False
        assert exc_info.value.provider == "deepgram"

    @pytest.mark.asyncio
    async def test_rate_limit_maps_to_retryable_rate_limit(self, monkeypatch):
        response = httpx2.Response(429, request=httpx2.Request("GET", "https://api.deepgram.com/v1/listen"))
        socket = FakeSocket(raise_on_enter=InvalidStatus(response))
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.stream(_no_audio(), languages=("en", "es")):
                pass

        assert exc_info.value.kind is ProviderErrorKind.RATE_LIMIT
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_connection_drop_reconnects_with_backoff_then_gives_up(self, monkeypatch):
        """Ticket 7: a persistent connection drop retries the backend<->
        Deepgram WebSocket at 500ms->1s->2s (3 attempts) before finally
        raising `ProviderError(CONNECTION)` to the caller."""
        sleeps = _mock_sleep(monkeypatch)
        socket = FakeSocket(raise_on_enter=ConnectionClosedError(None, None))
        connect_calls: list[str] = []

        def _fake_connect(*a, **k):
            del a, k
            connect_calls.append("connect")
            return socket

        monkeypatch.setattr(deepgram_websockets, "connect", _fake_connect)

        provider = DeepgramSTTProvider(api_key="test-key")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.stream(_no_audio(), languages=("en", "es")):
                pass

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.retryable is True
        assert len(connect_calls) == 4  # 1 initial attempt + 3 reconnects
        assert sleeps == [0.5, 1.0, 2.0]

    @pytest.mark.asyncio
    async def test_connection_drop_reconnects_transparently_when_a_retry_succeeds(
        self, monkeypatch
    ):
        """A reconnect that succeeds within the 3-attempt budget resumes
        streaming from the new connection without ever raising -- invisible
        to the caller besides the pause."""
        sleeps = _mock_sleep(monkeypatch)
        failing_socket = FakeSocket(raise_on_enter=ConnectionClosedError(None, None))
        healthy_socket = FakeSocket(
            incoming=[_deepgram_result("hello", is_final=True, speech_final=True)]
        )
        connect_calls: list[str] = []

        def _fake_connect(*a, **k):
            del a, k
            connect_calls.append("connect")
            return failing_socket if len(connect_calls) <= 2 else healthy_socket

        monkeypatch.setattr(deepgram_websockets, "connect", _fake_connect)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert [s.text for s in segments] == ["hello"]
        assert len(connect_calls) == 3  # 1 initial attempt + 2 failed reconnects + success
        assert sleeps == [0.5, 1.0]

    @pytest.mark.asyncio
    async def test_malformed_frame_does_not_hang_and_surfaces_as_provider_error(
        self, monkeypatch
    ):
        """Bug fix: a malformed/non-JSON frame from Deepgram must not kill
        `_receive_results` with an uncaught `json.JSONDecodeError` and leave
        `stream()`'s consumer blocked on `queue.get()` forever -- it has to
        surface through the same `ConnectionDropped` -> (after reconnect is
        exhausted) `ProviderError` path as any other mid-stream drop.
        `asyncio.wait_for` is the hang-detection guard: if the fix doesn't
        work, this fails on a timeout rather than hanging the suite."""
        sleeps = _mock_sleep(monkeypatch)
        socket = FakeSocket(incoming=["not valid json"])
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")

        async def _drain() -> None:
            async for _ in provider.stream(_no_audio(), languages=("en", "es")):
                pass

        with pytest.raises(ProviderError) as exc_info:
            await asyncio.wait_for(_drain(), timeout=5.0)

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.provider == "deepgram"
        assert sleeps == [0.5, 1.0, 2.0]  # reconnect exhausted, same as any other drop

    @pytest.mark.asyncio
    async def test_connects_with_diarization_and_multi_language_params(self, monkeypatch):
        urls: list[str] = []

        def _fake_connect(url, **kwargs):
            del kwargs
            urls.append(url)
            return FakeSocket()

        monkeypatch.setattr(deepgram_websockets, "connect", _fake_connect)

        provider = DeepgramSTTProvider(api_key="test-key")
        async for _ in provider.stream(_no_audio(), languages=("en", "es")):
            pass

        assert "diarize=true" in urls[0]
        assert "language=multi" in urls[0]
        assert "model=nova-3" in urls[0]

    @pytest.mark.asyncio
    async def test_connects_with_utterance_end_and_vad_events_params(self, monkeypatch):
        """Ticket 5: `utterance_end_ms=3000` (Deepgram's documented
        1000-5000 range) and `vad_events=true`, added alongside the
        already-live diarization/multi-language/endpointing params."""
        urls: list[str] = []

        def _fake_connect(url, **kwargs):
            del kwargs
            urls.append(url)
            return FakeSocket()

        monkeypatch.setattr(deepgram_websockets, "connect", _fake_connect)

        provider = DeepgramSTTProvider(api_key="test-key")
        async for _ in provider.stream(_no_audio(), languages=("en", "es")):
            pass

        assert "utterance_end_ms=3000" in urls[0]
        assert "vad_events=true" in urls[0]
        assert "endpointing=500" in urls[0]
        assert "interim_results=true" in urls[0]

    @pytest.mark.asyncio
    async def test_parses_utterance_end_message_into_utterance_end_signal(self, monkeypatch):
        socket = FakeSocket(
            incoming=[
                json.dumps({"type": "UtteranceEnd", "channel": [0, 1], "last_word_end": 1.23}),
                _deepgram_result("hi", is_final=True, speech_final=True),
            ]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        events = [event async for event in provider.stream(_no_audio(), languages=("en", "es"))]

        assert isinstance(events[0], UtteranceEndSignal)
        assert events[1].text == "hi"

    @pytest.mark.asyncio
    async def test_rolls_up_per_word_speaker_and_language_by_majority_vote(self, monkeypatch):
        words = [
            {"word": "hello", "speaker": 0, "language": "en"},
            {"word": "there", "speaker": 0, "language": "en"},
            {"word": "friend", "speaker": 1, "language": "en"},
        ]
        socket = FakeSocket(
            incoming=[
                _deepgram_result_with_words(
                    "hello there friend", is_final=True, speech_final=True, words=words
                )
            ]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert len(segments) == 1
        # 2 of 3 words are speaker 0 -- majority vote, not "first word".
        assert segments[0].speaker == 0
        assert segments[0].detected_language == "en"

    @pytest.mark.asyncio
    async def test_missing_words_leaves_speaker_and_language_none(self, monkeypatch):
        socket = FakeSocket(
            incoming=[_deepgram_result("hi", is_final=True, speech_final=True)]
        )
        monkeypatch.setattr(deepgram_websockets, "connect", lambda *a, **k: socket)

        provider = DeepgramSTTProvider(api_key="test-key")
        segments = [seg async for seg in provider.stream(_no_audio(), languages=("en", "es"))]

        assert segments[0].speaker is None
        assert segments[0].detected_language is None


# ---------------------------------------------------------------------------
# OpenAITranslationProvider
# ---------------------------------------------------------------------------


class _FakeDelta:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str | None) -> None:
        self.delta = _FakeDelta(content)


class _FakeChunk:
    def __init__(self, content: str | None) -> None:
        self.choices = [_FakeChoice(content)] if content is not None else []


class _FakeChatStream:
    def __init__(self, contents: list[str | None]) -> None:
        self._contents = contents

    def __aiter__(self):
        return self._drain()

    async def _drain(self):
        for content in self._contents:
            yield _FakeChunk(content)


def _openai_request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")


class TestOpenAITranslationProvider:
    @pytest.mark.asyncio
    async def test_streams_translated_deltas(self, monkeypatch):
        provider = OpenAITranslationProvider(api_key="test-key")
        monkeypatch.setattr(
            provider._client.chat.completions,
            "create",
            AsyncMock(return_value=_FakeChatStream(["Hola", " ", "mundo", None])),
        )

        deltas = [
            chunk
            async for chunk in provider.translate(
                "hello world", source_lang="en", target_lang="es"
            )
        ]

        assert deltas == ["Hola", " ", "mundo"]

    @pytest.mark.asyncio
    async def test_rate_limit_maps_to_retryable_error(self, monkeypatch):
        provider = OpenAITranslationProvider(api_key="test-key")
        response = httpx2.Response(429, request=_openai_request())
        error = openai_errors.RateLimitError("rate limited", response=response, body=None)
        monkeypatch.setattr(
            provider._client.chat.completions, "create", AsyncMock(side_effect=error)
        )

        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.translate("hi", source_lang="en", target_lang="es"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.RATE_LIMIT
        assert exc_info.value.retryable is True
        assert exc_info.value.provider == "openai"

    @pytest.mark.asyncio
    async def test_timeout_maps_to_retryable_error(self, monkeypatch):
        provider = OpenAITranslationProvider(api_key="test-key")
        error = openai_errors.APITimeoutError(request=_openai_request())
        monkeypatch.setattr(
            provider._client.chat.completions, "create", AsyncMock(side_effect=error)
        )

        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.translate("hi", source_lang="en", target_lang="es"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.TIMEOUT
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_connection_error_maps_to_retryable_error(self, monkeypatch):
        provider = OpenAITranslationProvider(api_key="test-key")
        error = openai_errors.APIConnectionError(request=_openai_request())
        monkeypatch.setattr(
            provider._client.chat.completions, "create", AsyncMock(side_effect=error)
        )

        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.translate("hi", source_lang="en", target_lang="es"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_other_api_status_error_maps_to_unknown_not_retryable(self, monkeypatch):
        provider = OpenAITranslationProvider(api_key="test-key")
        response = httpx2.Response(500, request=_openai_request())
        error = openai_errors.APIStatusError("server error", response=response, body=None)
        monkeypatch.setattr(
            provider._client.chat.completions, "create", AsyncMock(side_effect=error)
        )

        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.translate("hi", source_lang="en", target_lang="es"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.UNKNOWN
        assert exc_info.value.retryable is False


# ---------------------------------------------------------------------------
# SegmentationChecker (Ticket 5)
# ---------------------------------------------------------------------------


class _FakeCompletionMessage:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _FakeChoiceWithMessage:
    def __init__(self, content: str | None) -> None:
        self.message = _FakeCompletionMessage(content)


class _FakeChatCompletion:
    """Stands in for a non-streaming `chat.completions.create(...)` result
    -- `SegmentationChecker` reads `response.choices[0].message.content`,
    unlike `OpenAITranslationProvider`'s streamed `delta.content` above."""

    def __init__(self, choices: list[_FakeChoiceWithMessage]) -> None:
        self.choices = choices


class TestSegmentationChecker:
    @pytest.mark.asyncio
    async def test_yes_response_is_a_complete_clause(self, monkeypatch):
        checker = SegmentationChecker(api_key="test-key")
        monkeypatch.setattr(
            checker._client.chat.completions,
            "create",
            AsyncMock(return_value=_FakeChatCompletion([_FakeChoiceWithMessage("YES")])),
        )

        assert await checker.is_complete_clause("The meeting starts at noon.", "en") is True

    @pytest.mark.asyncio
    async def test_no_response_is_not_a_complete_clause(self, monkeypatch):
        checker = SegmentationChecker(api_key="test-key")
        monkeypatch.setattr(
            checker._client.chat.completions,
            "create",
            AsyncMock(return_value=_FakeChatCompletion([_FakeChoiceWithMessage("NO")])),
        )

        assert await checker.is_complete_clause("The meeting starts at", "en") is False

    @pytest.mark.asyncio
    async def test_unexpected_response_defaults_to_not_a_complete_clause(self, monkeypatch):
        """Parsed defensively, per the ticket: anything not starting with
        `"YES"` is `False`, not just a literal `"NO"`."""
        checker = SegmentationChecker(api_key="test-key")
        monkeypatch.setattr(
            checker._client.chat.completions,
            "create",
            AsyncMock(return_value=_FakeChatCompletion([_FakeChoiceWithMessage("maybe?")])),
        )

        assert await checker.is_complete_clause("The meeting", "en") is False

    @pytest.mark.asyncio
    async def test_empty_choices_defaults_to_not_a_complete_clause(self, monkeypatch):
        checker = SegmentationChecker(api_key="test-key")
        monkeypatch.setattr(
            checker._client.chat.completions,
            "create",
            AsyncMock(return_value=_FakeChatCompletion([])),
        )

        assert await checker.is_complete_clause("The meeting", "en") is False

    @pytest.mark.asyncio
    async def test_openai_failure_defaults_to_not_a_complete_clause_rather_than_raising(
        self, monkeypatch
    ):
        checker = SegmentationChecker(api_key="test-key")
        error = openai_errors.APITimeoutError(request=_openai_request())
        monkeypatch.setattr(
            checker._client.chat.completions, "create", AsyncMock(side_effect=error)
        )

        assert await checker.is_complete_clause("The meeting", "en") is False


# ---------------------------------------------------------------------------
# ElevenLabsTTSProvider
# ---------------------------------------------------------------------------


def _audio_output(raw: bytes) -> str:
    return json.dumps({"audio": base64.b64encode(raw).decode("ascii")})


def _final_output() -> str:
    return json.dumps({"isFinal": True})


async def _tts_input_events(*events):
    for event in events:
        yield event


class TestElevenLabsTTSProvider:
    @pytest.mark.asyncio
    async def test_streams_decoded_audio_and_sends_expected_message_sequence(self, monkeypatch):
        socket = FakeSocket(incoming=[_audio_output(b"\x01\x02"), _audio_output(b"\x03"), _final_output()])
        monkeypatch.setattr(elevenlabs_websockets, "connect", lambda *a, **k: socket)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="voice-1")
        chunks = [
            chunk
            async for chunk in provider.synthesize(
                _tts_input_events(TTSText("hola"), TTSFlush()), voice="default"
            )
        ]

        assert chunks == [b"\x01\x02", b"\x03"]

        sent = [json.loads(message) for message in socket.sent]
        assert sent[0]["text"] == " "  # InitializeConnection
        assert sent[1] == {"text": "hola"}  # SendText
        assert sent[2] == {"text": "", "flush": True}  # flush at segment boundary
        assert sent[3] == {"text": ""}  # CloseConnection

    @pytest.mark.asyncio
    async def test_auth_failure_maps_to_connection_not_retryable(self, monkeypatch):
        response = httpx2.Response(
            401, request=httpx2.Request("GET", "https://api.elevenlabs.io/v1/text-to-speech/x/stream-input")
        )
        socket = FakeSocket(raise_on_enter=InvalidStatus(response))
        monkeypatch.setattr(elevenlabs_websockets, "connect", lambda *a, **k: socket)

        provider = ElevenLabsTTSProvider(api_key="bad-key", voice_id="voice-1")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice="default"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.retryable is False
        assert exc_info.value.provider == "elevenlabs"

    @pytest.mark.asyncio
    async def test_rate_limit_maps_to_retryable_rate_limit(self, monkeypatch):
        response = httpx2.Response(
            429, request=httpx2.Request("GET", "https://api.elevenlabs.io/v1/text-to-speech/x/stream-input")
        )
        socket = FakeSocket(raise_on_enter=InvalidStatus(response))
        monkeypatch.setattr(elevenlabs_websockets, "connect", lambda *a, **k: socket)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="voice-1")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice="default"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.RATE_LIMIT
        assert exc_info.value.retryable is True

    @pytest.mark.asyncio
    async def test_connection_drop_reconnects_with_backoff_then_gives_up(self, monkeypatch):
        """Ticket 7: a persistent connection drop retries the backend<->
        ElevenLabs WebSocket at 500ms->1s->2s (3 attempts) before finally
        raising `ProviderError(CONNECTION)` to the caller."""
        sleeps = _mock_sleep(monkeypatch)
        socket = FakeSocket(raise_on_enter=ConnectionClosedError(None, None))
        connect_calls: list[str] = []

        def _fake_connect(*a, **k):
            del a, k
            connect_calls.append("connect")
            return socket

        monkeypatch.setattr(elevenlabs_websockets, "connect", _fake_connect)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="voice-1")
        with pytest.raises(ProviderError) as exc_info:
            async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice="default"):
                pass

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.retryable is True
        assert len(connect_calls) == 4  # 1 initial attempt + 3 reconnects
        assert sleeps == [0.5, 1.0, 2.0]

    @pytest.mark.asyncio
    async def test_connection_drop_reconnects_transparently_when_a_retry_succeeds(
        self, monkeypatch
    ):
        """A reconnect that succeeds within the 3-attempt budget resumes
        synthesis on the new connection without ever raising -- invisible
        to the caller besides the pause."""
        sleeps = _mock_sleep(monkeypatch)
        failing_socket = FakeSocket(raise_on_enter=ConnectionClosedError(None, None))
        healthy_socket = FakeSocket(incoming=[_audio_output(b"\x01"), _final_output()])
        connect_calls: list[str] = []

        def _fake_connect(*a, **k):
            del a, k
            connect_calls.append("connect")
            return failing_socket if len(connect_calls) == 1 else healthy_socket

        monkeypatch.setattr(elevenlabs_websockets, "connect", _fake_connect)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="voice-1")
        chunks = [
            chunk
            async for chunk in provider.synthesize(_tts_input_events(TTSFlush()), voice="default")
        ]

        assert chunks == [b"\x01"]
        assert len(connect_calls) == 2  # 1 initial attempt + 1 reconnect that succeeds
        assert sleeps == [0.5]

    @pytest.mark.asyncio
    async def test_malformed_frame_does_not_hang_and_surfaces_as_provider_error(
        self, monkeypatch
    ):
        """Bug fix: a malformed/non-JSON frame from ElevenLabs must not kill
        `_receive_audio` with an uncaught `json.JSONDecodeError` and leave
        `synthesize()`'s consumer blocked on `queue.get()` forever -- it has
        to surface through the same `ConnectionDropped` -> (after reconnect
        is exhausted) `ProviderError` path as any other mid-stream drop.
        `asyncio.wait_for` is the hang-detection guard: if the fix doesn't
        work, this fails on a timeout rather than hanging the suite."""
        sleeps = _mock_sleep(monkeypatch)
        socket = FakeSocket(incoming=["not valid json"])
        monkeypatch.setattr(elevenlabs_websockets, "connect", lambda *a, **k: socket)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="voice-1")

        async def _drain() -> None:
            async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice="default"):
                pass

        with pytest.raises(ProviderError) as exc_info:
            await asyncio.wait_for(_drain(), timeout=5.0)

        assert exc_info.value.kind is ProviderErrorKind.CONNECTION
        assert exc_info.value.provider == "elevenlabs"
        assert sleeps == [0.5, 1.0, 2.0]  # reconnect exhausted, same as any other drop

    @pytest.mark.asyncio
    async def test_connects_with_the_voice_argument_as_the_voice_id(self, monkeypatch):
        urls: list[str] = []

        def _fake_connect(url, **kwargs):
            del kwargs
            urls.append(url)
            return FakeSocket(incoming=[_final_output()])

        monkeypatch.setattr(elevenlabs_websockets, "connect", _fake_connect)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="fallback-voice")
        async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice="speaker-b-voice"):
            pass

        assert "speaker-b-voice" in urls[0]
        assert "fallback-voice" not in urls[0]

    @pytest.mark.asyncio
    async def test_falls_back_to_constructor_voice_id_when_voice_argument_is_empty(
        self, monkeypatch
    ):
        urls: list[str] = []

        def _fake_connect(url, **kwargs):
            del kwargs
            urls.append(url)
            return FakeSocket(incoming=[_final_output()])

        monkeypatch.setattr(elevenlabs_websockets, "connect", _fake_connect)

        provider = ElevenLabsTTSProvider(api_key="test-key", voice_id="fallback-voice")
        async for _ in provider.synthesize(_tts_input_events(TTSFlush()), voice=""):
            pass

        assert "fallback-voice" in urls[0]
