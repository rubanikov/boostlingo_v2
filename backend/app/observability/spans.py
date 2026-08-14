"""Span names, attribute names, and fail-open helpers.

Call sites must not branch on whether a TracerProvider is installed. The
OTel API's no-op tracer already makes an unset endpoint cheap. What this
module adds is the other half of fail-open: a telemetry bug degrades to
"no span", never a dropped segment or a killed session.

Realtime span names live here so ingest can reuse them. This module does
not open Realtime spans.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Final

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from opentelemetry.util.types import AttributeValue

from app.config import settings
from app.providers.base import ProviderError

logger = logging.getLogger(__name__)

TRACER_NAME: Final = "app.observability"

NAME_CASCADE_SESSION: Final = "cascade.session"
NAME_CASCADE_SEGMENT: Final = "cascade.segment"
NAME_STT: Final = "stt.deepgram"
NAME_LLM: Final = "llm.translate"
NAME_TTS: Final = "tts.elevenlabs"
NAME_PROVIDER_ERROR: Final = "provider.error"
NAME_REALTIME_SESSION: Final = "realtime.session"
NAME_REALTIME_TURN: Final = "realtime.turn"

ATTR_MODE: Final = "mode"
ATTR_SESSION_ID: Final = "session.id"
ATTR_LANGUAGES: Final = "languages"
ATTR_SEGMENTATION_MODE: Final = "segmentation.mode"
ATTR_SESSION_END_REASON: Final = "session.end_reason"
ATTR_SEGMENT_ID: Final = "segment.id"
ATTR_SEGMENT_TRIGGER: Final = "segment.trigger"
ATTR_SPEAKER: Final = "speaker"
ATTR_DETECTED_LANGUAGE: Final = "detected_language"
ATTR_INPUT_TEXT: Final = "input.text"
ATTR_RETRY_ATTEMPT: Final = "retry.attempt"
ATTR_TRANSLATION_DIRECTION: Final = "translation.direction"
ATTR_VOICE: Final = "voice"
ATTR_TTS_AUDIO_BYTES: Final = "tts.audio_bytes"
ATTR_ERROR_PROVIDER: Final = "error.provider"
ATTR_ERROR_KIND: Final = "error.kind"
ATTR_ERROR_RETRYABLE: Final = "error.retryable"
ATTR_GEN_AI_SYSTEM: Final = "gen_ai.system"
ATTR_GEN_AI_MODEL: Final = "gen_ai.request.model"
ATTR_GEN_AI_PROMPT: Final = "gen_ai.prompt"
ATTR_GEN_AI_COMPLETION: Final = "gen_ai.completion"
ATTR_GEN_AI_INPUT_TOKENS: Final = "gen_ai.usage.input_tokens"
ATTR_GEN_AI_OUTPUT_TOKENS: Final = "gen_ai.usage.output_tokens"
ATTR_GEN_AI_COST: Final = "gen_ai.usage.cost"

# gpt-4o-mini public pricing (USD / million tokens), same figures as COMPARISON.md.
_GPT_4O_MINI_INPUT_USD_PER_MTOK: Final = 0.15
_GPT_4O_MINI_OUTPUT_USD_PER_MTOK: Final = 0.60


@dataclass
class SpanHandle:
    """A started span plus the context that makes it current.

    `context` is what `_DetachedSession` stashes so a WS resume re-enters
    the same `cascade.session` trace rather than opening a second root.
    """

    span: object | None = None
    context: object | None = None
    ended: bool = field(default=False)


def get_tracer() -> trace.Tracer:
    return trace.get_tracer(TRACER_NAME)


def llm_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float | None:
    if model != "gpt-4o-mini":
        return None
    return (
        input_tokens * _GPT_4O_MINI_INPUT_USD_PER_MTOK
        + output_tokens * _GPT_4O_MINI_OUTPUT_USD_PER_MTOK
    ) / 1_000_000


def set_text_attribute(span: object | None, key: str, value: str) -> None:
    """Truncate over-long values at `observability_max_span_text_chars` and flag `<key>.truncated`."""
    if span is None:
        return
    try:
        limit = settings.observability_max_span_text_chars
        if len(value) > limit:
            span.set_attribute(key, value[:limit])
            span.set_attribute(f"{key}.truncated", True)
        else:
            span.set_attribute(key, value)
    except Exception:
        logger.exception("failed to set span text attribute %s", key)


def _set_attribute(span: object | None, key: str, value: AttributeValue) -> None:
    if span is None:
        return
    try:
        span.set_attribute(key, value)
    except Exception:
        logger.exception("failed to set span attribute %s", key)


def start_session_span(
    session_id: str,
    languages: tuple[str, str],
    segmentation_mode: str,
) -> SpanHandle:
    try:
        span = get_tracer().start_span(NAME_CASCADE_SESSION)
        span.set_attribute(ATTR_MODE, "cascade")
        span.set_attribute(ATTR_SESSION_ID, session_id)
        span.set_attribute(ATTR_LANGUAGES, ",".join(languages))
        span.set_attribute(ATTR_SEGMENTATION_MODE, segmentation_mode)
        ctx = trace.set_span_in_context(span)
        return SpanHandle(span=span, context=ctx)
    except Exception:
        logger.exception("failed to start cascade.session span")
        return SpanHandle()


def attach(handle: SpanHandle | None) -> object | None:
    if handle is None or handle.context is None:
        return None
    try:
        return otel_context.attach(handle.context)
    except Exception:
        logger.exception("failed to attach span context")
        return None


def detach(token: object | None) -> None:
    if token is None:
        return
    try:
        otel_context.detach(token)
    except Exception:
        logger.exception("failed to detach span context")


def end_session_span(
    handle: SpanHandle | None, *, end_reason: str, error: bool = False
) -> None:
    if handle is None or handle.span is None or handle.ended:
        return
    try:
        handle.span.set_attribute(ATTR_SESSION_END_REASON, end_reason)
        if error:
            handle.span.set_status(Status(StatusCode.ERROR, end_reason))
        handle.span.end()
        handle.ended = True
    except Exception:
        logger.exception("failed to end cascade.session span")
        handle.ended = True


def start_segment_span(
    segment_id: str,
    trigger: str,
    speaker: int | None,
    detected_language: str | None,
) -> SpanHandle:
    try:
        span = get_tracer().start_span(NAME_CASCADE_SEGMENT)
        span.set_attribute(ATTR_SEGMENT_ID, segment_id)
        span.set_attribute(ATTR_SEGMENT_TRIGGER, trigger)
        if speaker is not None:
            span.set_attribute(ATTR_SPEAKER, speaker)
        if detected_language is not None:
            span.set_attribute(ATTR_DETECTED_LANGUAGE, detected_language)
        ctx = trace.set_span_in_context(span)
        return SpanHandle(span=span, context=ctx)
    except Exception:
        logger.exception("failed to start cascade.segment span")
        return SpanHandle()


def close_stt_span(parent: SpanHandle, text: str, speaker: int | None, detected_language: str | None) -> None:
    try:
        kwargs = {}
        if parent.context is not None:
            kwargs["context"] = parent.context
        span = get_tracer().start_span(NAME_STT, **kwargs)
        set_text_attribute(span, ATTR_INPUT_TEXT, text)
        if speaker is not None:
            span.set_attribute(ATTR_SPEAKER, speaker)
        if detected_language is not None:
            span.set_attribute(ATTR_DETECTED_LANGUAGE, detected_language)
        span.end()
    except Exception:
        logger.exception("failed to close stt.deepgram span")


def end_segment_span(handle: SpanHandle | None) -> None:
    if handle is None or handle.span is None or handle.ended:
        return
    try:
        handle.span.end()
        handle.ended = True
    except Exception:
        logger.exception("failed to end cascade.segment span")
        handle.ended = True


def set_translation_direction(handle: SpanHandle | None, from_lang: str, to_lang: str) -> None:
    if handle is None:
        return
    _set_attribute(handle.span, ATTR_TRANSLATION_DIRECTION, f"{from_lang}->{to_lang}")


@contextmanager
def stage_span(name: str, *, parent: SpanHandle | None, attempt: int) -> Iterator[object | None]:
    """One retry attempt. Ends the span on exit; never raises into the caller."""
    span: object | None = None
    token: object | None = None
    try:
        kwargs = {}
        if parent is not None and parent.context is not None:
            kwargs["context"] = parent.context
        span = get_tracer().start_span(name, **kwargs)
        span.set_attribute(ATTR_RETRY_ATTEMPT, attempt)
        token = otel_context.attach(trace.set_span_in_context(span))
    except Exception:
        logger.exception("failed to start %s span", name)
        span = None
        token = None
    try:
        yield span
    finally:
        detach(token)
        if span is not None:
            try:
                span.end()
            except Exception:
                logger.exception("failed to end %s span", name)


def add_current_span_event(name: str) -> None:
    try:
        span = trace.get_current_span()
        if span.is_recording():
            span.add_event(name)
    except Exception:
        logger.exception("failed to add span event %s", name)


def mark_error(span: object | None, exc: ProviderError) -> None:
    if span is None:
        return
    try:
        span.set_status(Status(StatusCode.ERROR, str(exc)))
        span.set_attribute(ATTR_ERROR_PROVIDER, exc.provider)
        span.set_attribute(ATTR_ERROR_KIND, exc.kind.name)
        span.set_attribute(ATTR_ERROR_RETRYABLE, exc.retryable)
        span.record_exception(exc)
    except Exception:
        logger.exception("failed to mark span error")


def emit_provider_error_span(exc: ProviderError) -> None:
    """Standalone `provider.error` under the current span (the session)."""
    try:
        span = get_tracer().start_span(NAME_PROVIDER_ERROR)
        mark_error(span, exc)
        span.end()
    except Exception:
        logger.exception("failed to emit provider.error span")


def emit_circuit_open_span() -> None:
    try:
        span = get_tracer().start_span(NAME_PROVIDER_ERROR)
        span.set_status(Status(StatusCode.ERROR, "circuit_open"))
        span.set_attribute(ATTR_ERROR_PROVIDER, "orchestrator")
        span.set_attribute(ATTR_ERROR_KIND, "circuit_open")
        span.set_attribute(ATTR_ERROR_RETRYABLE, False)
        span.end()
    except Exception:
        logger.exception("failed to emit circuit_open provider.error span")


def apply_llm_generation(
    span: object | None,
    *,
    source_text: str,
    translated_text: str,
    usage: object | None,
) -> None:
    """Set gen_ai.* on an `llm.translate` span. Text is attached once, here,
    immediately before the span ends, never per-delta."""
    if span is None:
        return
    try:
        span.set_attribute(ATTR_GEN_AI_SYSTEM, "openai")
        set_text_attribute(span, ATTR_GEN_AI_PROMPT, source_text)
        set_text_attribute(span, ATTR_GEN_AI_COMPLETION, translated_text)
        if usage is None:
            return
        model = getattr(usage, "model", "gpt-4o-mini")
        input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
        span.set_attribute(ATTR_GEN_AI_MODEL, model)
        span.set_attribute(ATTR_GEN_AI_INPUT_TOKENS, input_tokens)
        span.set_attribute(ATTR_GEN_AI_OUTPUT_TOKENS, output_tokens)
        cost = llm_cost_usd(model, input_tokens, output_tokens)
        if cost is not None:
            span.set_attribute(ATTR_GEN_AI_COST, cost)
    except Exception:
        logger.exception("failed to apply gen_ai attributes")


def apply_tts_attributes(span: object | None, *, voice: str, audio_bytes: int) -> None:
    if span is None:
        return
    _set_attribute(span, ATTR_VOICE, voice)
    _set_attribute(span, ATTR_TTS_AUDIO_BYTES, audio_bytes)
