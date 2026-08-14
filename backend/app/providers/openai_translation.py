"""Concrete `TranslationProvider` using OpenAI's streaming Chat Completions.

One call translates one already-segmented unit of text: segmentation
(Deepgram's `speech_final` for this ticket) happens upstream in the
orchestrator, not here. Streams `choices[].delta.content` fragments as they
arrive so the orchestrator can start feeding TTS before the full
translation finishes.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Final

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


@dataclass(frozen=True)
class TranslationUsage:
    """Token counts from a streamed completion's usage-only final chunk.

    Exposed as `OpenAITranslationProvider.last_usage` after `translate()`
    drains, so the orchestrator can put `gen_ai.*` attributes on the span
    without changing `TranslationProvider`'s `AsyncIterator[str]` shape.
    """

    input_tokens: int
    output_tokens: int
    model: str = MODEL


def _usage_from_chunk(chunk: object) -> TranslationUsage | None:
    usage = getattr(chunk, "usage", None)
    if usage is None:
        return None
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    if prompt is None:
        prompt = getattr(usage, "input_tokens", None)
    if completion is None:
        completion = getattr(usage, "output_tokens", None)
    if prompt is None and completion is None:
        return None
    return TranslationUsage(int(prompt or 0), int(completion or 0), MODEL)


class OpenAITranslationProvider:
    """Swapping translation vendors means writing one class like this one:
    nothing upstream or downstream of `TranslationProvider.translate()`
    changes.
    """

    def __init__(self, api_key: str) -> None:
        self._client = AsyncOpenAI(api_key=api_key)
        self.last_usage: TranslationUsage | None = None

    async def translate(
        self, source_text: str, *, source_lang: str, target_lang: str
    ) -> AsyncIterator[str]:
        source_name = SUPPORTED_LANGUAGES.get(source_lang, source_lang)
        target_name = SUPPORTED_LANGUAGES.get(target_lang, target_lang)
        self.last_usage = None

        try:
            stream = await self._client.chat.completions.create(
                model=MODEL,
                stream=True,
                stream_options={"include_usage": True},
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
                usage = _usage_from_chunk(chunk)
                if usage is not None:
                    self.last_usage = usage
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
