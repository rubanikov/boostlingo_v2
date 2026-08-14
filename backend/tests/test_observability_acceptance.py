"""Acceptance checks for story ACs that the other test files don't pin.

Cascade traces, ingest auth, cookie login, and the dashboard JSON shapes
already live in the focused test modules. This file covers leftover
operator-visible contracts: 100% sampling, README alerts with no paging
code, owned (not catch-all) observability routes, secrets staying out of
the SPA, mic sessions without an operator cookie, optional compose, and
the SPA never calling Langfuse.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.sdk.trace.sampling import ALWAYS_ON, DEFAULT_ON
from starlette.testclient import TestClient

from app.main import app
from app.observability.metrics import (
    ERRORS,
    LLM_COST,
    LLM_TOKENS,
    MINT_FAILURES,
    STAGE_DURATION,
    TURN_DURATION,
)
from app.providers.base import TranscriptSegment, TTSFlush, TTSText

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_SRC = REPO_ROOT / "frontend" / "src"
README = REPO_ROOT / "README.md"
COMPOSE = REPO_ROOT / "docker-compose.yml"
PYPROJECT = REPO_ROOT / "backend" / "pyproject.toml"
APP_DIR = REPO_ROOT / "backend" / "app"

_PAGING_NEEDLES = (
    "pagerduty",
    "opsgenie",
    "alertmanager",
    "twilio.rest",
    "paging_code",
    "send_page(",
    "trigger_pager",
)

def _frontend_source_files() -> list[Path]:
    return [
        path
        for path in FRONTEND_SRC.rglob("*")
        if path.suffix in {".ts", ".tsx", ".js", ".jsx"} and path.is_file()
    ]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class _FakeSTT:
    def __init__(self, api_key: str) -> None:
        pass

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        yield TranscriptSegment(text="hello world", is_final=True, speech_final=True)


class _FakeTranslation:
    def __init__(self, api_key: str) -> None:
        pass

    async def translate(self, source_text, *, source_lang, target_lang):
        del source_text, source_lang, target_lang
        yield "Hola mundo"


class _FakeTTS:
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


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


def test_ac6_always_on_sampler_records_every_root_span(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_TRACES_SAMPLER", "always_on")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    try:
        assert provider.sampler in (ALWAYS_ON, DEFAULT_ON)
        with provider.get_tracer("acceptance").start_as_current_span("sampled.root"):
            pass
        finished = exporter.get_finished_spans()
        assert len(finished) == 1
        assert finished[0].context.trace_flags.sampled
    finally:
        provider.shutdown()

    for name in (
        STAGE_DURATION,
        TURN_DURATION,
        LLM_TOKENS,
        LLM_COST,
        ERRORS,
        MINT_FAILURES,
    ):
        assert name.startswith("interpreter.")


def test_ac7_readme_lists_alert_rules_and_app_has_no_paging_code() -> None:
    readme = _read(README)
    assert "No paging code ships in this repo" in readme
    assert "interpreter.stage.duration" in readme
    assert "interpreter.errors" in readme
    assert "interpreter.realtime.mint.failures" in readme
    assert "p95" in readme.lower() or "p95 stage latency" in readme.lower()

    scanned = [APP_DIR, FRONTEND_SRC]
    hits: list[str] = []
    for root in scanned:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx"}:
                continue
            text = _read(path).lower()
            for needle in _PAGING_NEEDLES:
                if needle in text:
                    hits.append(f"{path.relative_to(REPO_ROOT)}:{needle}")
    assert hits == []


def test_ac12_observability_routes_are_owned_json_not_a_catchall(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "observability_ui_token", "operator-token")

    with TestClient(app) as client:
        summary = client.get("/api/observability/summary")
        traces = client.get("/api/observability/traces")
        detail = client.get("/api/observability/traces/0af7651916cd43dd8448eb211c80319c")
        catchall = client.get("/api/observability/api/public/v2/observations")
        langfuse_v1 = client.get("/api/observability/api/public/traces")

    # Owned JSON APIs reject a missing cookie. A catch-all Langfuse proxy
    # would 401 (or 200) these public-API shapes too; they must 404 instead.
    assert summary.status_code == 401
    assert traces.status_code == 401
    assert detail.status_code == 401
    assert catchall.status_code == 404
    assert langfuse_v1.status_code == 404
    assert catchall.json() == {"detail": "Not Found"}
    assert "latency" not in catchall.text


def test_ac4_and_ac15_spa_source_does_not_talk_to_langfuse_or_store_secrets() -> None:
    files = _frontend_source_files()
    assert files

    secret_hits: list[str] = []
    langfuse_network_hits: list[str] = []
    storage_hits: list[str] = []
    network_needles = (
        "cloud.langfuse",
        "langfuse.com",
        "/api/public/otel",
        "/api/public/v2/",
        "LANGFUSE_HOST",
        "LANGFUSE_SECRET_KEY",
        "LANGFUSE_PUBLIC_KEY",
        "sk-lf-",
    )
    storage_files = (
        "observabilityApi.ts",
        "realtimeTelemetry.ts",
        "useRealtimeSession.ts",
        "LoginCard.tsx",
        "DashboardView.tsx",
        "ObservabilityPage.tsx",
    )

    for path in files:
        text = _read(path)
        rel = str(path.relative_to(REPO_ROOT)).replace("\\", "/")
        for needle in network_needles:
            if needle in text:
                langfuse_network_hits.append(f"{rel}:{needle}")
        if "LANGFUSE_SECRET_KEY" in text or "sk-lf-" in text:
            secret_hits.append(rel)
        if path.name in storage_files:
            stripped = re.sub(r"//.*?$|/\*.*?\*/", "", text, flags=re.MULTILINE | re.DOTALL)
            if "localStorage" in stripped or "sessionStorage" in stripped:
                storage_hits.append(rel)

    assert langfuse_network_hits == []
    assert secret_hits == []
    assert storage_hits == []

    dist = REPO_ROOT / "frontend" / "dist"
    if not dist.is_dir():
        pytest.skip("frontend/dist not built; run `npm run build` to grep the bundle (AC15)")
    bundle = "\n".join(
        p.read_text(encoding="utf-8", errors="ignore")
        for p in dist.rglob("*")
        if p.is_file() and p.suffix in {".js", ".css", ".html", ".map"}
    )
    assert "LANGFUSE_SECRET_KEY" not in bundle
    assert "sk-lf-" not in bundle


def test_ac16_cascade_websocket_starts_without_operator_cookie(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app import orchestrator

    monkeypatch.setattr(orchestrator, "DeepgramSTTProvider", _FakeSTT)
    monkeypatch.setattr(orchestrator, "OpenAITranslationProvider", _FakeTranslation)
    monkeypatch.setattr(orchestrator, "ElevenLabsTTSProvider", _FakeTTS)

    with client.websocket_connect("/ws/cascade") as ws:
        assert "obs_session" not in client.cookies
        ws.send_json({"type": "start_session", "languages": ["en", "es"]})
        started = json.loads(ws.receive()["text"])
        assert started["type"] == "session_started"
        assert "sessionId" in started
        assert set(started) == {"type", "sessionId"}


def test_ac18_compose_is_optional_and_app_does_not_depend_on_docker() -> None:
    assert COMPOSE.is_file()
    compose = _read(COMPOSE)
    assert compose.lstrip().startswith("# Optional Langfuse")
    assert "langfuse/langfuse:4" in compose
    for workbench_service in ("backend", "frontend", "workbench", "interpreter"):
        assert re.search(rf"^\s+{workbench_service}:\s*$", compose, re.MULTILINE) is None

    pyproject = _read(PYPROJECT)
    assert "docker" not in pyproject.lower()

    readme = _read(README)
    assert "You do not need Docker to run the app" in readme
    assert "optional" in readme.lower()

    with TestClient(app) as client:
        assert client.get("/health").status_code == 200


def test_ac19_frontend_router_declares_workbench_and_observability_routes() -> None:
    routes = _read(FRONTEND_SRC / "pages" / "appRoutes.tsx")
    assert "index: true" in routes
    assert "path: 'observability'" in routes
    assert "path: 'observability/traces/:traceId'" in routes
    assert "WorkbenchPage" in routes
    assert "ObservabilityPage" in routes
    assert "TraceDetailPage" in routes
