"""Ticket 5's dedicated coverage for the LLM-hybrid segmentation race --
"the single most complex custom logic in the system" per the wayfinder.

Seam: `app.orchestrator._run_stt` directly (not the full `/ws/cascade`
route `test_orchestrator.py` drives) -- the race/debounce timing these
tests need to control precisely is far easier to get right against
`_run_stt`'s own inputs (a fake STT provider, a fake
`SegmentationChecker`-shaped clause-checker, a recording `_OutgoingSocket`
double) than through a synchronous `TestClient` WebSocket, and `_run_stt`
is exactly the function the ticket calls out as needing dedicated tests.
The wiring from `start_session.segmentationMode` through to `_run_stt`'s
`segmentation_mode` parameter, and `segment_boundary`'s trigger values
reaching the wire, are ordinary orchestrator wiring already covered by the
`_parse_segmentation_mode`/`_start_new_session` code path and (indirectly)
by `test_orchestrator.py`'s full-pipeline tests.

Every test here drives real `asyncio` concurrency (no mocked event loop),
synchronized deterministically via `asyncio.Event`/`asyncio.Queue` rather
than real-time sleeps or scheduler-order assumptions, so none of it is
flaky: a fake clause-checker only resolves once a test explicitly releases
it, and `_next_message` lets a test wait for a specific message to land on
the wire before proceeding, rather than guessing how many event-loop turns
`_run_stt` needs.
"""

import asyncio
import contextlib

import pytest

from app import orchestrator
from app.providers.base import TranscriptSegment, UtteranceEndSignal
from app.tuning.defaults import default_cascade_tuning
from app.tuning.schema import ClientTuning

# ---------------------------------------------------------------------------
# Shared test doubles
# ---------------------------------------------------------------------------


class _RecordingOutgoing:
    """`_OutgoingSocket`-shaped double: records every `send_json` call in
    order (`sent`) and also queues it (`queue`) so a test can `await` the
    next message of a given type deterministically instead of racing real
    time against `_run_stt`'s internal race."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.queue: asyncio.Queue[dict] = asyncio.Queue()

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)
        self.queue.put_nowait(payload)


async def _next_message(outgoing: _RecordingOutgoing, message_type: str) -> dict:
    """Awaits messages off `outgoing.queue` until one of `message_type`
    arrives -- deterministic synchronization for the race tests below."""
    while True:
        message = await asyncio.wait_for(outgoing.queue.get(), timeout=1)
        if message["type"] == message_type:
            return message


def _start_run_stt(stt_provider, segmentation_checker, *, mode: str = "hybrid"):
    """Runs `orchestrator._run_stt` as a background task over fresh,
    real (not faked) `_LatencyTracker`/`_CircuitBreaker`/`_SessionTuning`
    instances -- all three are simple, side-effect-free bookkeeping already
    covered by `test_orchestrator.py`, not what these tests are about. The
    segmentation mode reaches `_run_stt` through the session's tuning
    (Ticket 6), which is why `mode` is applied to a default config here.
    Returns the task plus the two things a test asserts against."""
    outgoing = _RecordingOutgoing()
    segment_queue: asyncio.Queue = asyncio.Queue()
    cascade = default_cascade_tuning()
    cascade = cascade.model_copy(
        update={"segmentation": cascade.segmentation.model_copy(update={"mode": mode})}
    )
    task = asyncio.create_task(
        orchestrator._run_stt(
            stt_provider,
            asyncio.Queue(),  # audio_queue -- unused by every fake STT below
            segment_queue,
            outgoing,
            orchestrator._LatencyTracker(),
            "en",
            "es",
            orchestrator._CircuitBreaker(),
            segmentation_checker,
            orchestrator._SessionTuning(cascade, ClientTuning()),
        )
    )
    return task, outgoing, segment_queue


class _NeverResolvingChecker:
    """A clause-check that never completes until a test releases it --
    proves Deepgram's own boundary signals are what actually prevent a
    hang, not this call succeeding."""

    def __init__(self) -> None:
        self.calls = 0
        self._gate = asyncio.Event()

    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del text, language
        self.calls += 1
        await self._gate.wait()
        return True

    def release(self) -> None:
        self._gate.set()


class _RaisingChecker:
    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del text, language
        raise RuntimeError("clause-check exploded")


class _FastTrueChecker:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del language
        self.calls.append(text)
        return True


class _GatedTrueChecker:
    """Resolves `True`, but only once a test releases it -- for proving
    the segment cut uses whatever `buffer` holds *then*, not the snapshot
    passed in at fire time."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self._gate = asyncio.Event()

    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del language
        self.calls.append(text)
        await self._gate.wait()
        return True

    def release(self) -> None:
        self._gate.set()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSegmentationRace:
    @pytest.mark.asyncio
    async def test_speech_final_cuts_even_though_clause_check_never_resolves(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello world", is_final=True, speech_final=False)
                # No new words, just the endpoint marker -- realistic for
                # Deepgram, and keeps `buffer` at exactly "hello world"
                # rather than double-accumulating.
                yield TranscriptSegment(text="", is_final=True, speech_final=True)

        checker = _NeverResolvingChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker)

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)
        assert completed.text == "hello world"
        boundary = next(m for m in outgoing.sent if m["type"] == "segment_boundary")
        assert boundary["trigger"] == "deepgram_speech_final"

        # `_run_stt` itself never waited on the checker to reach this point
        # -- proves capture/segmentation isn't gated on the LLM call.
        await asyncio.wait_for(task, timeout=1)
        assert checker.calls == 1  # a check really was in flight, just never resolved

        checker.release()
        await asyncio.sleep(0)  # let the now-stale task's done-callback run

    @pytest.mark.asyncio
    async def test_utterance_end_cuts_even_though_clause_check_never_resolves(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello world", is_final=True, speech_final=False)
                yield UtteranceEndSignal()

        checker = _NeverResolvingChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker)

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)
        assert completed.text == "hello world"
        boundary = next(m for m in outgoing.sent if m["type"] == "segment_boundary")
        assert boundary["trigger"] == "deepgram_utterance_end"

        await asyncio.wait_for(task, timeout=1)
        checker.release()
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_erroring_clause_check_does_not_crash_session_and_deepgram_still_cuts(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello world", is_final=True, speech_final=False)
                yield TranscriptSegment(text="", is_final=True, speech_final=True)

        task, outgoing, segment_queue = _start_run_stt(_STT(), _RaisingChecker())

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)
        assert completed.text == "hello world"
        boundary = next(m for m in outgoing.sent if m["type"] == "segment_boundary")
        assert boundary["trigger"] == "deepgram_speech_final"

        await asyncio.wait_for(task, timeout=1)  # no exception propagated out of _run_stt

    @pytest.mark.asyncio
    async def test_llm_verdict_wins_the_race_and_cuts_via_llm_trigger(self):
        release_event = asyncio.Event()

        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello world", is_final=True, speech_final=False)
                await release_event.wait()
                # A stale boundary signal arriving after the segment was
                # already cut by the LLM verdict below -- empty text, so it
                # finds nothing to cut (see the `is_empty` guard).
                yield TranscriptSegment(text="", is_final=True, speech_final=True)

        checker = _FastTrueChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker)

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)
        assert completed.text == "hello world"
        boundary = next(m for m in outgoing.sent if m["type"] == "segment_boundary")
        assert boundary["trigger"] == "llm"
        assert checker.calls == ["hello world"]

        release_event.set()
        await asyncio.wait_for(task, timeout=1)
        assert segment_queue.empty()  # the stale speech_final cut nothing

    @pytest.mark.asyncio
    async def test_cut_uses_latest_buffer_not_the_snapshot_the_clause_check_evaluated(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello", is_final=True, speech_final=False)
                yield TranscriptSegment(
                    text="world, how are you", is_final=True, speech_final=False
                )
                await asyncio.Event().wait()  # stall -- no 3rd item needed for this test

        checker = _GatedTrueChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker)

        # Wait for both `source_transcript` updates -- proves the second
        # chunk has already extended `buffer` inside `_run_stt` -- before
        # letting the still in-flight check resolve, so its `True` verdict
        # races against already-updated state, not the snapshot it
        # evaluated at fire time.
        await _next_message(outgoing, "source_transcript")
        await _next_message(outgoing, "source_transcript")
        checker.release()

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)

        assert checker.calls == ["hello"]  # evaluated only the stale snapshot
        assert completed.text == "hello world, how are you"  # cut used the latest buffer

        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_llm_priority_mode_ignores_speech_final_but_still_cuts_on_utterance_end(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="hello world", is_final=True, speech_final=False)
                # Carries real text and speech_final=True -- in llm_priority
                # mode this must grow `buffer` (ordinary is_final handling)
                # but never cut or reset anything.
                yield TranscriptSegment(text="today", is_final=True, speech_final=True)
                yield UtteranceEndSignal()

        checker = _NeverResolvingChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker, mode="llm_priority")

        completed = await asyncio.wait_for(segment_queue.get(), timeout=1)
        assert completed.text == "hello world today"  # speech_final never cut/reset it
        boundary = next(m for m in outgoing.sent if m["type"] == "segment_boundary")
        assert boundary["trigger"] == "deepgram_utterance_end"

        await asyncio.wait_for(task, timeout=1)
        checker.release()
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_debounce_does_not_fire_a_second_clause_check_while_one_is_in_flight(self):
        class _STT:
            async def stream(self, audio_chunks, *, languages, params=None):
                del audio_chunks, languages
                yield TranscriptSegment(text="one", is_final=True, speech_final=False)
                yield TranscriptSegment(text="two", is_final=True, speech_final=False)
                yield TranscriptSegment(text="three", is_final=True, speech_final=False)
                await asyncio.Event().wait()  # stall -- no boundary needed for this test

        checker = _NeverResolvingChecker()
        task, outgoing, segment_queue = _start_run_stt(_STT(), checker)
        del segment_queue

        # All three `is_final` chunks processed -- each had the chance to
        # fire a debounced check -- before asserting only one actually did.
        for _ in range(3):
            await _next_message(outgoing, "source_transcript")
        assert checker.calls == 1

        checker.release()
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
