"""Concrete `TTSProvider` for ElevenLabs' `stream-input` WebSocket endpoint.

One connection per already-segmented unit of text, matching
`TTSProvider.synthesize`'s contract (one call = one segment): send
`InitializeConnection` first, then a `SendText` message per incoming
`TTSText` chunk as translated text streams in, `flush: true` when the
orchestrator's `TTSFlush` marks the segment complete, then
`CloseConnection`. Output is raw PCM16 at a fixed 16kHz sample rate (see
`SAMPLE_RATE`) so the browser's Web Audio scheduling has a known format to
build against.

Uses the same receive-queue bridge as `deepgram_stt.py`: a concurrent task
drains `AudioOutput` messages into an `asyncio.Queue`, `synthesize()` drains
that queue and yields decoded bytes.

Ticket 7: same reconnect treatment as `deepgram_stt.py`: `_receive_audio`
pushes a `ConnectionDropped` marker (instead of raising directly) on a
connect-time or mid-stream drop, `_synthesize_once`'s main loop turns it
back into a raised exception, and `with_reconnect` (`_resilience.py`)
reconnects with backoff before giving up. Reusing the same `input_events`
iterator across a reconnect is safe for the realistic case (a drop before
any text was sent, e.g. rate limit/auth/connect timeout. See
`app.orchestrator._run_tts_with_retry`'s docstring for why every
`ProviderError` that reaches the orchestrator from this provider is
guaranteed to be pre-consumption); a genuine mid-stream drop reusing the
same partially-drained queue is a rarer, accepted simplification.
"""

import asyncio
import base64
import json
from collections.abc import AsyncIterator
from typing import Any, Final

import websockets
from websockets.exceptions import InvalidStatus, WebSocketException

from app.providers._resilience import ConnectionDropped, with_reconnect
from app.providers.base import ProviderError, ProviderErrorKind, TTSFlush, TTSText

ELEVENLABS_URL: Final = "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input"
MODEL_ID: Final = "eleven_flash_v2_5"
SAMPLE_RATE: Final = 16000
OUTPUT_FORMAT: Final = f"pcm_{SAMPLE_RATE}"

# Sentinel pushed onto the queue once the receive loop ends (FinalOutput
# received or socket closed), so synthesize() knows to stop and return.
_STREAM_DONE: Final = object()


class ElevenLabsTTSProvider:
    """Swapping TTS vendors means writing one class like this one:
    nothing upstream or downstream of `TTSProvider.synthesize()` changes.
    """

    def __init__(self, api_key: str, voice_id: str) -> None:
        self._api_key = api_key
        self._voice_id = voice_id  # fallback used only if `voice` is falsy

    def synthesize(
        self, input_events: AsyncIterator[TTSText | TTSFlush], *, voice: str
    ) -> AsyncIterator[bytes]:
        # `voice` is the ElevenLabs voice_id for this connection. One call
        # is one already-segmented unit (per `TTSProvider.synthesize`'s
        # contract), so the caller is free to vary it per segment, e.g.
        # per-speaker voice assignment (see `orchestrator._voice_for_speaker`).
        resolved_voice_id = voice or self._voice_id
        return with_reconnect(
            lambda: self._synthesize_once(input_events, resolved_voice_id), provider="elevenlabs"
        )

    async def _synthesize_once(
        self, input_events: AsyncIterator[TTSText | TTSFlush], resolved_voice_id: str
    ) -> AsyncIterator[bytes]:
        """One connect+drain attempt. See `with_reconnect` for the
        reconnect loop wrapped around this."""
        queue: asyncio.Queue[bytes | ConnectionDropped | object] = asyncio.Queue()

        try:
            async with websockets.connect(
                self._url(resolved_voice_id), additional_headers={"xi-api-key": self._api_key}
            ) as socket:
                await socket.send(json.dumps(_initialize_message()))

                send_task = asyncio.create_task(_send_text(socket, input_events))
                receive_task = asyncio.create_task(_receive_audio(socket, queue))
                try:
                    while True:
                        item = await queue.get()
                        if item is _STREAM_DONE:
                            return
                        if isinstance(item, ConnectionDropped):
                            raise item
                        yield item
                finally:
                    send_task.cancel()
                    receive_task.cancel()
                    await asyncio.gather(send_task, receive_task, return_exceptions=True)
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status == 429:
                raise ProviderError(
                    ProviderErrorKind.RATE_LIMIT,
                    "elevenlabs",
                    f"connection rejected: HTTP {status}",
                    retryable=True,
                ) from exc
            raise ProviderError(
                ProviderErrorKind.CONNECTION,
                "elevenlabs",
                f"connection rejected: HTTP {status}",
                retryable=status != 401,
            ) from exc
        except WebSocketException as exc:
            raise ConnectionDropped("elevenlabs", exc) from exc
        except (OSError, TimeoutError) as exc:
            raise ProviderError(
                ProviderErrorKind.TIMEOUT, "elevenlabs", str(exc), retryable=True
            ) from exc

    def _url(self, voice_id: str) -> str:
        base = ELEVENLABS_URL.format(voice_id=voice_id)
        return f"{base}?model_id={MODEL_ID}&output_format={OUTPUT_FORMAT}"


def _initialize_message() -> dict:
    return {
        "text": " ",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.8},
    }


async def _send_text(socket: Any, input_events: AsyncIterator[TTSText | TTSFlush]) -> None:
    async for event in input_events:
        if isinstance(event, TTSText):
            await socket.send(json.dumps({"text": event.text}))
        else:
            await socket.send(json.dumps({"text": "", "flush": True}))
            await socket.send(json.dumps({"text": ""}))  # CloseConnection
            return


async def _receive_audio(socket: Any, queue: asyncio.Queue) -> None:
    """Drains `AudioOutput` messages into `queue` until `isFinal` or the
    socket closes. Ticket 7: a `WebSocketException`/`OSError`/`TimeoutError`
    here means the connection dropped mid-stream: pushes
    `ConnectionDropped` (turned into a raised exception by
    `_synthesize_once`'s main loop, for `with_reconnect` to catch and
    retry) instead of the graceful-end `_STREAM_DONE`.

    A malformed/non-JSON frame (`json.JSONDecodeError` from `json.loads`
    above) is routed through the exact same `ConnectionDropped` path rather
    than left uncaught: left uncaught, this task would simply die (silently,
    per asyncio's "exception was never retrieved") and `synthesize()`'s
    consumer would block on `queue.get()` forever. No `ProviderError` ever
    reaches the orchestrator, so its retry/circuit-breaker machinery never
    engages and the session hangs.
    """
    try:
        async for raw in socket:
            message = json.loads(raw)
            audio_b64 = message.get("audio")
            if audio_b64:
                queue.put_nowait(base64.b64decode(audio_b64))
            if message.get("isFinal"):
                queue.put_nowait(_STREAM_DONE)
                return
    except (WebSocketException, OSError, TimeoutError, json.JSONDecodeError) as exc:
        queue.put_nowait(ConnectionDropped("elevenlabs", exc))
        return
    queue.put_nowait(_STREAM_DONE)
