"""Owned /summary, /traces, /traces/{id} against a faked Langfuse.

Seams: the HTTP routes in `app.api.observability`. The fake speaks Metrics
API v2 + Observations API v2 only; the deprecated GET /api/public/traces
is not implemented here and would 502 if the app called it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from collections.abc import Callable
from datetime import UTC, datetime

import httpx
import pytest

from app.config import settings
from app.main import app

pytestmark = pytest.mark.asyncio

OPERATOR_TOKEN = "test-operator-token"
EXPECTED_COOKIE = hmac.new(
    OPERATOR_TOKEN.encode("utf-8"),
    b"observability-ui-session-v1",
    hashlib.sha256,
).hexdigest()

FAKE_HOST = "http://langfuse.test"
FAKE_PUBLIC = "pk-lf-fake"
FAKE_SECRET = "sk-lf-fake"
FAKE_BASIC = base64.b64encode(f"{FAKE_PUBLIC}:{FAKE_SECRET}".encode()).decode()

FROZEN_NOW = datetime(2026, 8, 13, 18, 0, 0, tzinfo=UTC)
WINDOW_FROM = {
    "1h": "2026-08-13T17:00:00Z",
    "24h": "2026-08-12T18:00:00Z",
    "7d": "2026-08-06T18:00:00Z",
}
WINDOW_TO = "2026-08-13T18:00:00Z"

KNOWN_TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
UNKNOWN_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
CASCADE_ROOT_ID = "b7ad6b71"
SEGMENT_ID = "a11ce9f0"
STT_ID = "5dd00001"
LLM_ID = "c31e02aa"
TTS_ID = "ee1100bb"

# The real AsyncClient.get — the test's own ASGI client must fall through.
_real_get = httpx.AsyncClient.get


def _asgi_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://test",
    )


@pytest.fixture
def dashboard_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", OPERATOR_TOKEN)
    monkeypatch.setattr(settings, "langfuse_host", FAKE_HOST)
    monkeypatch.setattr(settings, "langfuse_public_key", FAKE_PUBLIC)
    monkeypatch.setattr(settings, "langfuse_secret_key", FAKE_SECRET)


@pytest.fixture
def freeze_utc_now(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.observability.langfuse_api.utc_now",
        lambda: FROZEN_NOW,
    )


def _has_root_filter(query: dict) -> bool:
    return any(
        f.get("column") == "isRootObservation" and f.get("value") is True
        for f in query.get("filters", [])
    )


def _metrics_kind(query: dict) -> str:
    measures = [m.get("measure") for m in query.get("metrics", [])]
    dims = [d.get("field") for d in query.get("dimensions", [])]
    timed = bool(query.get("timeDimension"))
    if "latency" in measures:
        return "latency_series" if timed else "latency"
    if "totalCost" in measures:
        return "cost"
    if "traceName" in dims:
        return "sessions"
    if "level" in dims:
        return "error_series" if timed else "error"
    return "other"


def _window_ok(from_ts: str | None, to_ts: str | None, window: str = "24h") -> bool:
    return from_ts == WINDOW_FROM[window] and to_ts == WINDOW_TO


def _metrics_data(query: dict) -> list[dict]:
    """Return brief-shaped rows only when the query matches the spec."""
    window = "24h"
    for label, start in WINDOW_FROM.items():
        if query.get("fromTimestamp") == start:
            window = label
            break
    if not _window_ok(query.get("fromTimestamp"), query.get("toTimestamp"), window):
        return []
    if query.get("view") != "observations":
        return []

    kind = _metrics_kind(query)
    if kind == "cost":
        if _has_root_filter(query):
            return []
        return [
            {
                "sum_totalCost": "1.42",
                "sum_totalTokens": "142000",
                "sum_inputTokens": "120000",
                "sum_outputTokens": "22000",
            }
        ]
    if not _has_root_filter(query):
        return []
    if kind == "latency":
        return [{"p50_latency": "0.145", "p95_latency": "0.320"}]
    if kind == "latency_series":
        return [
            {
                "time_dimension": "2026-08-13T17:00:00Z",
                "p50_latency": "0.140",
                "p95_latency": "0.310",
            }
        ]
    if kind == "error":
        return [
            {"level": "ERROR", "count_count": "3"},
            {"level": "DEFAULT", "count_count": "1497"},
        ]
    if kind == "error_series":
        return [
            {
                "time_dimension": "2026-08-13T17:00:00Z",
                "level": "ERROR",
                "count_count": "1",
            },
            {
                "time_dimension": "2026-08-13T17:00:00Z",
                "level": "DEFAULT",
                "count_count": "999",
            },
        ]
    if kind == "sessions":
        return [
            {"traceName": "realtime.session", "count_count": "42"},
            {"traceName": "cascade.session", "count_count": "18"},
        ]
    return []


def _root_observation(*, trace_id: str, name: str, level: str = "DEFAULT") -> dict:
    return {
        "id": CASCADE_ROOT_ID if name.startswith("cascade") else "r7ea17ime",
        "traceId": trace_id,
        "parentObservationId": None,
        "isRootObservation": True,
        "name": name,
        "traceName": name,
        "startTime": "2026-08-13T15:42:15.000Z",
        "endTime": "2026-08-13T15:42:16.200Z",
        "level": level,
        "latency": 1.2,
        "sessionId": "9f2c0001",
        "totalUsage": 4250,
        "inputUsage": 3800,
        "outputUsage": 450,
        "totalCost": 0.04,
        "providedModelName": "gpt-4o-mini",
        "metadata": {"mode": name.split(".", 1)[0], "languages": "en,es"},
    }


def _cascade_spans() -> list[dict]:
    root = _root_observation(trace_id=KNOWN_TRACE_ID, name="cascade.session", level="ERROR")
    return [
        root,
        {
            "id": SEGMENT_ID,
            "traceId": KNOWN_TRACE_ID,
            "parentObservationId": CASCADE_ROOT_ID,
            "name": "cascade.segment",
            "startTime": "2026-08-13T15:42:15.010Z",
            "endTime": "2026-08-13T15:42:16.200Z",
            "level": "DEFAULT",
            "input": None,
            "output": None,
            "metadata": {"segment.id": "seg-1"},
        },
        {
            "id": STT_ID,
            "traceId": KNOWN_TRACE_ID,
            "parentObservationId": SEGMENT_ID,
            "name": "stt.deepgram",
            "startTime": "2026-08-13T15:42:15.010Z",
            "endTime": "2026-08-13T15:42:15.060Z",
            "level": "DEFAULT",
            "input": None,
            "output": "Where is the station?",
            "metadata": {},
        },
        {
            "id": LLM_ID,
            "traceId": KNOWN_TRACE_ID,
            "parentObservationId": SEGMENT_ID,
            "name": "llm.translate",
            "startTime": "2026-08-13T15:42:15.060Z",
            "endTime": "2026-08-13T15:42:16.020Z",
            "level": "DEFAULT",
            "input": "Where is the station?",
            "output": "¿Dónde está la estación?",
            "providedModelName": "gpt-4o-mini",
            "inputUsage": 3800,
            "outputUsage": 450,
            "totalUsage": 4250,
            "totalCost": 0.042,
            "metadata": {
                "error.provider": None,
                "error.kind": None,
                "error.retryable": None,
            },
        },
        {
            "id": TTS_ID,
            "traceId": KNOWN_TRACE_ID,
            "parentObservationId": SEGMENT_ID,
            "name": "tts.elevenlabs",
            "startTime": "2026-08-13T15:42:16.020Z",
            "endTime": "2026-08-13T15:42:16.200Z",
            "level": "DEFAULT",
            "input": "¿Dónde está la estación?",
            "output": None,
            "metadata": {},
        },
    ]


def _filter_list(raw: str | None) -> list[dict]:
    if not raw:
        return []
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, list) else []


def _parent_is_null_filter(filters: list[dict]) -> bool:
    return any(
        f.get("column") == "parentObservationId"
        and f.get("operator") == "is null"
        for f in filters
    )


def _observations_page(
    params: dict[str, str],
    *,
    reject_parent_null: bool = False,
) -> tuple[int, dict]:
    filters = _filter_list(params.get("filter"))
    if reject_parent_null and _parent_is_null_filter(filters):
        return 400, {"message": "unknown filter column"}

    trace_id = params.get("traceId")
    if trace_id == KNOWN_TRACE_ID:
        return 200, {"data": _cascade_spans(), "meta": {"cursor": None}}
    if trace_id:
        return 200, {"data": [], "meta": {"cursor": None}}

    from_start = params.get("fromStartTime")
    to_start = params.get("toStartTime")
    window = "24h"
    for label, start in WINDOW_FROM.items():
        if from_start == start:
            window = label
            break
    if not _window_ok(from_start, to_start, window):
        return 200, {"data": [], "meta": {"cursor": None}}

    roots = [
        _root_observation(trace_id=KNOWN_TRACE_ID, name="cascade.session"),
        _root_observation(
            trace_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            name="realtime.session",
        ),
        _root_observation(
            trace_id="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            name="cascade.session",
            level="ERROR",
        ),
    ]
    if _parent_is_null_filter(filters) or params.get("isRootObservation") == "true":
        rows = roots
    else:
        rows = _cascade_spans() + [
            _root_observation(
                trace_id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                name="realtime.session",
            )
        ]

    mode_value = next(
        (f.get("value") for f in filters if f.get("column") == "traceName"),
        None,
    )
    if mode_value:
        rows = [r for r in rows if r.get("traceName") == mode_value or r.get("name") == mode_value]

    if any(f.get("column") == "level" and "ERROR" in (f.get("value") or []) for f in filters):
        rows = [r for r in rows if r.get("level") == "ERROR"]

    next_cursor = None
    if params.get("cursor") is None and len(rows) > 1:
        next_cursor = "opaque-cursor-page-2"
        limit = int(params.get("limit") or "25")
        rows = rows[:limit]
    elif params.get("cursor"):
        next_cursor = None

    return 200, {"data": rows, "meta": {"cursor": next_cursor}}


def _install_langfuse_fake(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request, str, dict[str, str]], httpx.Response],
) -> list[httpx.Request]:
    captured: list[httpx.Request] = []

    async def fake_get(self: httpx.AsyncClient, url: object, *args: object, **kwargs: object) -> httpx.Response:
        url_str = str(url)
        if "://" not in url_str:
            url_str = str(self.base_url.join(url_str))
        if "/api/public/v2/" not in url_str and "/api/public/traces" not in url_str:
            return await _real_get(self, url, *args, **kwargs)

        request = self.build_request("GET", url, *args, **kwargs)
        if self.auth is not None:
            request = next(self.auth.sync_auth_flow(request))
        captured.append(request)
        params = {k: v for k, v in request.url.params.multi_items()}
        return handler(request, str(request.url), params)

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return captured


def _default_langfuse_handler(
    request: httpx.Request, url: str, params: dict[str, str]
) -> httpx.Response:
    auth = request.headers.get("authorization", "")
    if auth != f"Basic {FAKE_BASIC}":
        return httpx.Response(401, json={"message": "unauthorized"}, request=request)
    if "/api/public/v2/metrics" in url:
        query = json.loads(params.get("query", "{}"))
        return httpx.Response(
            200, json={"data": _metrics_data(query)}, request=request
        )
    if "/api/public/v2/observations" in url:
        status, body = _observations_page(params)
        return httpx.Response(status, json=body, request=request)
    return httpx.Response(404, json={"message": "not found"}, request=request)


async def _login(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/observability/login", json={"token": OPERATOR_TOKEN}
    )
    assert response.status_code == 204


async def test_summary_maps_metrics_v2_shape(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured = _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/summary")

    assert response.status_code == 200
    body = response.json()
    assert body["window"] == "24h"
    assert body["from"] == "2026-08-12T18:00:00Z"
    assert body["to"] == "2026-08-13T18:00:00Z"
    assert body["latency"]["p50Ms"] == 145
    assert body["latency"]["p95Ms"] == 320
    assert body["latency"]["series"] == [
        {"t": "2026-08-13T17:00:00Z", "p50Ms": 140, "p95Ms": 310}
    ]
    assert body["errorRate"]["rate"] == pytest.approx(0.002)
    assert body["errorRate"]["errorCount"] == 3
    assert body["errorRate"]["totalCount"] == 1500
    assert body["errorRate"]["series"] == [
        {"t": "2026-08-13T17:00:00Z", "rate": pytest.approx(0.001)}
    ]
    assert body["cost"] == {
        "totalUsd": 1.42,
        "totalTokens": 142000,
        "inputTokens": 120000,
        "outputTokens": 22000,
    }
    assert body["sessions"] == {"realtime": 42, "cascade": 18}
    assert FAKE_SECRET not in response.text
    assert FAKE_PUBLIC not in response.text
    assert all("/api/public/traces" not in str(r.url) or "/v2/" in str(r.url) for r in captured)
    assert any("/api/public/v2/metrics" in str(r.url) for r in captured)


@pytest.mark.parametrize("window", ["1h", "24h", "7d"])
async def test_summary_window_is_server_utc(
    window: str,
    dashboard_enabled: None,
    freeze_utc_now: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(
            "/api/observability/summary", params={"window": window}
        )

    assert response.status_code == 200
    body = response.json()
    assert body["window"] == window
    assert body["from"] == WINDOW_FROM[window]
    assert body["to"] == WINDOW_TO


async def test_summary_defaults_to_24h(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/summary")

    assert response.status_code == 200
    assert response.json()["window"] == "24h"


async def test_healthy_empty_langfuse_is_200_with_nulls_not_zeros(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def empty_handler(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        del params
        if "/api/public/v2/metrics" in url:
            return httpx.Response(200, json={"data": []}, request=request)
        if "/api/public/v2/observations" in url:
            return httpx.Response(
                200, json={"data": [], "meta": {"cursor": None}}, request=request
            )
        return httpx.Response(404, json={}, request=request)

    _install_langfuse_fake(monkeypatch, empty_handler)
    async with _asgi_client() as client:
        await _login(client)
        summary = await client.get("/api/observability/summary")
        traces = await client.get("/api/observability/traces")

    assert summary.status_code == 200
    body = summary.json()
    assert body["latency"]["p50Ms"] is None
    assert body["latency"]["p95Ms"] is None
    assert body["latency"]["series"] == []
    assert body["errorRate"]["rate"] is None
    assert body["errorRate"]["errorCount"] is None
    assert body["errorRate"]["totalCount"] is None
    assert body["errorRate"]["series"] == []
    assert body["cost"]["totalUsd"] is None
    assert body["cost"]["totalTokens"] is None
    assert body["cost"]["inputTokens"] is None
    assert body["cost"]["outputTokens"] is None
    assert body["sessions"]["realtime"] is None
    assert body["sessions"]["cascade"] is None
    # Missing data is null/[] — never a fabricated 0.
    assert 0 not in (
        body["latency"]["p50Ms"],
        body["errorRate"]["rate"],
        body["cost"]["totalUsd"],
        body["sessions"]["realtime"],
        body["sessions"]["cascade"],
    )

    assert traces.status_code == 200
    listed = traces.json()
    assert listed["traces"] == []
    assert listed["nextCursor"] is None
    assert listed["hasMore"] is False


async def test_traces_list_maps_root_observations(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured = _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/traces")

    assert response.status_code == 200
    body = response.json()
    assert body["hasMore"] is True
    assert body["nextCursor"] == "opaque-cursor-page-2"
    assert len(body["traces"]) >= 1
    row = next(t for t in body["traces"] if t["traceId"] == KNOWN_TRACE_ID)
    assert row["timestamp"] == "2026-08-13T15:42:15Z"
    assert row["mode"] == "cascade"
    assert row["latencyMs"] == 1200
    assert row["totalTokens"] == 4250
    assert row["costUsd"] == 0.04
    assert row["status"] == "success"
    assert any("/api/public/v2/observations" in str(r.url) for r in captured)
    assert all("/api/public/v2/" in str(r.url) or "/api/observability/" in str(r.url) for r in captured)


async def test_traces_mode_and_status_filters(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        realtime = await client.get(
            "/api/observability/traces", params={"mode": "realtime"}
        )
        errors = await client.get(
            "/api/observability/traces", params={"status": "error"}
        )

    assert realtime.status_code == 200
    modes = {t["mode"] for t in realtime.json()["traces"]}
    assert modes <= {"realtime"}

    assert errors.status_code == 200
    assert all(t["status"] == "error" for t in errors.json()["traces"])


async def test_traces_limit_default_and_bounds(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        too_low = await client.get("/api/observability/traces", params={"limit": 0})
        too_high = await client.get("/api/observability/traces", params={"limit": 101})
        ok = await client.get("/api/observability/traces", params={"limit": 1})

    assert too_low.status_code == 422
    assert too_high.status_code == 422
    assert ok.status_code == 200


async def test_trace_detail_is_depth_first_with_offsets(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{KNOWN_TRACE_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["traceId"] == KNOWN_TRACE_ID
    assert body["mode"] == "cascade"
    assert body["status"] == "error"
    assert body["totalLatencyMs"] == 1200
    names = [s["name"] for s in body["spans"]]
    assert names == [
        "cascade.session",
        "cascade.segment",
        "stt.deepgram",
        "llm.translate",
        "tts.elevenlabs",
    ]
    depths = [s["depth"] for s in body["spans"]]
    assert depths == [0, 1, 2, 2, 2]
    offsets = [s["startOffsetMs"] for s in body["spans"]]
    assert offsets == [0, 10, 10, 60, 1020]
    assert body["spans"][0]["parentSpanId"] is None
    assert body["spans"][1]["parentSpanId"] == CASCADE_ROOT_ID
    llm = body["spans"][3]
    assert llm["input"] == "Where is the station?"
    assert llm["output"] == "¿Dónde está la estación?"
    assert llm["truncated"] is False
    assert llm["durationMs"] == 960
    assert "tool_call" not in names


async def test_one_span_trace_is_a_single_row(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    solo_id = "cccccccccccccccccccccccccccccccc"

    def solo_handler(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        if "/api/public/v2/observations" in url and params.get("traceId") == solo_id:
            root = _root_observation(trace_id=solo_id, name="realtime.session")
            return httpx.Response(
                200, json={"data": [root], "meta": {"cursor": None}}, request=request
            )
        return _default_langfuse_handler(request, url, params)

    _install_langfuse_fake(monkeypatch, solo_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{solo_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "realtime"
    assert len(body["spans"]) == 1
    assert body["spans"][0]["depth"] == 0
    assert body["spans"][0]["startOffsetMs"] == 0
    assert body["spans"][0]["parentSpanId"] is None


async def test_truncated_flag_is_surfaced(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    solo_id = "dddddddddddddddddddddddddddddddd"

    def trunc_handler(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        if "/api/public/v2/observations" in url and params.get("traceId") == solo_id:
            root = _root_observation(trace_id=solo_id, name="cascade.session")
            root["input"] = "x" * 9000
            root["metadata"] = {"input.text.truncated": True}
            return httpx.Response(
                200, json={"data": [root], "meta": {"cursor": None}}, request=request
            )
        return _default_langfuse_handler(request, url, params)

    _install_langfuse_fake(monkeypatch, trunc_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{solo_id}")

    assert response.status_code == 200
    span = response.json()["spans"][0]
    assert span["truncated"] is True
    assert span["input"] is not None
    assert len(span["input"]) <= settings.observability_max_span_text_chars


@pytest.mark.parametrize(
    "trace_id",
    ["nope", "ABCDEF0123456789abcdef01", "0af7", "xyz" + "a" * 16, "gg" + "a" * 30],
)
async def test_malformed_trace_id_is_422(
    trace_id: str,
    dashboard_enabled: None,
    freeze_utc_now: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{trace_id}")

    assert response.status_code == 422


async def test_unknown_well_formed_trace_id_is_404(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_langfuse_fake(monkeypatch, _default_langfuse_handler)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{UNKNOWN_TRACE_ID}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Trace not found."}


async def test_connect_error_is_503(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(self: httpx.AsyncClient, url: object, *args: object, **kwargs: object) -> httpx.Response:
        url_str = str(url)
        if "://" not in url_str:
            url_str = str(self.base_url.join(url_str))
        if "/api/public/v2/" not in url_str:
            return await _real_get(self, url, *args, **kwargs)
        raise httpx.ConnectError(
            "connection refused", request=httpx.Request("GET", url_str)
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", boom)
    async with _asgi_client() as client:
        await _login(client)
        summary = await client.get("/api/observability/summary")
        traces = await client.get("/api/observability/traces")
        detail = await client.get(f"/api/observability/traces/{KNOWN_TRACE_ID}")

    assert summary.status_code == 503
    assert traces.status_code == 503
    assert detail.status_code == 503
    assert "detail" in summary.json()


async def test_malformed_2xx_body_is_502(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def bad_json(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        del url, params
        return httpx.Response(200, content=b"not-json", request=request)

    _install_langfuse_fake(monkeypatch, bad_json)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/summary")

    assert response.status_code == 502
    assert "detail" in response.json()


async def test_non_2xx_langfuse_is_502(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def upstream_500(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        del url, params
        return httpx.Response(500, json={"message": "boom"}, request=request)

    _install_langfuse_fake(monkeypatch, upstream_500)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/traces")

    assert response.status_code == 502


async def test_unusable_metrics_payload_is_502(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def weird(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        if "/api/public/v2/metrics" in url:
            return httpx.Response(200, json={"data": "nope"}, request=request)
        return _default_langfuse_handler(request, url, params)

    _install_langfuse_fake(monkeypatch, weird)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/summary")

    assert response.status_code == 502


async def test_trace_detail_without_cookie_is_401(dashboard_enabled: None) -> None:
    async with _asgi_client() as client:
        response = await client.get(f"/api/observability/traces/{KNOWN_TRACE_ID}")

    assert response.status_code == 401


async def test_trace_detail_when_disabled_is_404(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", "")
    async with _asgi_client() as client:
        response = await client.get(f"/api/observability/traces/{KNOWN_TRACE_ID}")

    assert response.status_code == 404
    assert response.json() == {
        "detail": "Observability is not enabled on this server."
    }


async def test_trace_detail_is_503_when_langfuse_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", OPERATOR_TOKEN)
    monkeypatch.setattr(settings, "langfuse_host", "")
    monkeypatch.setattr(settings, "langfuse_public_key", "")
    monkeypatch.setattr(settings, "langfuse_secret_key", "")
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(f"/api/observability/traces/{KNOWN_TRACE_ID}")

    assert response.status_code == 503
    assert "latency" not in response.json()
    assert "spans" not in response.json()


async def test_invalid_window_is_422(dashboard_enabled: None) -> None:
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get(
            "/api/observability/summary", params={"window": "2h"}
        )

    assert response.status_code == 422


async def test_parent_null_filter_fallback_groups_by_trace(
    dashboard_enabled: None, freeze_utc_now: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def rejecting(request: httpx.Request, url: str, params: dict[str, str]) -> httpx.Response:
        if "/api/public/v2/observations" in url and not params.get("traceId"):
            status, body = _observations_page(params, reject_parent_null=True)
            return httpx.Response(status, json=body, request=request)
        return _default_langfuse_handler(request, url, params)

    _install_langfuse_fake(monkeypatch, rejecting)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/traces")

    assert response.status_code == 200
    modes = {t["mode"] for t in response.json()["traces"]}
    assert modes <= {"cascade", "realtime"}
    names_as_modes = {t["mode"] for t in response.json()["traces"]}
    assert "cascade" in names_as_modes or "realtime" in names_as_modes


@pytest.mark.skipif(
    not (
        settings.langfuse_host
        and settings.langfuse_public_key
        and settings.langfuse_secret_key
    ),
    reason=(
        "requires live LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY"
    ),
)
async def test_live_langfuse_summary_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", OPERATOR_TOKEN)
    async with _asgi_client() as client:
        await _login(client)
        response = await client.get("/api/observability/summary")

    assert response.status_code in (200, 502, 503)
    if response.status_code == 200:
        body = response.json()
        assert body["window"] == "24h"
        assert "latency" in body
        assert "errorRate" in body
        assert "cost" in body
        assert "sessions" in body
        assert FAKE_SECRET not in response.text
        assert settings.langfuse_secret_key not in response.text
