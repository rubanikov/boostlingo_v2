"""Ticket 7 shared resilience primitives, factored out once so the retry/
backoff numbers aren't duplicated across `app.orchestrator`,
`deepgram_stt.py`, and `elevenlabs_tts.py`.

Two independent concerns live here:

- `retry_backoffs(exc)`: the per-segment bounded-retry policy
  (`app.orchestrator` calls this around each translation/TTS attempt).
  Gated on `exc.retryable` first (a non-retryable failure, e.g. bad auth or
  malformed request, won't succeed on a bare retry, so it gets none
  regardless of kind), then on `exc.kind`: `RATE_LIMIT` gets 2 retries at
  200ms/400ms; `CONNECTION` gets 0 further retries here because a
  backend<->provider WebSocket drop (Deepgram/ElevenLabs) is already
  handled by `with_reconnect` below, one layer down, before a
  `ProviderError` ever reaches the orchestrator; everything else
  (`TIMEOUT`, `EMPTY_RESULT`, `UNKNOWN`, and any kind added later) gets 1
  immediate retry: the ticket only specifies a delay for `RATE_LIMIT` and
  the reconnect schedule below, so "immediate" is this module's documented
  default for the rest.

- `with_reconnect`: wraps one provider's connect+stream attempt
  (`deepgram_stt.py`/`elevenlabs_tts.py`) and transparently reconnects on a
  `ConnectionDropped` with backoff 500ms->1s->2s, capped at 3 attempts,
  before giving up and raising `ProviderError(CONNECTION)`. Both providers
  reuse the same audio/text input iterator across a reconnect (safe: a
  `ConnectionDropped` before the connection was ever fully consumed loses
  nothing, and a mid-stream drop is a rarer, accepted simplification.
  See each provider module's docstring).
"""

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Final

from app.providers.base import ProviderError, ProviderErrorKind

RATE_LIMIT_BACKOFFS_S: Final[list[float]] = [0.2, 0.4]
DEFAULT_BACKOFFS_S: Final[list[float]] = [0.0]
RECONNECT_BACKOFFS_S: Final[list[float]] = [0.5, 1.0, 2.0]


def retry_backoffs(exc: ProviderError) -> list[float]:
    """Backoff delays (seconds) between attempts for a dropped-segment
    retry. See module docstring for the policy."""
    if not exc.retryable:
        return []
    if exc.kind is ProviderErrorKind.RATE_LIMIT:
        return RATE_LIMIT_BACKOFFS_S
    if exc.kind is ProviderErrorKind.CONNECTION:
        return []
    return DEFAULT_BACKOFFS_S


class ConnectionDropped(Exception):
    """Raised internally within `deepgram_stt.py`/`elevenlabs_tts.py` when
    their backend<->provider WebSocket drops (connect-time or mid-stream;
    both are eligible for reconnect, see module docstring). Caught by
    `with_reconnect`; never seen by `app.orchestrator`."""

    def __init__(self, provider: str, cause: Exception) -> None:
        super().__init__(str(cause))
        self.provider = provider
        self.cause = cause


async def with_reconnect[T](
    attempt: Callable[[], AsyncIterator[T]], *, provider: str
) -> AsyncIterator[T]:
    """Runs `attempt()` (one connect+stream attempt) and transparently
    reconnects (calling `attempt()` again) whenever it raises
    `ConnectionDropped`, waiting `RECONNECT_BACKOFFS_S` between tries.
    Exhausting all 3 raises `ProviderError(CONNECTION)` to the caller; any
    other exception from `attempt()` (already-typed `ProviderError`s for
    auth/rate-limit/timeout) propagates immediately, untouched, without
    retry at this layer.
    """
    reconnects = 0
    while True:
        try:
            async for item in attempt():
                yield item
            return
        except ConnectionDropped as exc:
            if reconnects >= len(RECONNECT_BACKOFFS_S):
                raise ProviderError(
                    ProviderErrorKind.CONNECTION,
                    provider,
                    f"connection lost, reconnect exhausted after "
                    f"{reconnects} attempt(s): {exc.cause}",
                    retryable=True,
                ) from exc
            await asyncio.sleep(RECONNECT_BACKOFFS_S[reconnects])
            reconnects += 1
