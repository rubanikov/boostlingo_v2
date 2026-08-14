"""POST /api/telemetry/realtime/turn: auth order, caps, and span emit."""

from __future__ import annotations

import json
import time

import httpx
import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.config import settings
from app.main import app
from app.observability.telemetry_tokens import (
    mint_telemetry_token,
    reset_ingest_rate_limiter,
    verify_telemetry_token,
)

pytestmark = pytest.mark.asyncio

TURN_PATH = "/api/telemetry/realtime/turn"
ALLOWED_ORIGIN = "http://localhost:5173"
KNOWN_TID = "0af7651916cd43dd8448eb211c80319c"

VALID_TURN = {
    "turnIndex": 3,
    "startedAt": "2026-08-13T15:42:15.120Z",
    "endedAt": "2026-08-13T15:42:16.320Z",
    "latencyMs": 1200,
    "sourceText": "Where is the station?",
    "targetText": "¿Dónde está la estación?",
    "sourceLanguage": "en",
    "targetLanguage": "es",
    "model": "gpt-realtime",
    "usage": {"inputTokens": 320, "outputTokens": 210},
    "error": None,
}


@pytest.fixture(autouse=True)
def _reset_rate_limiter() -> None:
    reset_ingest_rate_limiter()
    yield
    reset_ingest_rate_limiter()


def _token(*, sid: str = "aabbccddeeff00112233445566778899", exp: int | None = None) -> str:
    return mint_telemetry_token(
        sid=sid,
        tid=KNOWN_TID,
        exp=int(time.time()) + 7200 if exp is None else exp,
    )


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _post(
    *,
    json_body: dict | None = None,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
    origin: str | None = None,
) -> httpx.Response:
    req_headers = dict(headers or {})
    if origin is not None:
        req_headers["Origin"] = origin
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        if content is not None:
            return await client.post(TURN_PATH, content=content, headers=req_headers)
        return await client.post(TURN_PATH, json=json_body, headers=req_headers)


async def test_valid_turn_returns_202_when_observability_is_off() -> None:
    response = await _post(json_body=VALID_TURN, headers=_auth(_token()))

    assert response.status_code == 202
    assert response.json() == {"accepted": True}


async def test_valid_turn_emits_realtime_turn_in_token_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import InMemoryMetricReader

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr("app.observability.spans.trace.get_tracer", provider.get_tracer)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1/otel")

    reader = InMemoryMetricReader()
    meter_provider = MeterProvider(metric_readers=[reader])
    monkeypatch.setattr(
        "app.observability.metrics.metrics.get_meter",
        meter_provider.get_meter,
    )

    token = _token()
    claims = verify_telemetry_token(token, now=int(time.time()))
    assert claims is not None

    response = await _post(json_body=VALID_TURN, headers=_auth(token))

    assert response.status_code == 202
    assert response.json() == {"accepted": True}

    turns = [s for s in exporter.get_finished_spans() if s.name == "realtime.turn"]
    assert len(turns) == 1
    assert format(turns[0].context.trace_id, "032x") == claims.tid

    recorded = []
    data = reader.get_metrics_data()
    if data is not None:
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    if metric.name == "interpreter.turn.duration":
                        recorded.extend(metric.data.data_points)
    assert recorded
    assert any(getattr(point, "attributes", {}).get("mode") == "realtime" for point in recorded)


async def test_expired_token_returns_401_and_emits_no_span(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr("app.observability.spans.trace.get_tracer", provider.get_tracer)

    response = await _post(
        json_body=VALID_TURN,
        headers=_auth(_token(exp=1)),
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired telemetry token."}
    assert [s.name for s in exporter.get_finished_spans()] == []


async def test_tampered_token_signature_returns_401() -> None:
    token = _token()
    payload, sep, signature = token.partition(".")
    flipped = "A" if not signature.startswith("A") else "B"
    tampered = f"{payload}{sep}{flipped}{signature[1:]}"

    response = await _post(json_body=VALID_TURN, headers=_auth(tampered))

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired telemetry token."}


async def test_disallowed_origin_returns_403() -> None:
    response = await _post(
        json_body=VALID_TURN,
        headers=_auth(_token()),
        origin="https://evil.example",
    )

    assert response.status_code == 403


async def test_missing_origin_is_accepted() -> None:
    response = await _post(json_body=VALID_TURN, headers=_auth(_token()))

    assert response.status_code == 202
    assert response.json() == {"accepted": True}


async def test_allowlisted_origin_is_accepted() -> None:
    assert ALLOWED_ORIGIN in settings.cors_origins
    response = await _post(
        json_body=VALID_TURN,
        headers=_auth(_token()),
        origin=ALLOWED_ORIGIN,
    )

    assert response.status_code == 202


async def test_payload_over_16kib_returns_413() -> None:
    oversized = dict(VALID_TURN)
    oversized["sourceText"] = "x" * 20_000
    body = json.dumps(oversized).encode()
    assert len(body) > 16384

    response = await _post(content=body, headers={
        **_auth(_token()),
        "Content-Type": "application/json",
    })

    assert response.status_code == 413


async def test_sixty_first_request_in_a_minute_returns_429() -> None:
    token = _token()
    headers = _auth(token)
    last = None
    for _ in range(60):
        last = await _post(json_body=VALID_TURN, headers=headers)
        assert last.status_code == 202
    overflow = await _post(json_body=VALID_TURN, headers=headers)

    assert overflow.status_code == 429


async def test_unknown_json_field_returns_422() -> None:
    body = dict(VALID_TURN)
    body["unexpected"] = "nope"

    response = await _post(json_body=body, headers=_auth(_token()))

    assert response.status_code == 422


async def test_missing_required_turn_field_returns_422() -> None:
    body = dict(VALID_TURN)
    del body["latencyMs"]

    response = await _post(json_body=body, headers=_auth(_token()))

    assert response.status_code == 422


async def test_auth_order_origin_wins_over_size_rate_and_token() -> None:
    oversized = dict(VALID_TURN)
    oversized["sourceText"] = "x" * 20_000
    body = json.dumps(oversized).encode()

    response = await _post(
        content=body,
        headers={
            "Authorization": "Bearer not-a-token",
            "Content-Type": "application/json",
        },
        origin="https://evil.example",
    )

    assert response.status_code == 403


async def test_auth_order_size_wins_over_rate_and_token() -> None:
    oversized = dict(VALID_TURN)
    oversized["sourceText"] = "x" * 20_000
    body = json.dumps(oversized).encode()

    response = await _post(
        content=body,
        headers={
            "Authorization": "Bearer not-a-token",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 413


async def test_auth_order_rate_limit_wins_over_bad_token() -> None:
    sid = "0123456789abcdef0123456789abcdef"
    good = _token(sid=sid)
    for _ in range(60):
        assert (await _post(json_body=VALID_TURN, headers=_auth(good))).status_code == 202

    response = await _post(
        json_body=VALID_TURN,
        headers={"Authorization": "Bearer not-a-token"},
    )
    # The bad token has no parseable sid, so it cannot share the bucket.
    # A parseable-but-invalid token with the same sid must 429 first.
    payload_ok_sig_bad = good.rsplit(".", 1)[0] + ".AAAAAAAAAAA"
    limited = await _post(
        json_body=VALID_TURN,
        headers=_auth(payload_ok_sig_bad),
    )
    assert limited.status_code == 429
    assert response.status_code == 401


async def test_missing_authorization_returns_401() -> None:
    response = await _post(json_body=VALID_TURN)

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or expired telemetry token."}
