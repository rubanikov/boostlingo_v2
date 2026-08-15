"""Concrete `TranslationProvider` using OpenAI's streaming Chat Completions.

One call translates one already-segmented unit of text: segmentation
(Deepgram's `speech_final` for this ticket) happens upstream in the
orchestrator, not here. Streams `choices[].delta.content` fragments as they
arrive so the orchestrator can start feeding TTS before the full
translation finishes.
"""

from collections.abc import AsyncIterator
from typing import Final

import httpx
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    RateLimitError,
)

from app.languages import SUPPORTED_LANGUAGES
from app.providers.base import ProviderError, ProviderErrorKind

MODEL: Final = "gpt-4o-mini"


class OpenAITranslationProvider:
    """Swapping translation vendors means writing one class like this one:
    nothing upstream or downstream of `TranslationProvider.translate()`
    changes.
    """

    def __init__(self, api_key: str) -> None:
        # Explicit timeout instead of the SDK's 600s default: a hung
        # request or stalled stream read raises `APITimeoutError` (mapped
        # to a retryable TIMEOUT below) instead of blocking the serial
        # segment pipeline for minutes.
        self._client = AsyncOpenAI(
            api_key=api_key, timeout=httpx.Timeout(30.0, connect=10.0)
        )

    async def translate(
        self, source_text: str, *, source_lang: str, target_lang: str
    ) -> AsyncIterator[str]:
        source_name = SUPPORTED_LANGUAGES.get(source_lang, source_lang)
        target_name = SUPPORTED_LANGUAGES.get(target_lang, target_lang)

        try:
            stream = await self._client.chat.completions.create(
                model=MODEL,
                stream=True,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            f"Translate the user's {source_name} text into "
                            f"{target_name}. Reply with only the translation "
                            "-- no commentary, no quotation marks."
                        ),
                    },
                    {"role": "user", "content": source_text},
                ],
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta.content
                if delta:
                    yield delta
        except RateLimitError as exc:
            raise ProviderError(
                ProviderErrorKind.RATE_LIMIT, "openai", str(exc), retryable=True
            ) from exc
        except APITimeoutError as exc:
            raise ProviderError(
                ProviderErrorKind.TIMEOUT, "openai", str(exc), retryable=True
            ) from exc
        except APIConnectionError as exc:
            raise ProviderError(
                ProviderErrorKind.CONNECTION, "openai", str(exc), retryable=True
            ) from exc
        except APIStatusError as exc:
            raise ProviderError(
                ProviderErrorKind.UNKNOWN, "openai", str(exc), retryable=False
            ) from exc
