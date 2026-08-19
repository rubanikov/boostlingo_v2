"""Concrete `STTProvider` for Deepgram's streaming (`v1/listen`) endpoint.

Talks to Deepgram directly over `websockets` rather than the `deepgram-sdk`
package, so the callback-to-async-generator bridge is entirely our own code
and directly testable with a fake socket: no live network calls needed.

The bridge: `_receive_results()` drains raw WS messages into an
`asyncio.Queue` as they arrive, `_pump_audio()` concurrently sends mic audio
out on the same socket, and `stream()` itself just drains the queue and
yields. This is the same decoupling a callback-based SDK's `"Results"`
handler would need (`queue.put_nowait(segment)` from the callback, a
concurrent task pumping audio, `while True: yield await queue.get()`).
Here the "callback" is just the receive loop's `async for`.

Ticket 5: `stream()` yields a second event type alongside `TranscriptSegment`:
`UtteranceEndSignal`, parsed from Deepgram's `UtteranceEnd` message
(`_parse_message`). Any other message type (`Metadata`, `SpeechStarted` from
`vad_events=true`, etc.) is still silently ignored.

Ticket 7: `stream()` is one long-lived call for the whole session, so a
connection drop needs to be resumable mid-session rather than ending the
call. `_receive_results` catches a drop (`WebSocketException`/`OSError`/
`TimeoutError`, whether it happens at connect time or mid-stream) and
pushes a `ConnectionDropped` marker onto the queue instead of raising
directly; `_stream_once`'s main loop turns that back into a raised
exception, and `with_reconnect` (see `_resilience.py`) catches it,
reconnects with backoff, and calls `_stream_once` again, reusing the same
`audio_chunks` iterator, which is safe since it's just a live queue of PCM
frames, not a one-shot resource. Only once reconnecting is exhausted (3
attempts) does a `ProviderError(CONNECTION)` reach `app.orchestrator`.

Tuning lab: the four query-string knobs the panel exposes (`model`,
`endpointing`, `utterance_end_ms`, `diarize`) come in as a `DeepgramParams`
argument to `stream()` rather than being read from the module constants, so
one session's live Apply can never re-parameterise another session's
connection. The constants stay, as `DeepgramParams`' defaults: a `stream()`
call that passes no params builds exactly the URL it always did.
"""

import asyncio
import collections
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Final

import websockets
from websockets.exceptions import InvalidStatus, WebSocketException

from app.providers._resilience import ConnectionDropped, with_reconnect
from app.providers.base import (
    AudioChunk,
    ProviderError,
    ProviderErrorKind,
    TranscriptSegment,
    UtteranceEndSignal,
)
from app.tuning.schema import CascadeTuning

DEEPGRAM_URL: Final = "wss://api.deepgram.com/v1/listen"
MODEL: Final = "nova-3"
ENDPOINTING_MS: Final = 500
# Ticket 5: silence gap (ms) after which Deepgram fires `UtteranceEnd`:
# the hard fallback ceiling the LLM-hybrid segmentation race always honors,
# in both segmentation modes. Must be in Deepgram's documented 1000-5000
# range; 3000 is the ticket's chosen middle value.
UTTERANCE_END_MS: Final = 3000
SAMPLE_RATE: Final = 16000

# Sentinel pushed onto the queue once the receive loop ends (socket closed),
# so stream() knows to stop draining and return instead of hanging forever.
_STREAM_DONE: Final = object()


@dataclass(frozen=True)
class DeepgramParams:
    """The four connection-level knobs the tuning panel exposes: they live in
    the query string, so changing any of them means a new socket (see
    `app.tuning.allowlists.DEEPGRAM_CONNECTION_LEVEL_FIELDS`).

    Every default here **is** the module constant above, which is what keeps a
    `stream()` call that passes no params byte-identical to the pre-tuning
    URL. Passed per `stream()` call and never stored on the provider: one
    session's Apply must not re-parameterise another session's live
    connection, which is exactly what mutating the module constants (or
    provider state) would do.
    """

    model: str = MODEL
    endpointing_ms: int = ENDPOINTING_MS
    utterance_end_ms: int = UTTERANCE_END_MS
    diarize: bool = True

    @classmethod
    def from_tuning(cls, tuning: CascadeTuning) -> "DeepgramParams":
        return cls(
            model=tuning.deepgram.model,
            endpointing_ms=tuning.deepgram.endpointing_ms,
            utterance_end_ms=tuning.deepgram.utterance_end_ms,
            diarize=tuning.deepgram.diarize,
        )


class DeepgramSTTProvider:
    """Swapping STT vendors means writing one class like this one:
    nothing upstream or downstream of `STTProvider.stream()` changes.
    """

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def stream(
        self,
        audio_chunks: AsyncIterator[AudioChunk],
        *,
        languages: tuple[str, ...],
        params: DeepgramParams | None = None,
    ) -> AsyncIterator[TranscriptSegment | UtteranceEndSignal]:
        del languages  # candidate-set language detection is a later ticket
        resolved = params or DeepgramParams()
        return with_reconnect(
            lambda: self._stream_once(audio_chunks, resolved), provider="deepgram"
        )

    async def _stream_once(
        self, audio_chunks: AsyncIterator[AudioChunk], params: DeepgramParams
    ) -> AsyncIterator[TranscriptSegment | UtteranceEndSignal]:
        """One connect+drain attempt. See `with_reconnect` for the
        reconnect loop wrapped around this."""
        queue: asyncio.Queue[
            TranscriptSegment | UtteranceEndSignal | ConnectionDropped | object
        ] = asyncio.Queue()

        try:
            # Connect/keepalive bounds stated explicitly rather than
            # inherited from library defaults: a connect attempt fails
            # after 10s, and a peer that stops answering protocol pings is
            # detected within ~40s (ping_interval + ping_timeout) and
            # surfaces as `ConnectionClosed` -> the `with_reconnect` path,
            # instead of a silently hung session.
            async with websockets.connect(
                self._url(params),
                additional_headers={"Authorization": f"Token {self._api_key}"},
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=10,
            ) as socket:
                pump_task = asyncio.create_task(_pump_audio(socket, audio_chunks))
                receive_task = asyncio.create_task(_receive_results(socket, queue))
                try:
                    while True:
                        item = await queue.get()
                        if item is _STREAM_DONE:
                            return
                        if isinstance(item, ConnectionDropped):
                            raise item
                        yield item
                finally:
                    pump_task.cancel()
                    receive_task.cancel()
                    await asyncio.gather(pump_task, receive_task, return_exceptions=True)
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status == 429:
                raise ProviderError(
                    ProviderErrorKind.RATE_LIMIT,
                    "deepgram",
                    f"connection rejected: HTTP {status}",
                    retryable=True,
                ) from exc
            raise ProviderError(
                ProviderErrorKind.CONNECTION,
                "deepgram",
                f"connection rejected: HTTP {status}",
                retryable=status != 401,
            ) from exc
        except WebSocketException as exc:
            raise ConnectionDropped("deepgram", exc) from exc
        except (OSError, TimeoutError) as exc:
            raise ProviderError(
                ProviderErrorKind.TIMEOUT, "deepgram", str(exc), retryable=True
            ) from exc

    def _url(self, params: DeepgramParams) -> str:
        query_params = {
            "interim_results": "true",
            "endpointing": str(params.endpointing_ms),
            # Ticket 5: `utterance_end_ms` needs `interim_results=true`
            # (already set above) to fire at all; `vad_events=true` enables
            # Deepgram's voice-activity events (e.g. `SpeechStarted`);
            # unused here, but required alongside `utterance_end_ms` per
            # Deepgram's docs. Any event type this provider doesn't
            # explicitly parse (`_parse_message`) is ignored, same as
            # `Metadata` already is.
            "utterance_end_ms": str(params.utterance_end_ms),
            "vad_events": "true",
            "encoding": "linear16",
            "sample_rate": str(SAMPLE_RATE),
            "channels": "1",
            "model": params.model,
            # `detect_language` is pre-recorded-audio-only per Deepgram's
            # docs. Not usable on this live streaming connection.
            # `language=multi` is Nova-3's streaming equivalent: every word
            # in a Results message carries its own `language` field instead.
            "language": "multi",
            "diarize": "true" if params.diarize else "false",
        }
        query = "&".join(f"{key}={value}" for key, value in query_params.items())
        return f"{DEEPGRAM_URL}?{query}"


async def _pump_audio(socket: Any, audio_chunks: AsyncIterator[AudioChunk]) -> None:
    async for chunk in audio_chunks:
        await socket.send(chunk)


async def _receive_results(socket: Any, queue: asyncio.Queue) -> None:
    """Drains `Results` messages into `queue` until the socket closes.
    Ticket 7: a `WebSocketException`/`OSError`/`TimeoutError` here means
    the connection dropped mid-stream: pushes `ConnectionDropped` (which
    `_stream_once`'s main loop turns into a raised exception `with_reconnect`
    can catch and retry) instead of the graceful-end `_STREAM_DONE`.

    A malformed/non-JSON frame (`json.JSONDecodeError` from `_parse_message`'s
    `json.loads`) is routed through the exact same `ConnectionDropped` path
    rather than left uncaught: left uncaught, this task would simply die
    (silently, per asyncio's "exception was never retrieved") and
    `stream()`'s consumer would block on `queue.get()` forever. No
    `ProviderError` ever reaches the orchestrator, so its retry/circuit-
    breaker machinery never engages and the session hangs.
    """
    try:
        async for raw in socket:
            segment = _parse_message(raw)
            if segment is not None:
                queue.put_nowait(segment)
    except (WebSocketException, OSError, TimeoutError, json.JSONDecodeError) as exc:
        queue.put_nowait(ConnectionDropped("deepgram", exc))
        return
    queue.put_nowait(_STREAM_DONE)


def _parse_message(raw: str | bytes) -> TranscriptSegment | UtteranceEndSignal | None:
    message = json.loads(raw)
    message_type = message.get("type")
    if message_type == "UtteranceEnd":
        return UtteranceEndSignal()
    if message_type != "Results":
        return None
    alternatives = message.get("channel", {}).get("alternatives", [])
    text = alternatives[0]["transcript"] if alternatives else ""
    words = alternatives[0].get("words", []) if alternatives else []
    return TranscriptSegment(
        text=text,
        is_final=bool(message.get("is_final", False)),
        speech_final=bool(message.get("speech_final", False)),
        speaker=_majority_word_value(words, "speaker"),
        detected_language=_majority_word_value(words, "language"),
    )


def _majority_word_value(words: list[dict], key: str) -> Any | None:
    """One value per Results message for a per-word field (`speaker` or
    `language`): the most common value among the message's words, ties
    broken by first occurrence. `None` if no word carries the field,
    e.g. a non-diarized/single-language response, or an empty result.

    Majority vote (rather than simply the first word) so one misclassified
    word at an utterance's edge doesn't flip the whole segment's label.
    """
    counts = collections.Counter(word[key] for word in words if word.get(key) is not None)
    if not counts:
        return None
    return counts.most_common(1)[0][0]
