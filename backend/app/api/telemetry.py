"""Client-reported Realtime turn ingest.

Auth order is locked: Origin → 413 size → 429 rate → 401 token. A valid
turn is always `202 {"accepted": true}`; when OTLP is off the span is a
no-op and the SPA cannot tell the difference.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from opentelemetry import trace
from opentelemetry.trace import (
    NonRecordingSpan,
    SpanContext,
    Status,
    StatusCode,
    TraceFlags,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import settings
from app.observability.metrics import record_turn_duration
from app.observability.spans import (
    ATTR_GEN_AI_INPUT_TOKENS,
    ATTR_GEN_AI_MODEL,
    ATTR_GEN_AI_OUTPUT_TOKENS,
    ATTR_INPUT_TEXT,
    ATTR_MODE,
    NAME_REALTIME_TURN,
    get_tracer,
    set_text_attribute,
)
from app.observability.telemetry_tokens import (
    TelemetryTokenClaims,
    allow_ingest,
    peek_token_sid,
    verify_telemetry_token,
)
from app.origins import is_allowed_origin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

_INVALID_TOKEN = "Invalid or expired telemetry token."
ATTR_OUTPUT_TEXT = "output.text"
ATTR_TURN_INDEX = "turn.index"
ATTR_LATENCY_MS = "latency.ms"
ATTR_LATENCY_SOURCE = "latency.source"
ATTR_SOURCE_LANGUAGE = "source.language"
ATTR_TARGET_LANGUAGE = "target.language"


class RealtimeTurnUsage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    inputTokens: int | None = None
    outputTokens: int | None = None


class RealtimeTurnIngest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    turnIndex: int = Field(ge=0)
    startedAt: str
    endedAt: str
    latencyMs: int = Field(ge=0)
    sourceText: str | None = None
    targetText: str | None = None
    sourceLanguage: str | None = None
    targetLanguage: str | None = None
    model: str | None = None
    usage: RealtimeTurnUsage | None = None
    error: str | None = None


class RealtimeTurnAccepted(BaseModel):
    accepted: bool = True


def _bearer_token(authorization: str | None) -> str | None:
    if authorization is None:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token


def _iso_z_to_ns(value: str) -> int:
    if not value.endswith("Z"):
        raise ValueError("must be ISO-8601 UTC with a trailing Z")
    parsed = datetime.fromisoformat(value)
    return int(parsed.timestamp() * 1_000_000_000)


def _context_for_token(claims: TelemetryTokenClaims):
    try:
        trace_id = int(claims.tid, 16)
        parent_span_id = int(claims.sid[:16], 16) or 1
    except ValueError:
        return None
    parent = SpanContext(
        trace_id=trace_id,
        span_id=parent_span_id,
        is_remote=True,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
    )
    return trace.set_span_in_context(NonRecordingSpan(parent))


def _emit_turn_span(claims: TelemetryTokenClaims, body: RealtimeTurnIngest) -> None:
    start_ns = _iso_z_to_ns(body.startedAt)
    end_ns = _iso_z_to_ns(body.endedAt)
    context = _context_for_token(claims)
    kwargs: dict[str, object] = {"start_time": start_ns}
    if context is not None:
        kwargs["context"] = context
    span = get_tracer().start_span(NAME_REALTIME_TURN, **kwargs)
    try:
        span.set_attribute(ATTR_MODE, "realtime")
        span.set_attribute(ATTR_TURN_INDEX, body.turnIndex)
        span.set_attribute(ATTR_LATENCY_MS, body.latencyMs)
        span.set_attribute(ATTR_LATENCY_SOURCE, "client-reported")
        if body.sourceText is not None:
            set_text_attribute(span, ATTR_INPUT_TEXT, body.sourceText)
        if body.targetText is not None:
            set_text_attribute(span, ATTR_OUTPUT_TEXT, body.targetText)
        if body.sourceLanguage is not None:
            span.set_attribute(ATTR_SOURCE_LANGUAGE, body.sourceLanguage)
        if body.targetLanguage is not None:
            span.set_attribute(ATTR_TARGET_LANGUAGE, body.targetLanguage)
        if body.model is not None:
            span.set_attribute(ATTR_GEN_AI_MODEL, body.model)
        if body.usage is not None:
            if body.usage.inputTokens is not None:
                span.set_attribute(ATTR_GEN_AI_INPUT_TOKENS, body.usage.inputTokens)
            if body.usage.outputTokens is not None:
                span.set_attribute(ATTR_GEN_AI_OUTPUT_TOKENS, body.usage.outputTokens)
        if body.error:
            span.set_status(Status(StatusCode.ERROR, body.error))
    finally:
        span.end(end_time=end_ns)


@router.post("/realtime/turn", status_code=202, response_model=RealtimeTurnAccepted)
async def ingest_realtime_turn(request: Request) -> RealtimeTurnAccepted:
    origin = request.headers.get("origin")
    if not is_allowed_origin(origin):
        logger.warning("rejecting telemetry ingest from disallowed origin %r", origin)
        raise HTTPException(status_code=403, detail="Origin not allowed.")

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError:
            raise HTTPException(status_code=413, detail="Payload too large.") from None
        if length > settings.telemetry_ingest_max_bytes:
            raise HTTPException(status_code=413, detail="Payload too large.")

    raw = await request.body()
    if len(raw) > settings.telemetry_ingest_max_bytes:
        raise HTTPException(status_code=413, detail="Payload too large.")

    token = _bearer_token(request.headers.get("authorization"))
    peeked_sid = peek_token_sid(token)
    if peeked_sid is not None and not allow_ingest(peeked_sid):
        raise HTTPException(status_code=429, detail="Rate limit exceeded.")

    claims = verify_telemetry_token(token)
    if claims is None:
        raise HTTPException(status_code=401, detail=_INVALID_TOKEN)

    try:
        body = RealtimeTurnIngest.model_validate_json(raw)
        _iso_z_to_ns(body.startedAt)
        _iso_z_to_ns(body.endedAt)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        _emit_turn_span(claims, body)
    except Exception:
        logger.exception("failed to emit realtime.turn span")

    record_turn_duration(body.latencyMs, mode="realtime")
    return RealtimeTurnAccepted(accepted=True)
