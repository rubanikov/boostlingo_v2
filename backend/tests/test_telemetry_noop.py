"""Empty `.env` / unset `OTEL_*` is a telemetry no-op (AC8).

The OTel *API* stays importable; we just never install an SDK TracerProvider
or MeterProvider, so `tracer.start_as_current_span(...)` is a cheap no-op
and nothing tries to open an OTLP connection. Metrics are independently
gated on `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` — Langfuse's OTLP endpoint
is traces-only.
"""

from __future__ import annotations

import os
import socket
from unittest.mock import MagicMock

import pytest
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider as SdkMeterProvider
from opentelemetry.sdk.trace import TracerProvider as SdkTracerProvider
from starlette.testclient import TestClient

from app.config import Settings
from app.main import app
from app.observability.otel import init_telemetry, shutdown_telemetry


def test_suite_does_not_inherit_otel_env() -> None:
    leaked = [key for key in os.environ if key.startswith("OTEL_")]
    assert leaked == []


def test_empty_env_installs_no_sdk_providers() -> None:
    init_telemetry()
    try:
        assert not isinstance(trace.get_tracer_provider(), SdkTracerProvider)
        assert not isinstance(metrics.get_meter_provider(), SdkMeterProvider)
    finally:
        shutdown_telemetry()


def test_empty_env_makes_no_outbound_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    connects: list[object] = []
    original_connect = socket.socket.connect

    def _record_connect(self: socket.socket, address: object) -> None:
        connects.append(address)
        original_connect(self, address)

    monkeypatch.setattr(socket.socket, "connect", _record_connect)

    init_telemetry()
    try:
        with trace.get_tracer("telemetry-noop").start_as_current_span("unused"):
            pass
        metrics.get_meter("telemetry-noop").create_counter("unused").add(1)
    finally:
        shutdown_telemetry()

    assert connects == []


def test_metrics_endpoint_unset_does_not_install_meter_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Traces follow `OTEL_EXPORTER_OTLP_ENDPOINT`; metrics stay off without
    their own endpoint. Setters are mocked so this test cannot leak an SDK
    provider into the rest of the suite (`set_tracer_provider` is process-global
    and can only be called once)."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/api/public/otel")
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", raising=False)

    tracer_providers: list[object] = []
    meter_providers: list[object] = []

    monkeypatch.setattr(
        "app.observability.otel.trace.set_tracer_provider",
        tracer_providers.append,
    )
    monkeypatch.setattr(
        "app.observability.otel.metrics.set_meter_provider",
        meter_providers.append,
    )

    fake_span_exporter = MagicMock()
    monkeypatch.setattr("app.observability.otel.OTLPSpanExporter", lambda *a, **k: fake_span_exporter)
    monkeypatch.setattr(
        "app.observability.otel.OTLPMetricExporter",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("metrics exporter must not be constructed")),
    )

    init_telemetry()
    try:
        assert len(tracer_providers) == 1
        assert isinstance(tracer_providers[0], SdkTracerProvider)
        assert meter_providers == []
    finally:
        shutdown_telemetry()
        for provider in tracer_providers:
            shutdown = getattr(provider, "shutdown", None)
            if shutdown is not None:
                shutdown()


def test_init_telemetry_fail_open_when_exporter_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/api/public/otel")

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("exporter exploded")

    monkeypatch.setattr("app.observability.otel.OTLPSpanExporter", _boom)

    init_telemetry()
    shutdown_telemetry()


def test_observability_settings_default_off(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (
        "OBSERVABILITY_UI_TOKEN",
        "LANGFUSE_HOST",
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
        "OBSERVABILITY_MAX_SPAN_TEXT_CHARS",
        "TELEMETRY_TOKEN_TTL_SECONDS",
        "TELEMETRY_INGEST_MAX_BYTES",
        "TELEMETRY_INGEST_RATE_PER_MINUTE",
    ):
        monkeypatch.delenv(key, raising=False)

    settings = Settings(_env_file=None)
    assert settings.observability_ui_token == ""
    assert settings.langfuse_host == ""
    assert settings.langfuse_public_key == ""
    assert settings.langfuse_secret_key == ""
    assert settings.observability_max_span_text_chars == 8000
    assert settings.telemetry_token_ttl_seconds == 7200
    assert settings.telemetry_ingest_max_bytes == 16384
    assert settings.telemetry_ingest_rate_per_minute == 60


def test_app_lifespan_with_empty_otel_env_still_serves_health() -> None:
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert not isinstance(trace.get_tracer_provider(), SdkTracerProvider)
    assert not isinstance(metrics.get_meter_provider(), SdkMeterProvider)


def test_dead_collector_does_not_block_a_cascade_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC9: BatchSpanProcessor + a black-holed OTLP endpoint must not stall
    the audio path. Time the session itself, not provider shutdown."""
    import json
    import time

    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    from app import orchestrator
    from app.observability import spans as obs_spans
    from app.providers.base import TranscriptSegment, TTSFlush, TTSText

    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/v1/traces")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")

    class _STT:
        def __init__(self, api_key: str) -> None:
            pass

        async def stream(self, audio_chunks, *, languages):
            del audio_chunks, languages
            yield TranscriptSegment(text="hi", is_final=True, speech_final=True)

    class _Translation:
        def __init__(self, api_key: str) -> None:
            pass

        async def translate(self, source_text, *, source_lang, target_lang):
            del source_text, source_lang, target_lang
            yield "hola"

    class _TTS:
        def __init__(self, api_key: str, voice_id: str) -> None:
            pass

        async def synthesize(self, input_events, *, voice):
            del voice
            async for event in input_events:
                if isinstance(event, TTSFlush):
                    yield b"\x00"
                    return
                if isinstance(event, TTSText):
                    continue

    provider = TracerProvider()
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(timeout=1),
            schedule_delay_millis=60_000,
            export_timeout_millis=500,
        )
    )
    monkeypatch.setattr(obs_spans, "get_tracer", lambda: provider.get_tracer(obs_spans.TRACER_NAME))
    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _STT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _Translation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _TTS)

    try:
        with TestClient(app) as client:
            t0 = time.perf_counter()
            with client.websocket_connect("/ws/cascade") as ws:
                ws.send_json({"type": "start_session", "languages": ["en", "es"]})
                started = json.loads(ws.receive()["text"])
                assert started["type"] == "session_started"
                ws.send_bytes(b"\x00")
                kinds = []
                for _ in range(10):
                    raw = ws.receive()
                    kinds.append("binary_audio" if raw.get("bytes") is not None else json.loads(raw["text"])["type"])
            elapsed = time.perf_counter() - t0
        assert "binary_audio" in kinds
        assert elapsed < 3.0
    finally:
        provider.shutdown()
