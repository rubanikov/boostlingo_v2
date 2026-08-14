"""Owned JSON resources for the operator observability dashboard.

Cookie-gated. When Langfuse keys are set, summary and traces map Metrics
API v2 / Observations API v2; otherwise they 503.
"""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.observability.auth import (
    COOKIE_NAME,
    mint_session_cookie,
    verify_session_cookie,
)
from app.observability.langfuse_api import (
    LangfuseUnreachable,
    LangfuseUnusable,
    TraceNotFound,
    fetch_summary,
    fetch_trace,
    fetch_traces,
    langfuse_configured,
)

router = APIRouter(prefix="/api/observability", tags=["observability"])

_NOT_ENABLED = "Observability is not enabled on this server."
_INVALID_TOKEN = "Invalid operator token."
_INVALID_SESSION = "Invalid or missing operator session."
_LANGFUSE_UNAVAILABLE = "Langfuse is not configured on this server."
_LANGFUSE_UNREACHABLE = "Failed to reach Langfuse."
_LANGFUSE_UNUSABLE = "Langfuse returned an unusable response."
_TRACE_NOT_FOUND = "Trace not found."
_TRACE_ID_PATTERN = r"^[0-9a-f]{16,64}$"


class Window(StrEnum):
    one_hour = "1h"
    one_day = "24h"
    seven_days = "7d"


class ModeFilter(StrEnum):
    all = "all"
    cascade = "cascade"
    realtime = "realtime"


class StatusFilter(StrEnum):
    all = "all"
    error = "error"


class ConfigResponse(BaseModel):
    enabled: bool
    authenticated: bool


class LoginRequest(BaseModel):
    token: str


class LatencyPoint(BaseModel):
    t: str
    p50Ms: int | None
    p95Ms: int | None


class LatencySummary(BaseModel):
    p50Ms: int | None
    p95Ms: int | None
    series: list[LatencyPoint]


class ErrorPoint(BaseModel):
    t: str
    rate: float | None


class ErrorRateSummary(BaseModel):
    rate: float | None
    errorCount: int | None
    totalCount: int | None
    series: list[ErrorPoint]


class CostSummary(BaseModel):
    totalUsd: float | None
    totalTokens: int | None
    inputTokens: int | None
    outputTokens: int | None


class SessionsSummary(BaseModel):
    realtime: int | None
    cascade: int | None


class SummaryResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    window: str
    from_: str = Field(alias="from")
    to: str
    latency: LatencySummary
    errorRate: ErrorRateSummary
    cost: CostSummary
    sessions: SessionsSummary


class TraceRow(BaseModel):
    traceId: str
    timestamp: str
    mode: str
    latencyMs: int | None
    totalTokens: int | None
    costUsd: float | None
    status: str


class TraceListResponse(BaseModel):
    traces: list[TraceRow]
    nextCursor: str | None
    hasMore: bool


class SpanRow(BaseModel):
    spanId: str
    parentSpanId: str | None
    name: str
    startOffsetMs: int
    durationMs: int | None
    status: str
    depth: int
    input: str | None
    output: str | None
    truncated: bool
    metadata: dict


class TraceDetailResponse(BaseModel):
    traceId: str
    mode: str
    status: str
    timestamp: str
    totalLatencyMs: int | None
    totalTokens: int | None
    inputTokens: int | None
    outputTokens: int | None
    costUsd: float | None
    model: str | None
    sessionId: str | None
    spans: list[SpanRow]


def _feature_enabled() -> bool:
    return settings.observability_ui_token != ""


def require_operator_session(request: Request) -> None:
    if not _feature_enabled():
        raise HTTPException(status_code=404, detail=_NOT_ENABLED)
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie or not verify_session_cookie(
        settings.observability_ui_token, cookie
    ):
        raise HTTPException(status_code=401, detail=_INVALID_SESSION)


def _require_langfuse() -> None:
    if not langfuse_configured():
        raise HTTPException(status_code=503, detail=_LANGFUSE_UNAVAILABLE)


async def _call_langfuse[T](factory: Callable[[], Awaitable[T]]) -> T:
    _require_langfuse()
    try:
        return await factory()
    except TraceNotFound:
        raise HTTPException(status_code=404, detail=_TRACE_NOT_FOUND)
    except LangfuseUnreachable as exc:
        raise HTTPException(status_code=503, detail=_LANGFUSE_UNREACHABLE) from exc
    except LangfuseUnusable as exc:
        raise HTTPException(status_code=502, detail=_LANGFUSE_UNUSABLE) from exc


def _set_session_cookie(response: Response, value: str, request: Request) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=value,
        httponly=True,
        samesite="lax",
        path="/",
        secure=request.url.scheme == "https",
    )


def _expire_session_cookie(response: Response) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value="",
        max_age=0,
        httponly=True,
        samesite="lax",
        path="/",
    )


@router.get("/config", response_model=ConfigResponse)
def get_config(request: Request) -> ConfigResponse:
    enabled = _feature_enabled()
    cookie = request.cookies.get(COOKIE_NAME, "")
    authenticated = enabled and verify_session_cookie(
        settings.observability_ui_token, cookie
    )
    return ConfigResponse(enabled=enabled, authenticated=authenticated)


@router.post("/login", status_code=204)
def login(body: LoginRequest, request: Request, response: Response) -> None:
    if not _feature_enabled():
        raise HTTPException(status_code=404, detail=_NOT_ENABLED)
    expected = mint_session_cookie(settings.observability_ui_token)
    submitted = mint_session_cookie(body.token)
    if not secrets.compare_digest(submitted, expected):
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)
    _set_session_cookie(response, expected, request)


@router.post("/logout", status_code=204)
def logout(response: Response) -> None:
    _expire_session_cookie(response)


@router.get("/summary", response_model=SummaryResponse)
async def get_summary(
    window: Window = Window.one_day,
    _: None = Depends(require_operator_session),
) -> dict:
    return await _call_langfuse(lambda: fetch_summary(window.value))


@router.get("/traces", response_model=TraceListResponse)
async def list_traces(
    window: Window = Window.one_day,
    mode: ModeFilter = ModeFilter.all,
    status: StatusFilter = StatusFilter.all,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: str | None = None,
    _: None = Depends(require_operator_session),
) -> dict:
    return await _call_langfuse(
        lambda: fetch_traces(window.value, mode.value, status.value, limit, cursor)
    )


@router.get("/traces/{trace_id}", response_model=TraceDetailResponse)
async def get_trace(
    trace_id: Annotated[str, Path(pattern=_TRACE_ID_PATTERN)],
    _: None = Depends(require_operator_session),
) -> dict:
    return await _call_langfuse(lambda: fetch_trace(trace_id))
