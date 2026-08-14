"""Cascade pipeline orchestrator: wires STT -> Translation -> TTS over one
full-duplex WebSocket per session (see `app/api/cascade.py` for the thin
route that calls into this module).

Language pair comes from the client's `start_session.languages` (a
2-element `[source, target]` pair), defaulting to `DEFAULT_LANGUAGES` if
missing or malformed rather than erroring.

Direction is resolved per segment, not fixed for the whole session: each
segment's `detected_language` (from Deepgram's diarization/multi-language
streaming mode, see `deepgram_stt.py`) picks which of the two configured
languages is source vs. target for that segment. See
`_resolve_direction`. `speaker` is threaded through purely for labeling and
per-speaker TTS voice (`_voice_for_speaker`); it never affects translation
direction.

Concurrency shape: one task drains Deepgram's `TranscriptSegment` stream and
emits `source_transcript`/`segment_boundary` messages, appending completed
segments to a queue; a second task drains that queue and runs
translate -> TTS for each completed segment in turn, so a slow
translation/TTS call never blocks audio capture or STT from moving on to
the next segment. All outbound WebSocket writes go through `_OutgoingSocket`
so a `tts_audio_meta` message is never separated from the binary frame that
follows it.

Latency instrumentation (Ticket 6): a `latency` message is emitted per
segment as each of five stages is crossed: `speech_end` (the reference
point, always `ms: 0`), `translation_first_token`, `translation_complete`,
`tts_first_byte`, and `playback_start`, each `ms` cumulative since that
segment's `speech_end`. The first four are measured server-side against
`_now_ms()`, a single wall-clock (epoch ms) function used everywhere in this
module instead of `time.monotonic()`, because `playback_start` needs to
compare against a client-reported timestamp converted through a clock-sync
offset (see `_LatencyTracker`), and bridging one monotonic clock and one
wall clock would only add complexity for no benefit here. `_pump_client_messages`
handles the two new client->server message types this adds: `clock_sync`
(answered immediately with `clock_sync_ack`, and tracked for the offset
calc) and `playback_started` (converted into the final `latency`
message for its segment).

Error handling & session resilience (Ticket 7):

- Per-segment retry: `_run_translation_with_retry`/`_run_tts_with_retry`
  wrap each stage with bounded, failure-mode-specific retries (see
  `app.providers._resilience.retry_backoffs`), then drop the segment (send
  the existing `error` message, `retryable: true`) rather than ever
  crashing the session over one bad segment.
- Circuit breaker: `_CircuitBreaker` tracks consecutive dropped segments
  across the whole session (STT's own connection-exhausted failures count
  too, see `_run_stt`); the 5th trips a hard, non-retryable `circuit_open`
  error and `_run_pipeline` stops attempting further segments. The socket
  stays open so the client can show the terminal state.
- Backend<->provider reconnect (Deepgram/ElevenLabs WebSocket drops) is
  handled one layer down, inside `deepgram_stt.py`/`elevenlabs_tts.py`
  themselves (see `app.providers._resilience.with_reconnect`), invisible
  to this module except as an ordinary `ProviderError(CONNECTION)` once
  reconnecting is exhausted.
- Browser<->backend reconnect (grace-window session resume): a
  `session_started` message right after `start_session` hands the client a
  `sessionId`; an unexpected disconnect (see `_pump_client_messages`, which
  distinguishes this from a clean client-initiated close) detaches the
  session into `_detached_sessions` for `GRACE_WINDOW_S` instead of tearing
  it down immediately, reclaimable via a `resume_session` first-message on
  a new WebSocket (see `_resume_session`). Catching the client up on
  messages sent while detached is out of scope: `_OutgoingSocket.detach()`
  simply drops sends until `rebind()` re-attaches a socket.

LLM-hybrid segmentation (Ticket 5): segmentation is no longer Deepgram's
`speech_final` alone. `_run_stt` also fires an async LLM clause-check
(`app.providers.segmentation_checker.SegmentationChecker`) against the
in-progress segment's accumulated text and races it (via
`asyncio.wait(..., return_when=FIRST_COMPLETED)`) against Deepgram's own
boundary signals (`speech_final` on a `TranscriptSegment`, or an
`UtteranceEndSignal`). Whichever resolves first cuts the segment; the loser
(if it's the clause-check) is left running to completion in the background
and its eventual result discarded. See `_run_stt`'s `stale_tasks`.
Debounce is "one clause-check in flight for the current in-progress
segment" (this architecture has exactly one accumulator at a time, not one
per speaker, an intentional simplification per the ticket, not a gap).
`start_session.segmentationMode` (`"hybrid"`, the default, or
`"llm_priority"`) picks which signals are allowed to cut: `llm_priority`
ignores `speech_final` entirely (only a `True` clause-check verdict or the
`UtteranceEnd` hard-fallback-ceiling cuts), so a segment can never hang
indefinitely in either mode. `segment_boundary.trigger` reports which
mechanism won: `deepgram_speech_final`, `llm`, or `deepgram_utterance_end`.
"""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Final

from fastapi import WebSocket, WebSocketDisconnect

from app.config import settings
from app.languages import SUPPORTED_LANGUAGES
from app.observability import metrics as obs_metrics
from app.observability import spans as obs_spans
from app.origins import is_allowed_origin
from app.providers._resilience import retry_backoffs
from app.providers.base import (
    AudioChunk,
    ProviderError,
    ProviderErrorKind,
    STTProvider,
    TranslationProvider,
    TTSFlush,
    TTSProvider,
    TTSText,
    UtteranceEndSignal,
)
from app.providers.deepgram_stt import DeepgramSTTProvider
from app.providers.elevenlabs_tts import SAMPLE_RATE as TTS_SAMPLE_RATE
from app.providers.elevenlabs_tts import ElevenLabsTTSProvider
from app.providers.openai_translation import OpenAITranslationProvider
from app.providers.segmentation_checker import SegmentationChecker

logger = logging.getLogger(__name__)

DEFAULT_LANGUAGES: Final[tuple[str, str]] = ("en", "es")

# Ticket 7: consecutive dropped segments (any cause: exhausted
# translation/TTS retry, or an STT connection permanently lost) that trips
# the "interpretation unavailable" circuit breaker.
CIRCUIT_BREAKER_THRESHOLD: Final = 5

# Ticket 7: how long a session detached by an unexpected browser<->backend
# WebSocket drop stays reclaimable via `resume_session` before it's torn
# down. A few seconds, per the ticket: long enough for a wifi hiccup or a
# laptop waking from sleep, short enough not to hold provider connections
# open indefinitely for a session nobody's coming back to.
GRACE_WINDOW_S: Final = 5.0

# Ticket 7: outgoing sends queued behind `_OutgoingSocket`'s lock at once
# before we log a backpressure warning (the client is reading slower than
# the pipeline is producing), a signal worth surfacing, not something
# this ticket's scope calls for solving with real flow control.
_BACKPRESSURE_WARN_THRESHOLD: Final = 5

_END_OF_AUDIO = object()


def _new_segment_id() -> str:
    return uuid.uuid4().hex


def _new_session_id() -> str:
    return uuid.uuid4().hex


def _now_ms() -> int:
    """Server wall-clock time in epoch milliseconds: the one clock this
    module reads for every latency timestamp: a segment's `speech_end`, each
    later stage's elapsed-ms calculation, and `clock_sync_ack`'s
    `serverTime`. Keeping all of them on the same clock is what makes it
    possible to convert a client-reported `playback_started.clientTime`
    into this timeline via the tracked offset (see `_LatencyTracker`)."""
    return round(time.time() * 1000)


def _resolve_direction(
    detected_language: str | None, configured_source: str, configured_target: str
) -> tuple[str, str]:
    """Picks (from_lang, to_lang) for one segment's translation call: of the
    two configured session languages, translate to whichever one the
    segment ISN'T in. No manual per-turn toggle. Falls back to the
    session's configured default direction (`configured_source` ->
    `configured_target`) when `detected_language` is `None` or matches
    neither configured language, rather than erroring.
    """
    if detected_language == configured_target:
        return configured_target, configured_source
    return configured_source, configured_target


def _voice_for_speaker(speaker: int | None) -> str:
    """Consistent `speaker` -> ElevenLabs voice_id mapping for the whole
    session. Speaker 0 (or no diarization signal, i.e. `None`) gets
    `settings.elevenlabs_voice_id`; speaker 1 gets
    `settings.elevenlabs_voice_id_speaker_b`; speaker 2+ wraps back to
    speaker 0's voice rather than erroring. Two speakers is the
    tested/expected case, more shouldn't crash the session.
    """
    if speaker is not None and speaker % 2 == 1:
        return settings.elevenlabs_voice_id_speaker_b
    return settings.elevenlabs_voice_id


@dataclass
class _CompletedSegment:
    segment_id: str
    text: str
    speaker: int | None
    detected_language: str | None
    otel: obs_spans.SpanHandle | None = None
    started_at: float = 0.0


class _LatencyTracker:
    """Per-session state for the `latency` message protocol: a `speech_end`
    server-time-ms timestamp per segment still mid-flight through
    translate -> TTS -> playback, plus the most recent clock-sync offset
    pair. `_speech_end_ms` is bounded by segments currently in flight, not
    by session length: an entry is popped as soon as that segment's
    `playback_start` figure is resolved (see `resolve_playback_start`), or
    (Ticket 7) discarded outright if the segment is dropped before it ever
    gets that far (see `discard`), either path keeps this dict from
    accumulating one stale entry per failed segment for the rest of the
    session.
    """

    def __init__(self) -> None:
        self._speech_end_ms: dict[str, int] = {}
        self._latest_client_time: float | None = None
        self._latest_server_time: int | None = None

    def mark_speech_end(self, segment_id: str) -> None:
        self._speech_end_ms[segment_id] = _now_ms()

    def discard(self, segment_id: str) -> None:
        """Drops any stored `speech_end` for a segment that was dropped
        (Ticket 7's per-segment retry/circuit-breaker paths) before it ever
        reached playback. No `playback_start` will ever be reported for
        it, so nothing would otherwise pop this entry."""
        self._speech_end_ms.pop(segment_id, None)

    def elapsed_since_speech_end(self, segment_id: str) -> int | None:
        """`None` if `segment_id` has no stored `speech_end`, shouldn't
        happen in the normal flow (every segment reaching a later stage was
        already marked), guarded rather than trusted."""
        speech_end = self._speech_end_ms.get(segment_id)
        if speech_end is None:
            return None
        return _now_ms() - speech_end

    def record_clock_sync(self, client_time: float, server_time: int) -> None:
        self._latest_client_time = client_time
        self._latest_server_time = server_time

    def resolve_playback_start(self, segment_id: str, client_time: float) -> int | None:
        """Converts a `playback_started.clientTime` into elapsed ms since
        this segment's `speech_end`, via the most recent clock-sync offset
        (0, meaning clocks assumed aligned, if no `clock_sync` has landed yet,
        which shouldn't occur given the client sends one right after
        `start_session`). Returns `None` for a `segment_id` with no stored
        `speech_end`: a stale/duplicate report, or one arriving after this
        entry was already popped by an earlier call, so the caller can
        drop it silently per the wire contract."""
        speech_end = self._speech_end_ms.pop(segment_id, None)
        if speech_end is None:
            return None
        offset = 0.0
        if self._latest_client_time is not None and self._latest_server_time is not None:
            offset = self._latest_server_time - self._latest_client_time
        converted_server_time = client_time + offset
        return round(converted_server_time - speech_end)


class _OutgoingSocket:
    """Serializes every write to one WebSocket. Without this, concurrent
    pipeline stages (STT loop, translation/TTS loop) could interleave
    frames; a `tts_audio_meta` message must never be separated from
    the binary frame it describes.

    Ticket 7: also the browser<->backend grace-window resume's reattachment
    point (`detach`/`rebind`) and a cheap backpressure signal. While
    detached (between an unexpected disconnect and either a `resume_session`
    reattach or grace-window expiry), every send is a silent no-op:
    catching the client up on what it missed is explicitly out of scope
    (dropped, not buffered/replayed, is this module's documented choice).
    A send racing a socket that died since the caller last checked (e.g. the
    pipeline sending while `_pump_client_messages` hasn't yet noticed the
    drop) is treated the same way rather than propagating and crashing the
    caller.
    """

    def __init__(self, websocket: WebSocket) -> None:
        self._websocket: WebSocket | None = websocket
        self._lock = asyncio.Lock()
        self._pending = 0

    def detach(self) -> None:
        self._websocket = None

    def rebind(self, websocket: WebSocket) -> None:
        self._websocket = websocket

    async def send_json(self, payload: dict) -> None:
        async def _do(websocket: WebSocket) -> None:
            await websocket.send_json(payload)

        await self._send(_do)

    async def send_audio(
        self, *, segment_id: str, sample_rate: int, audio: bytes, speaker: int | None
    ) -> None:
        async def _do(websocket: WebSocket) -> None:
            await websocket.send_json(
                {
                    "type": "tts_audio_meta",
                    "segmentId": segment_id,
                    "sampleRate": sample_rate,
                    "speaker": speaker,
                }
            )
            await websocket.send_bytes(audio)

        await self._send(_do)

    async def _send(self, action) -> None:
        self._pending += 1
        if self._pending > _BACKPRESSURE_WARN_THRESHOLD:
            logger.warning(
                "outgoing WebSocket backpressure: %d sends pending (client slow to read?)",
                self._pending,
            )
        try:
            async with self._lock:
                websocket = self._websocket
                if websocket is None:
                    return  # detached: dropped, per the class docstring
                try:
                    await action(websocket)
                except WebSocketDisconnect:
                    # Died between our last check and this send: treat as
                    # detached rather than crash the caller; noticing the
                    # drop and starting the grace window is
                    # `_pump_client_messages`'s job, not this one's.
                    self._websocket = None
        finally:
            self._pending -= 1


class _CircuitBreaker:
    """Tracks consecutive dropped segments for one session's pipeline
    (Ticket 7): `record_success` resets the streak; `record_failure`
    increments it and returns `True` exactly once, on the attempt that
    reaches `CIRCUIT_BREAKER_THRESHOLD`: the caller uses that to send the
    `circuit_open` message exactly once rather than on every failure
    thereafter.
    """

    def __init__(self, threshold: int = CIRCUIT_BREAKER_THRESHOLD) -> None:
        self._threshold = threshold
        self._consecutive_failures = 0
        self.is_open = False

    def record_success(self) -> None:
        self._consecutive_failures = 0

    def record_failure(self) -> bool:
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._threshold and not self.is_open:
            self.is_open = True
            return True
        return False


@dataclass
class _DetachedSession:
    """One session's live orchestrator state, held in `_detached_sessions`
    between an unexpected disconnect and either a `resume_session` reattach
    or `GRACE_WINDOW_S` expiry (Ticket 7 item #3)."""

    session_id: str
    outgoing: _OutgoingSocket
    audio_queue: "asyncio.Queue[bytes | object]"
    latency: _LatencyTracker
    stt_task: "asyncio.Task[None]"
    pipeline_task: "asyncio.Task[None]"
    expiry_task: "asyncio.Task[None] | None" = field(default=None)
    otel_context: obs_spans.SpanHandle | None = field(default=None)


# Module-level registry of detached sessions: deliberately simple
# (in-process dict, not shared across workers/restarts) per the ticket's
# explicitly bounded scope for this reconnect path.
_detached_sessions: dict[str, _DetachedSession] = {}


async def run_cascade_session(websocket: WebSocket) -> None:
    # Security: `CORSMiddleware` (see `app.main`) never inspects WebSocket
    # upgrades (`scope["type"] == "websocket"` bypasses it entirely), so
    # without this check any page a developer has open (no
    # getUserMedia()/mic permission needed, just a raw `new WebSocket(...)`)
    # could open a session here and run up provider API costs. Browsers
    # always send `Origin` on a cross-origin WebSocket connect, so reject
    # one that's present but not in `settings.cors_origins`; a client that
    # sends no `Origin` at all (a non-browser tool, a legitimate local dev/
    # testing use case) is let through: this defends against
    # *browser*-originated cross-site abuse specifically, not all
    # non-browser clients.
    origin = websocket.headers.get("origin")
    if not is_allowed_origin(origin):
        logger.warning("rejecting WebSocket connect from disallowed origin %r", origin)
        await websocket.close(code=1008, reason="origin not allowed")
        return

    await websocket.accept()

    first_message = await _read_first_message(websocket)
    if first_message is None:
        return

    message_type = first_message.get("type")
    if message_type == "resume_session":
        await _resume_session(websocket, first_message)
        return
    if message_type != "start_session":
        await websocket.close(code=1002, reason="first message must be start_session")
        return

    await _start_new_session(websocket, first_message)


async def _read_first_message(websocket: WebSocket) -> dict | None:
    """Reads the required first message of a new connection: either
    `start_session` (a fresh session) or `resume_session` (Ticket 7's
    grace-window reattach). Returns None (and leaves the socket
    closed/closing) if the client disconnected before sending it or sent
    something unparseable. The caller should stop, not proceed."""
    message = await websocket.receive()
    if message["type"] == "websocket.disconnect":
        return None

    text = message.get("text")
    if text is None:
        await websocket.close(code=1002, reason="expected a JSON message first")
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        await websocket.close(code=1002, reason="first message must be valid JSON")
        return None


def _parse_languages(raw: object) -> tuple[str, str]:
    """`languages` is expected to be a 2-element `[source, target]` array of
    codes from `app.languages.SUPPORTED_LANGUAGES`: the same allow-list
    `app.api.realtime` validates `sourceLanguage`/`targetLanguage` against.
    Anything else (missing, wrong length, non-string entries, or a code
    outside that allow-list) falls back to `DEFAULT_LANGUAGES` rather than
    erroring: unlike `realtime.py`'s HTTP 400, there's no clean "reject
    before accepting" point for a `start_session` message mid-connection,
    so malformed *or* unsupported client input shouldn't be able to kill a
    session before it starts; it also shouldn't be trusted verbatim into
    the LLM system prompts this pair drives for the rest of the session."""
    if (
        isinstance(raw, list | tuple)
        and len(raw) == 2
        and all(isinstance(code, str) and code in SUPPORTED_LANGUAGES for code in raw)
    ):
        return (raw[0], raw[1])
    return DEFAULT_LANGUAGES


_SEGMENTATION_MODES: Final = frozenset({"hybrid", "llm_priority"})


def _parse_segmentation_mode(raw: object) -> str:
    """`segmentationMode` (Ticket 5) is expected to be `"hybrid"` or
    `"llm_priority"`. Anything else (missing, unrecognized) falls back
    to `"hybrid"` rather than erroring, same tolerance as
    `_parse_languages`. See `_run_stt` for what each mode does."""
    if raw in _SEGMENTATION_MODES:
        return raw
    return "hybrid"


async def _start_new_session(websocket: WebSocket, payload: dict) -> None:
    source_lang, target_lang = _parse_languages(payload.get("languages"))
    segmentation_mode = _parse_segmentation_mode(payload.get("segmentationMode"))

    session_id = _new_session_id()
    outgoing = _OutgoingSocket(websocket)
    # Sent immediately, before any transcript/latency traffic, so the
    # client always has a `sessionId` to hand back in a future
    # `resume_session`. See the module docstring's Ticket 7 section.
    await outgoing.send_json({"type": "session_started", "sessionId": session_id})

    session_otel = obs_spans.start_session_span(session_id, (source_lang, target_lang), segmentation_mode)
    token = obs_spans.attach(session_otel)

    latency = _LatencyTracker()
    breaker = _CircuitBreaker()
    audio_queue: asyncio.Queue[bytes | object] = asyncio.Queue()
    segment_queue: asyncio.Queue[_CompletedSegment] = asyncio.Queue()

    stt_provider = DeepgramSTTProvider(settings.deepgram_api_key)
    translation_provider = OpenAITranslationProvider(settings.openai_api_key)
    tts_provider = ElevenLabsTTSProvider(
        settings.elevenlabs_api_key, settings.elevenlabs_voice_id
    )
    segmentation_checker = SegmentationChecker(settings.openai_api_key)

    try:
        stt_task = asyncio.create_task(
            _run_stt(
                stt_provider,
                audio_queue,
                segment_queue,
                outgoing,
                latency,
                source_lang,
                target_lang,
                breaker,
                segmentation_checker,
                segmentation_mode,
            )
        )
        pipeline_task = asyncio.create_task(
            _run_pipeline(
                segment_queue,
                translation_provider,
                tts_provider,
                outgoing,
                latency,
                source_lang,
                target_lang,
                breaker,
            )
        )

        await _serve_session(
            session_id, websocket, outgoing, audio_queue, latency, stt_task, pipeline_task, session_otel
        )
    finally:
        obs_spans.detach(token)


async def _resume_session(websocket: WebSocket, payload: dict) -> None:
    """Handles a `resume_session` first message (Ticket 7 item #3): if
    `sessionId` names a still-detached session, cancels its expiry timer,
    re-points its `_OutgoingSocket` at this new connection, and resumes the
    same `_pump_client_messages` loop against the *existing* orchestrator
    state: no new pipeline, no re-sent `session_started`. Otherwise
    replies with a `not_found` error and lets the connection close."""
    session_id = payload.get("sessionId")
    detached = _detached_sessions.pop(session_id, None) if isinstance(session_id, str) else None
    if detached is None:
        await websocket.send_json(
            {
                "type": "error",
                "provider": "session",
                "kind": "not_found",
                "message": "Session expired or unknown -- please start a new session.",
                "retryable": False,
            }
        )
        return

    if detached.expiry_task is not None:
        detached.expiry_task.cancel()
        with contextlib.suppress(BaseException):
            await detached.expiry_task

    detached.outgoing.rebind(websocket)
    logger.info("session %s resumed", session_id)
    token = obs_spans.attach(detached.otel_context)
    try:
        await _serve_session(
            session_id,
            websocket,
            detached.outgoing,
            detached.audio_queue,
            detached.latency,
            detached.stt_task,
            detached.pipeline_task,
            detached.otel_context,
        )
    finally:
        obs_spans.detach(token)


async def _serve_session(
    session_id: str,
    websocket: WebSocket,
    outgoing: _OutgoingSocket,
    audio_queue: "asyncio.Queue[bytes | object]",
    latency: _LatencyTracker,
    stt_task: "asyncio.Task[None]",
    pipeline_task: "asyncio.Task[None]",
    session_otel: obs_spans.SpanHandle | None = None,
) -> None:
    """Runs `_pump_client_messages` for one attached WebSocket (fresh or
    resumed) and decides what happens when it stops: a clean,
    client-initiated close tears the session down normally; an unexpected
    drop (`WebSocketDisconnect`, see `_pump_client_messages`) detaches it
    into the grace-window registry instead."""
    try:
        await _pump_client_messages(websocket, audio_queue, outgoing, latency)
    except WebSocketDisconnect:
        outgoing.detach()
        await _detach_session(
            session_id, outgoing, audio_queue, latency, stt_task, pipeline_task, session_otel
        )
        return
    await _teardown_session(audio_queue, stt_task, pipeline_task, session_otel, end_reason="closed")


async def _teardown_session(
    audio_queue: "asyncio.Queue[bytes | object]",
    stt_task: "asyncio.Task[None]",
    pipeline_task: "asyncio.Task[None]",
    session_otel: obs_spans.SpanHandle | None = None,
    *,
    end_reason: str = "closed",
) -> None:
    audio_queue.put_nowait(_END_OF_AUDIO)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(stt_task, timeout=5)
    pipeline_task.cancel()
    with contextlib.suppress(BaseException):
        await pipeline_task
    obs_spans.end_session_span(
        session_otel, end_reason=end_reason, error=end_reason == "grace_window_expired"
    )


async def _detach_session(
    session_id: str,
    outgoing: _OutgoingSocket,
    audio_queue: "asyncio.Queue[bytes | object]",
    latency: _LatencyTracker,
    stt_task: "asyncio.Task[None]",
    pipeline_task: "asyncio.Task[None]",
    session_otel: obs_spans.SpanHandle | None = None,
) -> None:
    detached = _DetachedSession(
        session_id, outgoing, audio_queue, latency, stt_task, pipeline_task, otel_context=session_otel
    )
    detached.expiry_task = asyncio.create_task(_expire_after_grace_window(session_id))
    _detached_sessions[session_id] = detached
    logger.info("session %s detached, %.0fs grace window to resume", session_id, GRACE_WINDOW_S)


async def _expire_after_grace_window(session_id: str) -> None:
    await asyncio.sleep(GRACE_WINDOW_S)
    detached = _detached_sessions.pop(session_id, None)
    if detached is None:
        return  # already reclaimed by a `resume_session`
    logger.info("session %s grace window expired, tearing down", session_id)
    await _teardown_session(
        detached.audio_queue,
        detached.stt_task,
        detached.pipeline_task,
        detached.otel_context,
        end_reason="grace_window_expired",
    )


async def _pump_client_messages(
    websocket: WebSocket,
    audio_queue: asyncio.Queue,
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
) -> None:
    """Drains every client->server message for as long as this WebSocket is
    attached: binary frames are mic audio, `clock_sync` and
    `playback_started` are the two latency-protocol text messages defined
    on the wire (besides `start_session`/`resume_session`, handled before
    this loop starts). Any other/malformed text frame is ignored rather
    than erroring, same tolerance as `_parse_languages` for client input
    this module doesn't control.

    Ticket 7: returns normally on a clean, client-initiated close (close
    code 1000/1001); raises `WebSocketDisconnect` for anything else
    (network drop, tab crash, etc.) so `_serve_session` can tell them apart
    and route an unexpected drop into the grace-window resume path instead
    of tearing the session down immediately.
    """
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            code = message.get("code") or 1000
            if code in (1000, 1001):
                return
            raise WebSocketDisconnect(code=code, reason=message.get("reason"))
        audio_bytes = message.get("bytes")
        if audio_bytes is not None:
            audio_queue.put_nowait(audio_bytes)
            continue

        text = message.get("text")
        if text is None:
            continue
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            continue

        message_type = payload.get("type")
        if message_type == "clock_sync":
            await _handle_clock_sync(payload, outgoing, latency)
        elif message_type == "playback_started":
            await _handle_playback_started(payload, outgoing, latency)


async def _handle_clock_sync(
    payload: dict, outgoing: _OutgoingSocket, latency: _LatencyTracker
) -> None:
    client_time = payload.get("clientTime")
    if not isinstance(client_time, int | float):
        return
    server_time = _now_ms()
    latency.record_clock_sync(client_time, server_time)
    await outgoing.send_json(
        {"type": "clock_sync_ack", "clientTime": client_time, "serverTime": server_time}
    )


async def _handle_playback_started(
    payload: dict, outgoing: _OutgoingSocket, latency: _LatencyTracker
) -> None:
    segment_id = payload.get("segmentId")
    client_time = payload.get("clientTime")
    if not isinstance(segment_id, str) or not isinstance(client_time, int | float):
        return
    ms = latency.resolve_playback_start(segment_id, client_time)
    if ms is None:
        return  # stale/duplicate report: drop silently, per the wire contract
    await outgoing.send_json(
        {"type": "latency", "segmentId": segment_id, "stage": "playback_start", "ms": ms}
    )


async def _record_failure_and_maybe_trip(breaker: _CircuitBreaker, outgoing: _OutgoingSocket) -> None:
    """Shared by `_run_pipeline` (a dropped segment) and `_run_stt` (STT's
    own connection permanently lost) so the "5th consecutive failure trips
    the breaker" message is sent from exactly one place regardless of which
    stage caused it (Ticket 7: "reuses the same circuit breaker, not a
    separate mechanism")."""
    if breaker.record_failure():
        await outgoing.send_json(
            {
                "type": "error",
                "provider": "orchestrator",
                "kind": "circuit_open",
                "message": "Interpretation unavailable after repeated segment failures.",
                "retryable": False,
            }
        )
        obs_spans.emit_circuit_open_span()
        obs_metrics.record_error(provider="orchestrator", kind="circuit_open", retryable=False)


async def _cut_segment(
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
    segment_queue: asyncio.Queue[_CompletedSegment],
    segment_id: str,
    buffer: str,
    speaker: int | None,
    detected_language: str | None,
    trigger: str,
    started_at: float,
) -> None:
    """Closes out the current in-progress segment for whichever mechanism
    won Ticket 5's segmentation race: `trigger` is one of
    `"deepgram_speech_final"`, `"llm"`, `"deepgram_utterance_end"`. Shared
    by `_run_stt`'s three call sites so `segment_boundary`, the
    `speech_end` latency mark, and the queued `_CompletedSegment` stay in
    lockstep regardless of which signal fired. Caller guarantees `buffer`
    is non-empty: an empty in-progress segment has nothing to cut.
    """
    latency.mark_speech_end(segment_id)
    await outgoing.send_json(
        {"type": "segment_boundary", "segmentId": segment_id, "trigger": trigger}
    )
    await outgoing.send_json(
        {"type": "latency", "segmentId": segment_id, "stage": "speech_end", "ms": 0}
    )
    segment_otel = obs_spans.SpanHandle()
    try:
        segment_otel = obs_spans.start_segment_span(segment_id, trigger, speaker, detected_language)
        obs_spans.close_stt_span(segment_otel, buffer, speaker, detected_language)
        obs_metrics.record_stage_duration("stt", max((time.perf_counter() - started_at) * 1000, 0))
    except Exception:
        logger.exception("segment telemetry failed; continuing without a span")
        segment_otel = obs_spans.SpanHandle()
    segment_queue.put_nowait(
        _CompletedSegment(
            segment_id, buffer, speaker, detected_language, otel=segment_otel, started_at=started_at
        )
    )


async def _run_stt(
    stt_provider: STTProvider,
    audio_queue: asyncio.Queue,
    segment_queue: asyncio.Queue[_CompletedSegment],
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
    source_lang: str,
    target_lang: str,
    breaker: _CircuitBreaker,
    segmentation_checker: SegmentationChecker,
    segmentation_mode: str,
) -> None:
    """Drains `stt_provider.stream()`, accumulating one in-progress segment
    at a time into `buffer`, and cuts it (`_cut_segment`) whenever a
    segmentation boundary fires.

    Ticket 5: which boundary fires is a race, not just `speech_final`
    anymore. Each `next_item_task` (the stream's next event, fetched via
    `stt_iter.__anext__()` wrapped in a `Task` so it can be awaited
    alongside other things) is raced with
    `asyncio.wait(..., return_when=FIRST_COMPLETED)` against
    `clause_check_task` (an LLM clause-check for the current in-progress
    segment, at most one in flight at a time, see the debounce below).
    Capture itself never waits on either leg of this race: `audio_iter()`
    is drained by a *separate* task inside `stt_provider.stream()`
    (`deepgram_stt.py`'s `_pump_audio`), fully decoupled from this
    consuming loop.

    - A `TranscriptSegment` that grows `buffer` (an `is_final` chunk) fires
      a clause-check if none is already in flight for this segment,
      capturing `buffer` *at that moment* (the debounce).
    - `speech_final=True` cuts immediately, *unless*
      `segmentation_mode == "llm_priority"`, which ignores it entirely (no
      cut, no state change) per the ticket.
    - An `UtteranceEndSignal` always cuts, in both modes: the hard
      fallback ceiling Deepgram fires after `utterance_end_ms` of silence
      regardless of what the LLM check is doing.
    - `clause_check_task` resolving `True` cuts the segment using whatever
      `buffer` holds *at that moment*, possibly more than the snapshot
      the check evaluated, if further `is_final` chunks arrived while the
      call was in flight. Documented, intended behavior, not a bug.
    - Whichever side loses the race is never cancelled, only ever the
      clause-check (Deepgram's signals *are* this loop's only other input,
      so there's nothing else to lose against them): it's left running to
      completion and its result discarded via `stale_tasks`/
      `_discard_stale`, so a late verdict can never double-cut an
      already-closed segment, and a clause-check that raises or never
      resolves can never block or error the session. Deepgram's own
      signals are what actually guarantee a segment never hangs.
    """

    async def audio_iter() -> AsyncIterator[AudioChunk]:
        while True:
            chunk = await audio_queue.get()
            if chunk is _END_OF_AUDIO:
                return
            yield chunk

    # Clause-check tasks whose segment was already cut by a faster signal
    # before they resolved. Kept alive here (rather than just dropping the
    # reference) purely so nothing garbage-collects a still-pending `Task`
    # out from under it: asyncio only holds a weak reference to a task
    # once its last strong reference goes away. `_discard_stale` removes
    # each as it finishes and consumes any exception, so a late verdict is
    # silently ignored rather than logged as "exception was never
    # retrieved" or, worse, acted on.
    stale_tasks: set[asyncio.Task] = set()

    def _discard_stale(task: asyncio.Task) -> None:
        stale_tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            logger.debug(
                "stale clause-check task raised after its segment was already cut: %r",
                task.exception(),
            )

    def _park_stale(task: asyncio.Task) -> None:
        stale_tasks.add(task)
        task.add_done_callback(_discard_stale)

    # Outer retry loop, one attempt per `stt_provider.stream()` call: a
    # `ProviderError` reaching here is either a fresh connect-time failure
    # (rate limit/timeout/etc; `stream()` itself hasn't retried these) or
    # an already-exhausted `CONNECTION` (which *has* been retried, inside
    # `stream()`, see `app.providers._resilience.with_reconnect`, and
    # gets 0 further retries from `retry_backoffs` here). Either way, a
    # retry means starting a fresh `stream()` call over the *same*
    # `audio_queue` (via a fresh `audio_iter()`), so no audio is lost even
    # though Deepgram's own transcription state for the segment in
    # progress isn't: that in-flight segment's `buffer` is simply dropped
    # (reset for the next attempt) since it never reached a cut.
    attempt = 0
    while True:
        buffer = ""
        segment_id = _new_segment_id()
        segment_started_at = time.perf_counter()
        # Latest known speaker/detected_language for the segment in
        # progress: updated from every result (interim and final) so
        # preview messages reflect it too, carried into the
        # `_CompletedSegment` at cut time, then reset. A segment spanning a
        # genuine mid-utterance speaker/language change just keeps
        # overwriting these with the latest word's rollup (see
        # `deepgram_stt.py`), an explicitly unresolved edge case, not
        # solved here.
        current_speaker: int | None = None
        current_detected_language: str | None = None
        # At most one clause-check in flight for this in-progress segment
        # (Ticket 5's debounce). See the class docstring's race
        # description for what races against what.
        clause_check_task = None

        stt_iter = stt_provider.stream(
            audio_iter(), languages=(source_lang, target_lang)
        ).__aiter__()
        next_item_task = asyncio.create_task(stt_iter.__anext__())

        try:
            while True:
                waiting = {next_item_task}
                if clause_check_task is not None:
                    waiting.add(clause_check_task)
                done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)

                if next_item_task in done:
                    try:
                        result = next_item_task.result()
                    except StopAsyncIteration:
                        if clause_check_task is not None:
                            _park_stale(clause_check_task)
                        return  # audio exhausted (session ended), clean finish
                    # Fetch the *next* event before doing anything else
                    # with this one: capture never waits on how long
                    # this event takes to process.
                    next_item_task = asyncio.create_task(stt_iter.__anext__())

                    if isinstance(result, UtteranceEndSignal):
                        # Hard fallback ceiling: honored in both
                        # segmentation modes, unlike `speech_final` below.
                        if buffer:
                            if clause_check_task is not None:
                                _park_stale(clause_check_task)
                                clause_check_task = None
                            await _cut_segment(
                                outgoing,
                                latency,
                                segment_queue,
                                segment_id,
                                buffer,
                                current_speaker,
                                current_detected_language,
                                "deepgram_utterance_end",
                                segment_started_at,
                            )
                            buffer = ""
                            segment_id = _new_segment_id()
                            segment_started_at = time.perf_counter()
                            current_speaker = None
                            current_detected_language = None
                        continue

                    if result.speaker is not None:
                        current_speaker = result.speaker
                    if result.detected_language is not None:
                        current_detected_language = result.detected_language

                    if not result.is_empty:
                        if result.is_final:
                            buffer = (
                                f"{buffer} {result.text}".strip()
                                if buffer
                                else result.text.strip()
                            )
                            await outgoing.send_json(
                                {
                                    "type": "source_transcript",
                                    "segmentId": segment_id,
                                    "text": buffer,
                                    "isFinal": True,
                                    "speaker": current_speaker,
                                }
                            )
                            # Debounce: only fire a new clause-check if
                            # none is already in flight for this
                            # in-progress segment: capturing `buffer` at
                            # fire time. `buffer` is rebound (not mutated
                            # in place) on every update above, so this
                            # snapshot is never retroactively changed by a
                            # later one.
                            if clause_check_task is None:
                                clause_check_task = asyncio.create_task(
                                    segmentation_checker.is_complete_clause(
                                        buffer, current_detected_language or source_lang
                                    )
                                )
                        else:
                            preview = (
                                f"{buffer} {result.text}".strip()
                                if buffer
                                else result.text.strip()
                            )
                            await outgoing.send_json(
                                {
                                    "type": "source_transcript",
                                    "segmentId": segment_id,
                                    "text": preview,
                                    "isFinal": False,
                                    "speaker": current_speaker,
                                }
                            )

                    if result.speech_final and segmentation_mode != "llm_priority":
                        if buffer:
                            if clause_check_task is not None:
                                _park_stale(clause_check_task)
                                clause_check_task = None
                            await _cut_segment(
                                outgoing,
                                latency,
                                segment_queue,
                                segment_id,
                                buffer,
                                current_speaker,
                                current_detected_language,
                                "deepgram_speech_final",
                                segment_started_at,
                            )
                        buffer = ""
                        segment_id = _new_segment_id()
                        segment_started_at = time.perf_counter()
                        current_speaker = None
                        current_detected_language = None

                if clause_check_task is not None and clause_check_task in done:
                    task, clause_check_task = clause_check_task, None
                    try:
                        is_complete = task.result()
                    except Exception:  # noqa: BLE001, deliberately blind: a
                        # clause-check is a side channel that must never
                        # error the session no matter what it raises.
                        # Deepgram's own signals are the actual
                        # hang-prevention mechanism (see docstring), not
                        # this call succeeding.
                        is_complete = False
                    if is_complete and buffer:
                        await _cut_segment(
                            outgoing,
                            latency,
                            segment_queue,
                            segment_id,
                            buffer,
                            current_speaker,
                            current_detected_language,
                            "llm",
                            segment_started_at,
                        )
                        buffer = ""
                        segment_id = _new_segment_id()
                        segment_started_at = time.perf_counter()
                        current_speaker = None
                        current_detected_language = None
        except ProviderError as exc:
            if clause_check_task is not None:
                _park_stale(clause_check_task)
            logger.warning(
                "STT attempt %d failed (%s), dropping in-flight segment %s",
                attempt + 1,
                exc.kind.name,
                segment_id,
            )
            delays = retry_backoffs(exc)
            if attempt < len(delays):
                await asyncio.sleep(delays[attempt])
                attempt += 1
                continue
            # Retries exhausted (or none applied, e.g. an already-exhausted
            # `CONNECTION`). STT is done for the rest of the session.
            # Counts toward the same circuit breaker as any other dropped
            # segment (Ticket 7: "not a separate mechanism").
            await _send_error(outgoing, exc)
            await _record_failure_and_maybe_trip(breaker, outgoing)
            return


async def _run_pipeline(
    segment_queue: asyncio.Queue[_CompletedSegment],
    translation_provider: TranslationProvider,
    tts_provider: TTSProvider,
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
    source_lang: str,
    target_lang: str,
    breaker: _CircuitBreaker,
) -> None:
    while True:
        segment = await segment_queue.get()
        if breaker.is_open:
            # "Interpretation unavailable" is a terminal state for this
            # session (Ticket 7): stop spending calls on it, but keep
            # draining the queue so it can't grow unbounded while STT (a
            # separate task, unaware of the breaker) keeps producing.
            latency.discard(segment.segment_id)
            obs_spans.end_segment_span(segment.otel)
            continue
        succeeded = await _process_segment(
            segment, translation_provider, tts_provider, outgoing, latency, source_lang, target_lang
        )
        if succeeded:
            breaker.record_success()
        else:
            latency.discard(segment.segment_id)
            await _record_failure_and_maybe_trip(breaker, outgoing)


async def _emit_latency(
    outgoing: _OutgoingSocket, latency: _LatencyTracker, segment_id: str, stage: str
) -> None:
    ms = latency.elapsed_since_speech_end(segment_id)
    if ms is None:
        return
    await outgoing.send_json(
        {"type": "latency", "segmentId": segment_id, "stage": stage, "ms": ms}
    )
    obs_spans.add_current_span_event(stage)


async def _run_translation_with_retry(
    translation_provider: TranslationProvider,
    segment: _CompletedSegment,
    from_lang: str,
    to_lang: str,
    tts_input: "asyncio.Queue[TTSText | TTSFlush]",
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
) -> tuple[str, bool]:
    """Streams translation for `segment`, forwarding each delta immediately
    to both the client (`target_transcript` interim messages) and the
    concurrently-running TTS task (via `tts_input`): Ticket 6's low-
    latency design, unchanged on the happy path.

    On `ProviderError`: if no delta has been forwarded yet on this attempt
    (the realistic case: a rate limit/timeout/connection failure at
    request time, before the model streams anything), the attempt is
    retried per `retry_backoffs` (safe: nothing has reached the client or
    TTS yet to be duplicated). If a delta *has* already gone out this
    attempt, retrying would feed TTS a second, overlapping batch of text
    through the same still-open queue, not safe, so the segment is
    dropped without a retry in that case regardless of failure kind. A
    stream that completes without raising but yields no text at all for a
    non-empty source (distinct from STT's `is_empty`, an expected non-error
    result, see `deepgram_stt.py`) is treated as `EMPTY_RESULT`, subject
    to the same policy.

    Returns `(translated_text, success)`. On failure exhaustion, sends the
    dropped-segment `error` message and returns `("", False)`.
    """
    attempt = 0
    while True:
        translated_text = ""
        first_delta = True
        t0 = time.perf_counter()
        with obs_spans.stage_span(obs_spans.NAME_LLM, parent=segment.otel, attempt=attempt) as span:
            try:
                async for chunk in translation_provider.translate(
                    segment.text, source_lang=from_lang, target_lang=to_lang
                ):
                    if first_delta:
                        first_delta = False
                        await _emit_latency(
                            outgoing, latency, segment.segment_id, "translation_first_token"
                        )
                    translated_text += chunk
                    await outgoing.send_json(
                        {
                            "type": "target_transcript",
                            "segmentId": segment.segment_id,
                            "text": translated_text,
                            "isFinal": False,
                            "speaker": segment.speaker,
                        }
                    )
                    await tts_input.put(TTSText(chunk))
                if not translated_text:
                    raise ProviderError(
                        ProviderErrorKind.EMPTY_RESULT,
                        "translation",
                        "translation produced no output for non-empty source text",
                        retryable=True,
                    )
                await _emit_latency(outgoing, latency, segment.segment_id, "translation_complete")
                usage = getattr(translation_provider, "last_usage", None)
                obs_spans.apply_llm_generation(
                    span, source_text=segment.text, translated_text=translated_text, usage=usage
                )
                obs_metrics.record_stage_duration(
                    "translate", (time.perf_counter() - t0) * 1000
                )
                if usage is not None:
                    model = getattr(usage, "model", "gpt-4o-mini")
                    obs_metrics.record_llm_tokens(
                        "input", int(getattr(usage, "input_tokens", 0) or 0), model=model
                    )
                    obs_metrics.record_llm_tokens(
                        "output", int(getattr(usage, "output_tokens", 0) or 0), model=model
                    )
                    cost = obs_spans.llm_cost_usd(
                        model,
                        int(getattr(usage, "input_tokens", 0) or 0),
                        int(getattr(usage, "output_tokens", 0) or 0),
                    )
                    if cost is not None:
                        obs_metrics.record_llm_cost(cost, model=model)
                return translated_text, True
            except ProviderError as exc:
                obs_spans.apply_llm_generation(
                    span, source_text=segment.text, translated_text=translated_text, usage=None
                )
                obs_spans.mark_error(span, exc)
                obs_metrics.record_stage_duration(
                    "translate", (time.perf_counter() - t0) * 1000
                )
                if not first_delta:
                    logger.warning(
                        "dropping segment %s: translation failed mid-stream (%s), not retrying "
                        "(TTS already received part of this attempt's output)",
                        segment.segment_id,
                        exc.kind.name,
                    )
                    await _send_error(outgoing, exc, stage_span=span)
                    return "", False
                delays = retry_backoffs(exc)
                if attempt >= len(delays):
                    if exc.kind is ProviderErrorKind.EMPTY_RESULT:
                        logger.warning(
                            "dropping segment %s: translation empty result, retries exhausted",
                            segment.segment_id,
                        )
                    await _send_error(outgoing, exc, stage_span=span)
                    return "", False
                await asyncio.sleep(delays[attempt])
                attempt += 1


async def _run_tts_with_retry(
    tts_provider: TTSProvider,
    input_events: AsyncIterator[TTSText | TTSFlush],
    voice: str,
    segment: _CompletedSegment,
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
) -> bool:
    """Runs TTS synthesis for `segment` with per-failure-mode bounded
    retry, reusing the same `input_events` iterator across attempts.

    Safe to reuse: every `ProviderError` that can reach this layer happens
    before any audio has been produced. A `CONNECTION` drop is fully
    handled (reconnect-and-resume, or give up) inside
    `elevenlabs_tts.py` itself (see `app.providers._resilience`), so it
    only ever reaches here already exhausted, and `retry_backoffs` gives it
    0 further retries regardless. Every other kind that can reach here
    (rate limit, auth, connect timeout) is raised by that provider strictly
    at connect time, before `input_events` has been touched at all.
    """
    attempt = 0
    while True:
        first_chunk = True
        audio_bytes = 0
        t0 = time.perf_counter()
        with obs_spans.stage_span(obs_spans.NAME_TTS, parent=segment.otel, attempt=attempt) as span:
            try:
                async for audio in tts_provider.synthesize(input_events, voice=voice):
                    if first_chunk:
                        first_chunk = False
                        await _emit_latency(outgoing, latency, segment.segment_id, "tts_first_byte")
                    audio_bytes += len(audio)
                    await outgoing.send_audio(
                        segment_id=segment.segment_id,
                        sample_rate=TTS_SAMPLE_RATE,
                        audio=audio,
                        speaker=segment.speaker,
                    )
                obs_spans.apply_tts_attributes(span, voice=voice, audio_bytes=audio_bytes)
                obs_metrics.record_stage_duration("tts", (time.perf_counter() - t0) * 1000)
                return True
            except ProviderError as exc:
                obs_spans.apply_tts_attributes(span, voice=voice, audio_bytes=audio_bytes)
                obs_spans.mark_error(span, exc)
                obs_metrics.record_stage_duration("tts", (time.perf_counter() - t0) * 1000)
                delays = retry_backoffs(exc)
                if attempt >= len(delays):
                    await _send_error(outgoing, exc, stage_span=span)
                    return False
                await asyncio.sleep(delays[attempt])
                attempt += 1


async def _process_segment(
    segment: _CompletedSegment,
    translation_provider: TranslationProvider,
    tts_provider: TTSProvider,
    outgoing: _OutgoingSocket,
    latency: _LatencyTracker,
    configured_source: str,
    configured_target: str,
) -> bool:
    """Runs translate -> TTS for one segment. Returns True iff it succeeded
    end-to-end (both stages), which `_run_pipeline` uses to drive the
    circuit breaker (Ticket 7)."""
    from_lang, to_lang = _resolve_direction(
        segment.detected_language, configured_source, configured_target
    )
    voice = _voice_for_speaker(segment.speaker)
    obs_spans.set_translation_direction(segment.otel, from_lang, to_lang)

    tts_input: asyncio.Queue[TTSText | TTSFlush] = asyncio.Queue()

    async def tts_input_iter() -> AsyncIterator[TTSText | TTSFlush]:
        while True:
            event = await tts_input.get()
            yield event
            if isinstance(event, TTSFlush):
                return

    audio_task = asyncio.create_task(
        _run_tts_with_retry(tts_provider, tts_input_iter(), voice, segment, outgoing, latency)
    )

    try:
        translated_text, translation_ok = await _run_translation_with_retry(
            translation_provider, segment, from_lang, to_lang, tts_input, outgoing, latency
        )

        if translation_ok:
            await outgoing.send_json(
                {
                    "type": "target_transcript",
                    "segmentId": segment.segment_id,
                    "text": translated_text,
                    "isFinal": True,
                    "speaker": segment.speaker,
                }
            )
        # Unblocks the TTS task regardless of outcome: it's waiting on
        # `tts_input` and would hang forever without a flush, whether
        # translation produced anything or not.
        await tts_input.put(TTSFlush())
        tts_ok = await audio_task
        return translation_ok and tts_ok
    finally:
        obs_metrics.record_turn_duration(max((time.perf_counter() - segment.started_at) * 1000, 0))
        obs_spans.end_segment_span(segment.otel)


async def _send_error(
    outgoing: _OutgoingSocket, exc: ProviderError, *, stage_span: object | None = None
) -> None:
    await outgoing.send_json(
        {
            "type": "error",
            "provider": exc.provider,
            "kind": exc.kind.name,
            "message": str(exc),
            "retryable": exc.retryable,
        }
    )
    if stage_span is None:
        obs_spans.emit_provider_error_span(exc)
    obs_metrics.record_error(
        provider=exc.provider, kind=exc.kind.name, retryable=exc.retryable
    )
