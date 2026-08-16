"""Shared WAV-replay-through-`DeepgramSTTProvider` mechanics, factored out of
`tests/test_quality_wer.py` so `run_real_audio_report.py` (real, hand-recorded
speech) doesn't fork a second copy of logic that took a live debugging
session to get right. See `test_quality_wer.py`'s module docstring for the
two real bugs this replay mechanism works around.

Not a `tests/` module itself (no `test_` prefix) so pytest never collects it
directly -- it's a support library both test_quality_wer.py and
run_real_audio_report.py import.

Ticket 09 adds `transcribe_wav_detailed()`: the same replay under a
`CascadeModeTuning`, returning the WER and the two latencies
`run_tuning_sweep.py` scores a config with. `transcribe_wav()` is now a thin
wrapper over it and still returns a plain `str`, so the callers above are
untouched.

Ticket 14 adds the second WER: a config asking for `transcriptCheck.mode:
"correct"` has its finished transcript run through the same `TranscriptChecker`
the live pipeline uses, and the rewrite is scored alongside the raw transcript
(story AC 4.5). Needs an `OPENAI_API_KEY`; without one that column is left
null and everything else is measured as usual.
"""

import asyncio
import contextlib
import logging
import time
import wave
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

import jiwer

from app.config import settings
from app.providers.base import AudioChunk, TranscriptSegment
from app.providers.deepgram_stt import SAMPLE_RATE, DeepgramParams, DeepgramSTTProvider
from app.providers.denoise import build_denoise_chain
from app.providers.transcript_check import TranscriptChecker
from app.tuning.schema import CascadeModeTuning, CascadeTuning

logger = logging.getLogger(__name__)

# Mic audio is normally sent in small chunks as it's captured, not one giant
# frame -- 20ms chunks (same order of magnitude as a real capture buffer)
# give Deepgram's streaming endpoint a realistic pacing instead of one huge
# write.
_CHUNK_MS: Final = 20
_CHUNK_BYTES: Final = int(SAMPLE_RATE * (_CHUNK_MS / 1000) * 2)  # 16-bit mono PCM
_SILENCE_CHUNK: Final = b"\x00" * _CHUNK_BYTES

# How much trailing silence to append after the file's real audio, so
# Deepgram's own endpointing (500ms) sees a genuine gap and finalizes. A live
# mic keeps sending near-silent PCM during a pause, which is what lets
# endpointing fire in production; a replay that stops sending bytes entirely
# once the file ends does not get treated as silence on its own (confirmed
# live: without this, the connection sits open indefinitely and never emits
# a final result). Well past the 500ms threshold.
TRAILING_SILENCE_S: Final = 1.5

# Pure safety-net multiplier/floor on top of the audio's own duration: real
# collection stops on `speech_final=True` (see `transcribe_wav`), not on
# this timeout, so it only matters if that signal never arrives at all (a
# dropped connection, an unexpected response shape). Generous on purpose --
# confirmed live that replay's own wall-clock pacing (asyncio.sleep jitter
# across hundreds of 20ms chunks) can run noticeably slower than the audio's
# nominal duration, and a long multi-clause utterance finalizes in several
# separate is_final chunks before the one carrying speech_final=True.
_SAFETY_TIMEOUT_MULTIPLIER: Final = 2.0
_SAFETY_TIMEOUT_FLOOR_S: Final = 10.0

# Normalizes away formatting differences (punctuation, case, spacing) before
# computing WER -- Deepgram's streaming output here doesn't request
# punctuation, so comparing it verbatim against hand-punctuated reference
# text would show spurious errors that aren't real transcription mistakes.
NORMALIZE: Final = jiwer.Compose(
    [
        jiwer.ToLowerCase(),
        jiwer.RemovePunctuation(),
        jiwer.RemoveMultipleSpaces(),
        jiwer.Strip(),
        jiwer.ReduceToListOfListOfWords(),
    ]
)


class WavFormatError(Exception):
    """A WAV file isn't `DeepgramSTTProvider`'s expected mono 16-bit PCM at
    `SAMPLE_RATE` -- callers should report this with a conversion command
    (see `run_real_audio_report.py`), not attempt to resample silently."""


def audio_duration_s(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        return wav_file.getnframes() / wav_file.getframerate()


def assert_wav_format(path: Path) -> None:
    with wave.open(str(path), "rb") as wav_file:
        if (
            wav_file.getframerate() != SAMPLE_RATE
            or wav_file.getsampwidth() != 2
            or wav_file.getnchannels() != 1
        ):
            raise WavFormatError(
                f"{path}: expected mono 16-bit PCM at {SAMPLE_RATE}Hz, got "
                f"{wav_file.getnchannels()}ch {wav_file.getsampwidth() * 8}-bit "
                f"{wav_file.getframerate()}Hz"
            )


@dataclass
class ReplayResult:
    """One clip replayed under one `TuningConfig`.

    The two latencies are reported separately on purpose (story AC 2.7):
    `added_latency_ms` is time this harness spent denoising, and is the cost a
    tuning choice adds; `provider_latency_ms` is what Deepgram then took, and
    moves with knobs like `endpointingMs` rather than with the denoise chain.
    Adding them together would hide which of the two a config actually paid.
    """

    transcript: str
    #: `None` unless a `reference_text` was given -- there is nothing to
    #: score a transcript against otherwise.
    wer: float | None
    #: End of the clip's real audio -> the last final result. Includes
    #: Deepgram's own endpointing wait, which is the point: `endpointingMs`
    #: is one of the knobs the sweep compares.
    provider_latency_ms: float
    #: Wall time spent inside denoise processing (the offline pre-pass plus
    #: every live-chain `process()` call). 0.0 when nothing is enabled.
    added_latency_ms: float
    #: What actually ran, in order, including offline stages that were asked
    #: for but aren't installed -- so a report can never quietly claim a
    #: config was measured with a stage that never executed.
    stages: list[str] = field(default_factory=list)
    #: The transcript after `transcriptCheck.mode: "correct"` rewrote it, and
    #: its WER. Both stay `None` when the check didn't run at all (any other
    #: mode, or no `OPENAI_API_KEY`); a check that ran and changed nothing
    #: reports the original transcript and its own WER, because "correct mode
    #: bought nothing here" is a measurement, not a missing one.
    corrected_transcript: str | None = None
    corrected_wer: float | None = None


@dataclass
class _ReplayTiming:
    """Timestamps the replay generator collects on its way past."""

    added_ms: float = 0.0
    last_audio_at: float | None = None
    last_final_at: float | None = None

    def provider_latency_ms(self) -> float:
        if self.last_audio_at is None or self.last_final_at is None:
            return 0.0
        return max(0.0, (self.last_final_at - self.last_audio_at) * 1000)


def _cascade_tuning(
    tuning: CascadeModeTuning | Mapping[str, Any] | None,
) -> CascadeTuning | None:
    if tuning is None:
        return None
    if isinstance(tuning, CascadeModeTuning):
        return tuning.cascade
    return CascadeModeTuning.model_validate(tuning).cascade


def _denoise_chain(tuning: CascadeModeTuning | Mapping[str, Any] | None) -> list[Any]:
    """The live (per-frame) denoise stages a config asks for -- the same
    chain `orchestrator.audio_iter()` runs, so a sweep row measures what a
    session would actually pay. Empty for a config with every stage off."""
    cascade = _cascade_tuning(tuning)
    if cascade is None:
        return []
    return list(build_denoise_chain(cascade))


def _make_transcript_checker(cascade: CascadeTuning | None) -> TranscriptChecker | None:
    """The checker this config asks for, or `None` if it asks for none.

    `flag` is not a rewrite, so there is nothing for it to score -- only
    `correct` produces a second transcript. A missing `OPENAI_API_KEY`
    self-skips the column rather than failing the sweep (AGENTS.md), which is
    also what keeps this harness runnable with a Deepgram key alone.
    """
    if cascade is None or cascade.transcript_check.mode != "correct":
        return None
    if not settings.openai_api_key:
        logger.info(
            "transcriptCheck.mode=correct needs OPENAI_API_KEY -- correctedWer left null"
        )
        return None
    return TranscriptChecker(settings.openai_api_key, cascade.transcript_check.model)


def _apply_offline_stages(samples: bytes, names: Sequence[str]) -> tuple[bytes, list[str]]:
    """Seam for the benchmark-only stages (Demucs, DNS64), which run over the
    whole clip before replay rather than per frame -- that's what makes them
    offline-only, and why the live path ignores them.

    Neither is implemented (ticket 17 rules both permanently out of scope),
    so a requested stage is reported as unavailable rather than silently
    dropped -- a row can't claim a denoised measurement it never got.
    """
    attempted = []
    for name in names:
        logger.info("offline stage %s unavailable -- skipped", name)
        attempted.append(f"offline:{name} (unavailable)")
    return samples, attempted


def _make_stt_provider(
    api_key: str, tuning: CascadeModeTuning | Mapping[str, Any] | None
) -> tuple[DeepgramSTTProvider, DeepgramParams | None]:
    """The Deepgram connection one config asks for: the provider, plus the
    per-`stream()` params carrying that config's `cascade.deepgram.*` knobs
    (`model`, `endpointing`, `utteranceEndMs`, `diarize`).

    Those four are what a sweep row's fingerprint hashes, so they have to be
    what the connection actually ran under -- otherwise two rows differing
    only in `endpointingMs` report one measurement twice. Params are passed
    per call rather than held on the provider, same as the live pipeline
    (see `DeepgramParams`); `None` for an untuned replay, which opens exactly
    the URL `DeepgramSTTProvider` always did."""
    cascade = _cascade_tuning(tuning)
    params = None if cascade is None else DeepgramParams.from_tuning(cascade)
    return DeepgramSTTProvider(api_key), params


def _process(chunk: AudioChunk, chain: Sequence[Any], timing: _ReplayTiming) -> AudioChunk:
    if not chain:
        return chunk
    started = time.perf_counter()
    for stage in chain:
        chunk = stage.process(chunk)
    timing.added_ms += (time.perf_counter() - started) * 1000
    return chunk


async def _replay_chunks(
    pcm: bytes, chain: Sequence[Any], timing: _ReplayTiming
) -> AsyncIterator[AudioChunk]:
    """Yields `pcm` back in small, paced chunks -- the same shape of stream a
    live microphone produces -- followed by trailing silence so Deepgram's
    endpointing has something to detect a gap against.

    The trailing silence goes through the denoise chain too: a live session
    pays for those frames as well, and leaving them out would understate
    `addedLatencyMs` by whatever fraction of a session is pauses.
    """
    for offset in range(0, len(pcm), _CHUNK_BYTES):
        yield _process(pcm[offset : offset + _CHUNK_BYTES], chain, timing)
        await asyncio.sleep(_CHUNK_MS / 1000)
    timing.last_audio_at = time.perf_counter()
    for _ in range(int(TRAILING_SILENCE_S * 1000 / _CHUNK_MS)):
        yield _process(_SILENCE_CHUNK, chain, timing)
        await asyncio.sleep(_CHUNK_MS / 1000)


async def transcribe_wav_detailed(
    path: Path,
    source_lang: str,
    target_lang: str,
    api_key: str,
    *,
    tuning: CascadeModeTuning | Mapping[str, Any] | None = None,
    offline_stages: Sequence[str] | None = None,
    reference_text: str | None = None,
) -> ReplayResult:
    """Streams `path` (must already pass `assert_wav_format`) through the
    real `DeepgramSTTProvider` under one `TuningConfig`, and reports the
    transcript alongside what that config cost.

    A long, multi-clause utterance finalizes in several separate `is_final`
    chunks, not one -- confirmed live: Deepgram cuts at internal pauses and
    only the last chunk carries `speech_final=True`, the actual end-of-
    utterance signal. Collection stops there, not on a guessed timeout:
    racing a fixed duration against however many `is_final` chunks an
    utterance happens to produce is exactly what truncated results before
    this was fixed (the last chunk can legitimately arrive after the
    audio's own nominal duration, once replay pacing and Deepgram's own
    processing lag are both accounted for). `DeepgramSTTProvider.stream()`
    is a long-lived call for the whole session otherwise (same as
    production), so nothing else would stop it once the file's audio is
    exhausted -- the timeout below exists purely as a safety net for a
    `speech_final` that never arrives at all.
    """
    with wave.open(str(path), "rb") as wav_file:
        pcm = wav_file.readframes(wav_file.getnframes())

    # Nothing enabled has to measure as a literal 0.0, not as however long an
    # empty loop took: "zero cost when off" is a claim the report makes.
    stages: list[str] = []
    timing = _ReplayTiming()
    if offline_stages:
        started = time.perf_counter()
        pcm, stages = _apply_offline_stages(pcm, offline_stages)
        timing.added_ms = (time.perf_counter() - started) * 1000

    chain = _denoise_chain(tuning)
    stages += [stage.name for stage in chain]

    finals: list[str] = []

    async def _collect() -> None:
        provider, params = _make_stt_provider(api_key, tuning)
        stream = provider.stream(
            _replay_chunks(pcm, chain, timing),
            languages=(source_lang, target_lang),
            params=params,
        )
        async with contextlib.aclosing(stream):
            async for event in stream:
                if isinstance(event, TranscriptSegment) and event.is_final and not event.is_empty:
                    finals.append(event.text)
                    timing.last_final_at = time.perf_counter()
                    if event.speech_final:
                        break

    timeout = max(audio_duration_s(path) * _SAFETY_TIMEOUT_MULTIPLIER, _SAFETY_TIMEOUT_FLOOR_S)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(_collect(), timeout=timeout)

    transcript = " ".join(finals)
    corrected = await _corrected_transcript(transcript, source_lang, _cascade_tuning(tuning))
    return ReplayResult(
        transcript=transcript,
        wer=None if reference_text is None else word_error_rate(reference_text, transcript),
        provider_latency_ms=timing.provider_latency_ms(),
        added_latency_ms=timing.added_ms,
        stages=stages,
        corrected_transcript=corrected,
        corrected_wer=(
            None
            if corrected is None or reference_text is None
            else word_error_rate(reference_text, corrected)
        ),
    )


async def _corrected_transcript(
    transcript: str, language: str, cascade: CascadeTuning | None
) -> str | None:
    """The transcript as `transcriptCheck.mode: "correct"` would have handed
    it to the translator, or `None` if no check ran.

    Deliberately *after* the replay rather than inside it: the live pipeline
    checks each segment as it finishes, but a sweep row is scored on the whole
    clip's transcript, and that is the text the WER column compares against.
    A failed check leaves the column null -- the same "we didn't measure this"
    the no-key path reports, which is the honest answer either way."""
    checker = _make_transcript_checker(cascade)
    if checker is None or not transcript:
        return None
    result = await checker.check(transcript, language, "correct")
    if result.failed:
        logger.warning("transcript check produced no verdict -- correctedWer left null")
        return None
    return result.corrected_text or transcript


async def transcribe_wav(path: Path, source_lang: str, target_lang: str, api_key: str) -> str:
    """The untuned transcript on its own, for the callers that predate the
    tuning lab (`test_quality_wer.py`, `run_real_audio_report.py`): same
    replay, same result, no measurements to unpack."""
    result = await transcribe_wav_detailed(path, source_lang, target_lang, api_key)
    return result.transcript


def word_error_rate(reference: str, hypothesis: str) -> float:
    return jiwer.wer(reference, hypothesis, reference_transform=NORMALIZE, hypothesis_transform=NORMALIZE)
