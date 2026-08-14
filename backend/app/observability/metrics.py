"""The six `interpreter.*` instruments.

Instruments are created at record time so a test (or a late MeterProvider
install) is what they bind to. Importing this module with no provider
installed stays a no-op. Cascade seams, Realtime mint failures, and
mode=realtime turn duration all go through these helpers.

Every helper swallows exceptions: metrics must never enter the audio path.
"""

from __future__ import annotations

import logging
from typing import Final

from opentelemetry import metrics

logger = logging.getLogger(__name__)

METER_NAME: Final = "app.observability"

STAGE_DURATION: Final = "interpreter.stage.duration"
TURN_DURATION: Final = "interpreter.turn.duration"
LLM_TOKENS: Final = "interpreter.llm.tokens"
LLM_COST: Final = "interpreter.llm.cost"
ERRORS: Final = "interpreter.errors"
MINT_FAILURES: Final = "interpreter.realtime.mint.failures"


def _meter() -> metrics.Meter:
    return metrics.get_meter(METER_NAME)


def record_stage_duration(stage: str, duration_ms: float, *, mode: str = "cascade") -> None:
    try:
        _meter().create_histogram(STAGE_DURATION, unit="ms").record(
            duration_ms, {"stage": stage, "mode": mode}
        )
    except Exception:
        logger.exception("failed to record %s", STAGE_DURATION)


def record_turn_duration(duration_ms: float, *, mode: str = "cascade") -> None:
    try:
        _meter().create_histogram(TURN_DURATION, unit="ms").record(
            duration_ms, {"mode": mode}
        )
    except Exception:
        logger.exception("failed to record %s", TURN_DURATION)


def record_llm_tokens(direction: str, amount: int, *, model: str) -> None:
    try:
        _meter().create_counter(LLM_TOKENS, unit="{token}").add(
            amount, {"direction": direction, "model": model}
        )
    except Exception:
        logger.exception("failed to record %s", LLM_TOKENS)


def record_llm_cost(amount_usd: float, *, model: str) -> None:
    try:
        _meter().create_counter(LLM_COST, unit="USD").add(amount_usd, {"model": model})
    except Exception:
        logger.exception("failed to record %s", LLM_COST)


def record_error(*, provider: str, kind: str, retryable: bool) -> None:
    try:
        _meter().create_counter(ERRORS, unit="{error}").add(
            1,
            {
                "provider": provider,
                "kind": kind,
                "retryable": str(retryable).lower(),
            },
        )
    except Exception:
        logger.exception("failed to record %s", ERRORS)


def record_mint_failure(*, reason: str) -> None:
    try:
        _meter().create_counter(MINT_FAILURES, unit="{failure}").add(
            1, {"reason": reason}
        )
    except Exception:
        logger.exception("failed to record %s", MINT_FAILURES)
