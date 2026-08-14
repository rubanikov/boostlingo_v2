"""Cascade session traces: parent/name/text shape, resume-as-one-trace,
fail-open, truncation, and Cascade-half metrics (AC1, AC2, AC6, AC9, AC16).
"""

from __future__ import annotations

import json
import time
from collections.abc import Sequence
from unittest.mock import AsyncMock

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.trace import StatusCode
from starlette.testclient import TestClient

from app import orchestrator
from app.config import settings
from app.main import app
from app.observability import metrics as obs_metrics
from app.observability import spans as obs_spans
from app.origins import is_allowed_origin
from app.providers.base import (
    ProviderError,
    ProviderErrorKind,
    TranscriptSegment,
    TTSFlush,
    TTSText,
)
from app.providers.openai_translation import OpenAITranslationProvider


class _MemoryExporter:
    def __init__(self) -> None:
        self.spans: list[ReadableSpan] = []

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:
        pass

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        del timeout_millis
        return True


class _FakeSTT:
    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        yield TranscriptSegment(text="hello", is_final=False, speech_final=False)
        yield TranscriptSegment(text="hello world", is_final=True, speech_final=True)


class _FakeIdleSTT:
    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        return
        yield  # pragma: no cover


class _FakeOneSegmentPerAudioChunkSTT:
    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del languages
        i = 0
        async for _ in audio_chunks:
            i += 1
            yield TranscriptSegment(text=f"segment {i}", is_final=True, speech_final=True)


class _FakeTranslation:
    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang):
        del source_text, source_lang, target_lang
        for piece in ["Hola", " mundo"]:
            yield piece


class _FakeTTS:
    def __init__(self, api_key: str, voice_id: str) -> None:
        pass

    async def synthesize(self, input_events, *, voice):
        del voice
        async for event in input_events:
            if isinstance(event, TTSText):
                continue
            if isinstance(event, TTSFlush):
                yield b"\x01\x02\x03"
                return


class _UnreachableTranslation:
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
    return session_started["sessionId"]


def _drain_one_segment(ws, extra: int = 0) -> list[dict]:
    return [ws.receive() for _ in range(12 + extra)]


def _named(spans: Sequence[ReadableSpan], name: str) -> list[ReadableSpan]:
    return [span for span in spans if span.name == name]


def _metric_names(metrics_data) -> set[str]:
    names: set[str] = set()
    if metrics_data is None:
        return names
    for resource in metrics_data.resource_metrics:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                names.add(metric.name)
    return names


def _patch_fakes(monkeypatch: pytest.MonkeyPatch, *, stt=None, translation=None, tts=None) -> None:
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", stt or _FakeSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", translation or _FakeTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", tts or _FakeTTS)


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def memory_spans(monkeypatch: pytest.MonkeyPatch) -> _MemoryExporter:
    exporter = _MemoryExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer(obs_spans.TRACER_NAME)
    monkeypatch.setattr(obs_spans, "get_tracer", lambda: tracer)
    yield exporter
    provider.shutdown()


@pytest.fixture()
def memory_metrics(monkeypatch: pytest.MonkeyPatch) -> InMemoryMetricReader:
    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(obs_metrics.metrics, "get_meter", provider.get_meter)
    yield reader
    provider.shutdown()


class TestOrigins:
    def test_missing_origin_is_allowed(self) -> None:
        assert is_allowed_origin(None) is True

    def test_allowlisted_origin_is_allowed(self) -> None:
        assert is_allowed_origin(settings.cors_origins[0]) is True

    def test_unknown_origin_is_rejected(self) -> None:
        assert is_allowed_origin("https://evil.example") is False


class TestTruncationHelper:
    def test_text_over_limit_is_cut_and_flagged(self, memory_spans: _MemoryExporter) -> None:
        span = obs_spans.get_tracer().start_span("t")
        obs_spans.set_text_attribute(span, "input.text", "x" * 8001)
        span.end()

        finished = memory_spans.spans[0]
        assert finished.attributes["input.text"] == "x" * 8000
        assert finished.attributes["input.text.truncated"] is True

    def test_text_at_limit_is_not_flagged(self, memory_spans: _MemoryExporter) -> None:
        span = obs_spans.get_tracer().start_span("t")
        obs_spans.set_text_attribute(span, "input.text", "y" * 8000)
        span.end()

        finished = memory_spans.spans[0]
        assert finished.attributes["input.text"] == "y" * 8000
        assert "input.text.truncated" not in (finished.attributes or {})


class TestCascadeSpanTree:
    def test_session_segment_stt_llm_tts_parents_and_text(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, memory_spans: _MemoryExporter
    ) -> None:
        _patch_fakes(monkeypatch)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")
            raw = _drain_one_segment(ws)
        assert _message_kind(raw[-1]) == "binary_audio"

        spans = memory_spans.spans
        sessions = _named(spans, "cascade.session")
        segments = _named(spans, "cascade.segment")
        stt = _named(spans, "stt.deepgram")
        llm = _named(spans, "llm.translate")
        tts = _named(spans, "tts.elevenlabs")
        assert len(sessions) == 1
        assert len(segments) == 1
        assert len(stt) == 1
        assert len(llm) == 1
        assert len(tts) == 1

        session, segment = sessions[0], segments[0]
        assert session.parent is None
        assert segment.parent.span_id == session.context.span_id
        assert stt[0].parent.span_id == segment.context.span_id
        assert llm[0].parent.span_id == segment.context.span_id
        assert tts[0].parent.span_id == segment.context.span_id
        trace_ids = {s.context.trace_id for s in (session, segment, stt[0], llm[0], tts[0])}
        assert len(trace_ids) == 1

        assert session.attributes["mode"] == "cascade"
        assert session.attributes["languages"] == "en,es"
        assert stt[0].attributes["input.text"] == "hello world"
        assert llm[0].attributes["gen_ai.prompt"] == "hello world"
        assert llm[0].attributes["gen_ai.completion"] == "Hola mundo"
        assert tts[0].attributes["tts.audio_bytes"] == 3
        assert llm[0].attributes["retry.attempt"] == 0

        event_names = {event.name for event in llm[0].events}
        assert "translation_first_token" in event_names
        tts_events = {event.name for event in tts[0].events}
        assert "tts_first_byte" in tts_events

        for span in spans:
            for value in (span.attributes or {}).values():
                assert not isinstance(value, (bytes, bytearray))

    def test_span_text_over_8000_is_truncated_and_still_exported(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, memory_spans: _MemoryExporter
    ) -> None:
        long_text = "z" * 8001

        class _LongSTT:
            def __init__(self, api_key: str) -> None:
                pass

            async def stream(self, audio_chunks, *, languages):
                del audio_chunks, languages
                yield TranscriptSegment(text=long_text, is_final=True, speech_final=True)

        _patch_fakes(monkeypatch, stt=_LongSTT)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            _drain_one_segment(ws, extra=-1)

        stt = _named(memory_spans.spans, "stt.deepgram")[0]
        assert stt.attributes["input.text"] == "z" * 8000
        assert stt.attributes["input.text.truncated"] is True
        llm = _named(memory_spans.spans, "llm.translate")[0]
        assert llm.attributes["gen_ai.prompt"] == "z" * 8000
        assert llm.attributes["gen_ai.prompt.truncated"] is True


class TestLlmUsage:
    def test_usage_only_chunk_lands_on_gen_ai_attributes(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, memory_spans: _MemoryExporter
    ) -> None:
        class _Usage:
            prompt_tokens = 12
            completion_tokens = 4

        class _Chunk:
            def __init__(self, content: str | None, usage=None) -> None:
                self.choices = (
                    [type("Choice", (), {"delta": type("Delta", (), {"content": content})()})]
                    if content is not None
                    else []
                )
                self.usage = usage

        class _Stream:
            def __aiter__(self):
                return self._drain()

            async def _drain(self):
                yield _Chunk("Hola")
                yield _Chunk(None, usage=_Usage())

        class _Provider(OpenAITranslationProvider):
            def __init__(self, api_key: str) -> None:
                super().__init__(api_key)
                self._client.chat.completions.create = AsyncMock(return_value=_Stream())

        _patch_fakes(monkeypatch, translation=_Provider)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            _drain_one_segment(ws, extra=-1)

        llm = _named(memory_spans.spans, "llm.translate")[0]
        assert llm.attributes["gen_ai.request.model"] == "gpt-4o-mini"
        assert llm.attributes["gen_ai.usage.input_tokens"] == 12
        assert llm.attributes["gen_ai.usage.output_tokens"] == 4
        assert llm.attributes["gen_ai.usage.cost"] == pytest.approx(4.2e-6)


class TestResumeAndGrace:
    @pytest.fixture()
    def shared_portal_client(self):
        with TestClient(app) as test_client:
            yield test_client

    def test_ws_resume_within_grace_window_is_one_session_trace(
        self,
        shared_portal_client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        memory_spans: _MemoryExporter,
    ) -> None:
        _patch_fakes(monkeypatch, stt=_FakeOneSegmentPerAudioChunkSTT)
        with shared_portal_client.websocket_connect("/ws/cascade") as ws1:
            session_id = _start_session(ws1, languages=["en", "es"])
            ws1.send_bytes(b"\x00")
            _drain_one_segment(ws1, extra=-1)
            ws1.close(code=1006)
            time.sleep(0.1)

        assert session_id in orchestrator._detached_sessions

        with shared_portal_client.websocket_connect("/ws/cascade") as ws2:
            ws2.send_json({"type": "resume_session", "sessionId": session_id})
            ws2.send_bytes(b"\x00")
            _drain_one_segment(ws2, extra=-1)

        sessions = _named(memory_spans.spans, "cascade.session")
        assert len(sessions) == 1
        segments = _named(memory_spans.spans, "cascade.segment")
        assert len(segments) == 2
        assert {seg.context.trace_id for seg in segments} == {sessions[0].context.trace_id}

    def test_grace_expiry_ends_session_span_error(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, memory_spans: _MemoryExporter
    ) -> None:
        monkeypatch.setattr(orchestrator, "GRACE_WINDOW_S", 0.05)
        _patch_fakes(monkeypatch, stt=_FakeIdleSTT, translation=_UnreachableTranslation)
        with client.websocket_connect("/ws/cascade") as ws1:
            _start_session(ws1, languages=["en", "es"])
            ws1.close(code=1006)
            time.sleep(0.3)

        sessions = _named(memory_spans.spans, "cascade.session")
        assert len(sessions) == 1
        assert sessions[0].status.status_code is StatusCode.ERROR
        assert sessions[0].attributes["session.end_reason"] == "grace_window_expired"


class TestProviderErrorSpans:
    @pytest.mark.parametrize(
        "kind,retryable,provider",
        [
            (ProviderErrorKind.RATE_LIMIT, True, "openai"),
            (ProviderErrorKind.TIMEOUT, True, "openai"),
            (ProviderErrorKind.EMPTY_RESULT, True, "translation"),
            (ProviderErrorKind.CONNECTION, True, "openai"),
            (ProviderErrorKind.UNKNOWN, False, "openai"),
        ],
    )
    def test_translation_provider_error_sets_error_attributes(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        memory_spans: _MemoryExporter,
        kind: ProviderErrorKind,
        retryable: bool,
        provider: str,
    ) -> None:
        async def _fake_sleep(_seconds: float) -> None:
            return None

        monkeypatch.setattr(orchestrator.asyncio, "sleep", _fake_sleep)

        class _Failing:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                del source_text, source_lang, target_lang
                raise ProviderError(kind, provider, "boom", retryable=retryable)
                yield  # pragma: no cover

        _patch_fakes(monkeypatch, translation=_Failing)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            messages = []
            for _ in range(8):
                raw = ws.receive()
                messages.append(raw)
                if _message_kind(raw) == "error" and json.loads(raw["text"]).get("kind") != "circuit_open":
                    break

        llm_spans = _named(memory_spans.spans, "llm.translate")
        assert llm_spans
        errored = [span for span in llm_spans if span.status.status_code is StatusCode.ERROR]
        assert errored
        attrs = errored[-1].attributes
        assert attrs["error.provider"] == provider
        assert attrs["error.kind"] == kind.name
        assert attrs["error.retryable"] is retryable

    def test_stt_exhausted_emits_standalone_provider_error(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, memory_spans: _MemoryExporter
    ) -> None:
        class _FailingSTT:
            def __init__(self, api_key: str) -> None:
                pass

            async def stream(self, audio_chunks, *, languages):
                del audio_chunks, languages
                raise ProviderError(ProviderErrorKind.CONNECTION, "deepgram", "gone", retryable=True)
                yield  # pragma: no cover

        _patch_fakes(monkeypatch, stt=_FailingSTT, translation=_UnreachableTranslation)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            error = json.loads(ws.receive()["text"])

        assert error["type"] == "error"
        assert error["provider"] == "deepgram"
        standalone = _named(memory_spans.spans, "provider.error")
        assert len(standalone) == 1
        assert standalone[0].status.status_code is StatusCode.ERROR
        assert standalone[0].attributes["error.provider"] == "deepgram"
        assert standalone[0].attributes["error.kind"] == "CONNECTION"
        assert standalone[0].attributes["error.retryable"] is True
        assert not _named(memory_spans.spans, "llm.translate")


class TestFailOpen:
    def test_raising_tracer_does_not_drop_the_segment(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class _RaisingTracer:
            def start_span(self, *args, **kwargs):
                raise RuntimeError("tracer exploded")

            def start_as_current_span(self, *args, **kwargs):
                raise RuntimeError("tracer exploded")

        monkeypatch.setattr(obs_spans, "get_tracer", lambda: _RaisingTracer())
        _patch_fakes(monkeypatch)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00\x01")
            raw = _drain_one_segment(ws)
        kinds = [_message_kind(m) for m in raw]
        assert "binary_audio" in kinds
        assert kinds[-1] == "binary_audio"

    def test_raising_exporter_does_not_kill_the_session(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        class _RaisingExporter:
            def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
                raise RuntimeError("exporter exploded")

            def shutdown(self) -> None:
                pass

            def force_flush(self, timeout_millis: int = 30000) -> bool:
                del timeout_millis
                return True

        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(_RaisingExporter()))
        tracer = provider.get_tracer(obs_spans.TRACER_NAME)
        monkeypatch.setattr(obs_spans, "get_tracer", lambda: tracer)
        _patch_fakes(monkeypatch)
        try:
            with client.websocket_connect("/ws/cascade") as ws:
                _start_session(ws, languages=["en", "es"])
                ws.send_bytes(b"\x00\x01")
                raw = _drain_one_segment(ws)
            assert _message_kind(raw[-1]) == "binary_audio"
        finally:
            provider.shutdown()


class TestCascadeMetrics:
    def test_seams_record_stage_turn_token_cost_and_errors(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        memory_spans: _MemoryExporter,
        memory_metrics: InMemoryMetricReader,
    ) -> None:
        class _Usage:
            prompt_tokens = 12
            completion_tokens = 4

        class _Chunk:
            def __init__(self, content: str | None, usage=None) -> None:
                self.choices = (
                    [type("Choice", (), {"delta": type("Delta", (), {"content": content})()})]
                    if content is not None
                    else []
                )
                self.usage = usage

        class _Stream:
            def __aiter__(self):
                return self._drain()

            async def _drain(self):
                yield _Chunk("Hola")
                yield _Chunk(None, usage=_Usage())

        class _Provider(OpenAITranslationProvider):
            def __init__(self, api_key: str) -> None:
                super().__init__(api_key)
                self._client.chat.completions.create = AsyncMock(return_value=_Stream())

        _patch_fakes(monkeypatch, translation=_Provider)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            _drain_one_segment(ws, extra=-1)

        names = _metric_names(memory_metrics.get_metrics_data())
        assert obs_metrics.STAGE_DURATION in names
        assert obs_metrics.TURN_DURATION in names
        assert obs_metrics.LLM_TOKENS in names
        assert obs_metrics.LLM_COST in names

    def test_provider_error_increments_error_counter(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        memory_spans: _MemoryExporter,
        memory_metrics: InMemoryMetricReader,
    ) -> None:
        class _Failing:
            def __init__(self, api_key: str) -> None:
                pass

            async def translate(self, source_text, *, source_lang, target_lang):
                raise ProviderError(ProviderErrorKind.CONNECTION, "openai", "boom", retryable=True)
                yield  # pragma: no cover

        _patch_fakes(monkeypatch, translation=_Failing)
        with client.websocket_connect("/ws/cascade") as ws:
            _start_session(ws, languages=["en", "es"])
            ws.send_bytes(b"\x00")
            for _ in range(8):
                raw = ws.receive()
                if _message_kind(raw) == "error":
                    break

        names = _metric_names(memory_metrics.get_metrics_data())
        assert obs_metrics.ERRORS in names
