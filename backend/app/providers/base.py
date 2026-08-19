"""Provider-swap boundary for STT, translation, and TTS.

One streaming method per provider kind: raw input goes in, a stream of
typed events comes out. `Protocol` (structural typing), not `ABC`: test
doubles for the provider-boundary tests don't need to inherit anything,
they just need to satisfy the shape.

Deliberately not unified with the Realtime API's provider shape (a
different mode entirely, owned by app/api/realtime.py).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum, auto
from typing import Any, Protocol


class ProviderErrorKind(Enum):
    RATE_LIMIT = auto()
    TIMEOUT = auto()
    EMPTY_RESULT = auto()
    CONNECTION = auto()
    UNKNOWN = auto()


class ProviderError(Exception):
    """Raised by a provider on an actual failure, never for an empty but
    otherwise valid result (see `TranscriptSegment.is_empty`).

    `retryable` tells the caller whether a retry-with-backoff is worth
    attempting (rate limits, transient connection drops) as opposed to a
    failure that will recur unchanged (bad auth, malformed request).
    """

    def __init__(
        self, kind: ProviderErrorKind, provider: str, message: str, *, retryable: bool
    ) -> None:
        super().__init__(f"[{provider}] {kind.name}: {message}")
        self.kind = kind
        self.provider = provider
        self.retryable = retryable


# Raw PCM16 mic audio flowing from the client toward the STT provider. A
# thin alias rather than a wrapper class; there's nothing to attach to it.
AudioChunk = bytes


@dataclass
class TranscriptSegment:
    """One STT result.

    `is_final` and `speech_final` are distinct Deepgram signals, deliberately
    not collapsed into one flag: `is_final` means this chunk of text won't
    be revised further (drives the live partial transcript); `speech_final`
    means Deepgram's endpointing detected a pause and considers the
    utterance complete: one of two segmentation boundaries `app.orchestrator`
    races an LLM clause-check against (see `UtteranceEndSignal` for the
    other, and Ticket 5's `_run_stt` for the race itself).

    `speaker` and `detected_language` are populated by `DeepgramSTTProvider`
    from Deepgram's per-word `speaker`/`language` fields (diarization and
    streaming multi-language mode), rolled up to one value per segment.
    See that provider for the rollup rule. `speaker` is for labeling and
    per-speaker voice assignment only, never for picking translation
    direction (`detected_language` does that; see
    `orchestrator._resolve_direction`).
    """

    text: str
    is_final: bool
    speech_final: bool
    speaker: int | None = None
    detected_language: str | None = None

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


@dataclass
class UtteranceEndSignal:
    """Deepgram's `UtteranceEnd` event (Ticket 5): a marker, not a
    transcript: no text, no speaker, nothing to accumulate. Fired once
    `utterance_end_ms` of silence has elapsed since the last word, the
    other boundary `app.orchestrator._run_stt` races an LLM clause-check
    against (alongside `TranscriptSegment.speech_final`). Unlike
    `speech_final`, it's still honored as a hard fallback ceiling even in
    `llm_priority` segmentation mode, so a segment can never hang
    indefinitely regardless of mode."""


class STTProvider(Protocol):
    def stream(
        self,
        audio_chunks: AsyncIterator[AudioChunk],
        *,
        languages: tuple[str, ...],
        params: Any = None,
    ) -> AsyncIterator[TranscriptSegment | UtteranceEndSignal]:
        """One long-lived call for the whole session: audio never stops
        flowing in, regardless of what the orchestrator does with the
        output. Note: `def`, not `async def`; calling this returns an
        async generator (itself a synchronous action); only advancing it
        with `async for` is awaited.

        `languages` is the candidate set for per-segment language detection
        (a later ticket); this ticket's orchestrator always passes
        `("en", "es")` and the provider is free to ignore it.

        `params` is this session's connection-level tuning, passed per call
        so it can never become shared provider state (see
        `deepgram_stt.DeepgramParams`). Its concrete shape is the vendor's
        business, hence `Any` on this side of the boundary; `None` means
        "the provider's own defaults".

        Raises `ProviderError` on connection/auth/rate-limit failure. An
        empty final result (silence) is a valid `TranscriptSegment` with
        `is_empty=True`, never an error.
        """
        ...


class TranslationProvider(Protocol):
    def translate(
        self,
        source_text: str,
        *,
        source_lang: str,
        target_lang: str,
        model: str | None = None,
    ) -> AsyncIterator[str]:
        """Translates one already-segmented unit of text: segmentation is
        the orchestrator's job, not this stage's. Yields incremental
        translated text deltas as they stream from the model.

        `model` is per call, the same way `voice` is for TTS: the tuning
        panel can change it mid-session and the next segment picks it up
        without rebuilding the provider. `None` means the provider's own
        default model.

        Raises `ProviderError` on API failure (rate limit, timeout, etc).
        """
        ...


@dataclass
class TTSText:
    """A chunk of translated text to synthesize."""

    text: str


@dataclass
class TTSFlush:
    """Force-synthesize whatever text is buffered: maps directly to
    ElevenLabs' `flush: true`. Marks the end of one segment's input."""


class TTSProvider(Protocol):
    def synthesize(
        self, input_events: AsyncIterator[TTSText | TTSFlush], *, voice: str
    ) -> AsyncIterator[bytes]:
        """One call handles one already-segmented unit: stream `TTSText`
        chunks in as translated text arrives, end with a `TTSFlush`, and
        receive raw PCM16 audio bytes out until the provider signals the
        segment is complete.

        Raises `ProviderError` on connection/auth failure.
        """
        ...
