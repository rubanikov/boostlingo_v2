"""Ticket 8's process-memory sampling harness: drives `app.orchestrator`'s
real `_run_stt`/`_run_pipeline` pair (the same two concurrent tasks
`_start_new_session` wires up for a real `/ws/cascade` session) directly,
in-process -- no real WebSocket, no real network, no live provider keys --
over a simulated long session (many segments back-to-back), sampling
`psutil.Process().memory_info().rss` before and periodically during, and
asserting the process doesn't grow unbounded.

Unlike every other quality-suite test in this ticket, this one needs no live
provider key and runs for real here: the fake STT/Translation/TTS providers
below are the same shape already established in `test_orchestrator.py`/
`test_resilience.py`/`test_segmentation.py` (a fake per `Protocol`, ignoring
whatever it doesn't need), reused rather than reinvented.

Seam: `orchestrator._run_stt` + `orchestrator._run_pipeline` directly (same
seam `test_segmentation.py` uses), not the full `/ws/cascade` route -- a long
run over a real `TestClient` WebSocket would spend most of its time on
per-message JSON/thread-portal overhead rather than exercising the
orchestrator's own per-segment bookkeeping (`_LatencyTracker`'s dict,
`_run_stt`'s `stale_tasks` set), which is what a leak would actually show up
in. `SEGMENT_COUNT` simulated segments stands in for "a 5-minute run" (the
brief's stability benchmark) without an actual 5-minute wall-clock wait --
this environment can't run a live 5-minute session with real providers
anyway, and the fake providers here have no real-time pacing to simulate in
the first place.
"""

import asyncio
import contextlib
import gc
from typing import Final

import psutil
import pytest

from app import orchestrator
from app.providers.base import TranscriptSegment, TTSFlush

# Large enough to make a genuine per-segment leak (an ever-growing dict/set/
# task backlog) visible, small enough to keep this test fast -- every stage
# here is an in-memory fake with no real I/O or sleep on the hot path.
SEGMENT_COUNT: Final = 2000
SAMPLE_EVERY: Final = 200

# Generous on purpose -- a leak-regression smoke test, not a precise
# benchmark (per the ticket). Normal per-segment object churn (dataclasses,
# dict entries, asyncio Tasks that get garbage-collected right after) over a
# few thousand segments is ordinarily single-digit MB; an actual unbounded
# leak in the orchestrator's per-segment bookkeeping would instead scale
# with SEGMENT_COUNT and blow well past this.
MAX_GROWTH_MB: Final = 50


class _ProgressTracker:
    """Fires `on_sample(count)` every `sample_every` completed segments and
    sets `done` once `expected` are complete -- the test's synchronization
    point for "the whole simulated session has finished," since TTS
    synthesis is the last async stage `orchestrator._process_segment` runs
    per segment before `_run_pipeline` loops back for the next one.
    """

    def __init__(self, expected: int, *, sample_every: int, on_sample) -> None:
        self._expected = expected
        self._sample_every = sample_every
        self._on_sample = on_sample
        self._count = 0
        self.done = asyncio.Event()

    def mark_segment_complete(self) -> None:
        self._count += 1
        if self._count % self._sample_every == 0:
            self._on_sample(self._count)
        if self._count >= self._expected:
            self.done.set()


class _FakeManySegmentsSTT:
    """Yields `count` back-to-back final+speech_final segments, ignoring
    `audio_chunks` entirely -- same shape as `test_orchestrator.py`'s
    `_FakeSTT`, just looping instead of a fixed two-segment script. Each
    segment carries both `is_final` and `speech_final` in the same event
    (matching `test_resilience.py`'s `_FakeOneSegmentPerAudioChunkSTT`), so
    every segment also exercises the segmentation race's stale-task cleanup
    (`_run_stt`'s `clause_check_task` is parked and discarded the instant
    `speech_final` cuts the segment first) -- exactly the kind of per-segment
    task churn this harness needs to prove doesn't leak.
    """

    def __init__(self, count: int) -> None:
        self._count = count

    async def stream(self, audio_chunks, *, languages):
        del audio_chunks, languages
        for i in range(self._count):
            yield TranscriptSegment(text=f"segment {i}", is_final=True, speech_final=True)
            await asyncio.sleep(0)  # let the pipeline task keep pace, same event loop


class _AlwaysFalseChecker:
    """A clause-check that's never in the running -- these segments are
    always cut by `speech_final` instead, same as most of `test_resilience.py`'s
    fakes."""

    async def is_complete_clause(self, text: str, language: str) -> bool:
        del text, language
        return False


class _FakeTranslation:
    async def translate(self, source_text, *, source_lang, target_lang):
        del source_lang, target_lang
        yield source_text.upper()


class _FakeTTS:
    def __init__(self, tracker: _ProgressTracker) -> None:
        self._tracker = tracker

    async def synthesize(self, input_events, *, voice):
        del voice
        async for event in input_events:
            if isinstance(event, TTSFlush):
                yield b"\x00"
                self._tracker.mark_segment_complete()
                return


class _CountingOutgoing:
    """`_OutgoingSocket`-shaped double that only counts sends instead of
    retaining every message -- retaining thousands of transcript/latency
    payloads for a long simulated session would grow this test double's own
    memory and swamp whatever signal the orchestrator itself produces, which
    isn't what this test is measuring."""

    def __init__(self) -> None:
        self.sent_count = 0

    async def send_json(self, payload: dict) -> None:
        del payload
        self.sent_count += 1

    async def send_audio(self, *, segment_id, sample_rate, audio, speaker) -> None:
        del segment_id, sample_rate, audio, speaker
        self.sent_count += 1


async def _run_simulated_session(segment_count: int, tracker: _ProgressTracker) -> _CountingOutgoing:
    outgoing = _CountingOutgoing()
    latency = orchestrator._LatencyTracker()
    breaker = orchestrator._CircuitBreaker()
    segment_queue: asyncio.Queue = asyncio.Queue()

    stt_task = asyncio.create_task(
        orchestrator._run_stt(
            _FakeManySegmentsSTT(segment_count),
            asyncio.Queue(),  # audio_queue -- unused, the fake STT ignores it
            segment_queue,
            outgoing,
            latency,
            "en",
            "es",
            breaker,
            _AlwaysFalseChecker(),
            "hybrid",
        )
    )
    pipeline_task = asyncio.create_task(
        orchestrator._run_pipeline(
            segment_queue, _FakeTranslation(), _FakeTTS(tracker), outgoing, latency, "en", "es", breaker
        )
    )

    await asyncio.wait_for(stt_task, timeout=30)
    await asyncio.wait_for(tracker.done.wait(), timeout=30)

    pipeline_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await pipeline_task

    return outgoing


class TestMemoryStability:
    @pytest.mark.asyncio
    async def test_memory_does_not_grow_unbounded_across_a_simulated_long_session(self):
        process = psutil.Process()
        gc.collect()
        baseline_rss = process.memory_info().rss

        samples: list[int] = []

        def _on_sample(_completed: int) -> None:
            gc.collect()
            samples.append(process.memory_info().rss)

        tracker = _ProgressTracker(SEGMENT_COUNT, sample_every=SAMPLE_EVERY, on_sample=_on_sample)
        outgoing = await _run_simulated_session(SEGMENT_COUNT, tracker)

        gc.collect()
        final_rss = process.memory_info().rss

        # Sanity: the simulated session actually ran to completion (every
        # segment reached TTS) rather than this test vacuously passing on a
        # session that hung or dropped segments early.
        assert outgoing.sent_count > 0
        assert len(samples) == SEGMENT_COUNT // SAMPLE_EVERY

        growth_mb = (final_rss - baseline_rss) / (1024 * 1024)
        assert growth_mb < MAX_GROWTH_MB, (
            f"RSS grew {growth_mb:.1f}MB over {SEGMENT_COUNT} simulated segments "
            f"(baseline {baseline_rss / 1024 / 1024:.1f}MB -> final "
            f"{final_rss / 1024 / 1024:.1f}MB) -- possible memory leak in the "
            "orchestrator's per-segment bookkeeping."
        )
