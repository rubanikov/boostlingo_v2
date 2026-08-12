"""Shared WAV-replay-through-`DeepgramSTTProvider` mechanics, factored out of
`tests/test_quality_wer.py` so `run_real_audio_report.py` (real, hand-recorded
speech) doesn't fork a second copy of logic that took a live debugging
session to get right. See `test_quality_wer.py`'s module docstring for the
two real bugs this replay mechanism works around.

Not a `tests/` module itself (no `test_` prefix) so pytest never collects it
directly -- it's a support library both test_quality_wer.py and
run_real_audio_report.py import.
"""

import asyncio
import contextlib
import wave
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Final

import jiwer

from app.providers.base import TranscriptSegment
from app.providers.deepgram_stt import SAMPLE_RATE, DeepgramSTTProvider

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
_TRAILING_SILENCE_S: Final = 1.5

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


async def _replay_wav_chunks(path: Path) -> AsyncIterator[bytes]:
    """Yields `path`'s PCM back in small, paced chunks -- the same shape of
    stream a live microphone produces -- followed by trailing silence so
    Deepgram's endpointing has something to detect a gap against."""
    with wave.open(str(path), "rb") as wav_file:
        pcm = wav_file.readframes(wav_file.getnframes())
    for offset in range(0, len(pcm), _CHUNK_BYTES):
        yield pcm[offset : offset + _CHUNK_BYTES]
        await asyncio.sleep(_CHUNK_MS / 1000)
    for _ in range(int(_TRAILING_SILENCE_S * 1000 / _CHUNK_MS)):
        yield _SILENCE_CHUNK
        await asyncio.sleep(_CHUNK_MS / 1000)


async def transcribe_wav(path: Path, source_lang: str, target_lang: str, api_key: str) -> str:
    """Streams `path` (must already pass `assert_wav_format`) through the
    real `DeepgramSTTProvider` and joins every non-empty final segment's
    text into one hypothesis transcript.

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
    finals: list[str] = []

    async def _collect() -> None:
        provider = DeepgramSTTProvider(api_key)
        stream = provider.stream(_replay_wav_chunks(path), languages=(source_lang, target_lang))
        async with contextlib.aclosing(stream):
            async for event in stream:
                if isinstance(event, TranscriptSegment) and event.is_final and not event.is_empty:
                    finals.append(event.text)
                    if event.speech_final:
                        break

    timeout = max(audio_duration_s(path) * _SAFETY_TIMEOUT_MULTIPLIER, _SAFETY_TIMEOUT_FLOOR_S)
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(_collect(), timeout=timeout)

    return " ".join(finals)


def word_error_rate(reference: str, hypothesis: str) -> float:
    return jiwer.wer(reference, hypothesis, reference_transform=NORMALIZE, hypothesis_transform=NORMALIZE)
