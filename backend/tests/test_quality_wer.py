"""Ticket 8's WER regression test: replays each dataset item's TTS-generated
audio fixture (`tests/fixtures/audio/{id}.wav`, see
`fixtures/generate_audio_fixtures.py`) through the real `DeepgramSTTProvider`
and asserts the resulting transcript is close to the item's known source
`text`, via `jiwer.wer` (edit-distance alignment).

Needs two things this environment doesn't have: a live `DEEPGRAM_API_KEY`
(gated by the module-level `skipif` below) and the audio fixtures themselves
(gated per-item -- see `_transcribe_item`'s skip). Both gates exist so this
test does something meaningful in a real CI/dev environment with keys and
fixtures present, rather than simply failing here. See this repo's Ticket 8
summary for the exact commands to run this for real.

Threshold: `WER_THRESHOLD = 0.20` (20%). Reasoning: this corpus is clean,
single-speaker, TTS-generated audio (no room noise, no accent variation) fed
into a modern streaming STT model (Deepgram nova-3) -- published WER figures
for that combination are typically single digits to low teens. 20% leaves
real headroom above that for streaming-specific effects this corpus doesn't
control for (interim-result churn, endpointing cutting a word early,
Spanish's higher baseline STT error rates than English) while still catching
a genuine regression. This is a starting point to tune once real numbers
exist from a live run, not a number backed by an actual measurement in this
environment -- flagged again in the module docstring above.
"""

import asyncio
import contextlib
import json
import wave
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Final

import jiwer
import pytest

from app.config import settings
from app.providers.base import TranscriptSegment
from app.providers.deepgram_stt import SAMPLE_RATE, DeepgramSTTProvider

pytestmark = pytest.mark.skipif(
    not settings.deepgram_api_key,
    reason=(
        "requires a live DEEPGRAM_API_KEY -- see this module's docstring for how to "
        "run it for real"
    ),
)

FIXTURES_DIR: Final = Path(__file__).parent / "fixtures"
DATASET_PATH: Final = FIXTURES_DIR / "interpreter_dataset.json"
AUDIO_DIR: Final = FIXTURES_DIR / "audio"

WER_THRESHOLD: Final = 0.20

# Mic audio is normally sent in small chunks as it's captured, not one giant
# frame -- 20ms chunks (same order of magnitude as a real capture buffer)
# give Deepgram's streaming endpoint a realistic pacing instead of one huge
# write.
_CHUNK_MS: Final = 20
_CHUNK_BYTES: Final = int(SAMPLE_RATE * (_CHUNK_MS / 1000) * 2)  # 16-bit mono PCM

# How much longer than the audio's own duration to keep listening for
# Deepgram to flush a final result after the last chunk (endpointing needs a
# silence gap to fire) before giving up -- see `_transcribe_item`'s docstring
# for why this bound exists at all.
_FINALIZE_BUFFER_S: Final = 5.0

# Normalizes away formatting differences between the hand-written dataset
# text (punctuated, capitalized) and Deepgram's streaming output (this
# provider doesn't request punctuation) before computing WER -- otherwise
# every item would show a spurious error for e.g. a dropped "?" that isn't a
# real transcription mistake.
_NORMALIZE: Final = jiwer.Compose(
    [
        jiwer.ToLowerCase(),
        jiwer.RemovePunctuation(),
        jiwer.RemoveMultipleSpaces(),
        jiwer.Strip(),
        jiwer.ReduceToListOfListOfWords(),
    ]
)


def _load_items() -> list[dict]:
    return json.loads(DATASET_PATH.read_text(encoding="utf-8"))["items"]


def _audio_path(item_id: str) -> Path:
    return AUDIO_DIR / f"{item_id}.wav"


def _audio_duration_s(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        return wav_file.getnframes() / wav_file.getframerate()


async def _replay_audio_chunks(path: Path) -> AsyncIterator[bytes]:
    """Reads `path` (mono 16-bit PCM WAV at `SAMPLE_RATE`, matching
    `DeepgramSTTProvider`'s expected input -- also `ElevenLabsTTSProvider`'s
    own output format, so the fixture generator needed no resampling) and
    yields it back in small, paced chunks -- the same shape of stream a live
    microphone produces.
    """
    with wave.open(str(path), "rb") as wav_file:
        assert wav_file.getframerate() == SAMPLE_RATE
        assert wav_file.getsampwidth() == 2
        assert wav_file.getnchannels() == 1
        pcm = wav_file.readframes(wav_file.getnframes())
    for offset in range(0, len(pcm), _CHUNK_BYTES):
        yield pcm[offset : offset + _CHUNK_BYTES]
        await asyncio.sleep(_CHUNK_MS / 1000)


async def _transcribe_item(path: Path, source_lang: str, target_lang: str) -> str:
    """Streams `path` through the real `DeepgramSTTProvider` and joins every
    non-empty final segment's text into one hypothesis transcript.

    `DeepgramSTTProvider.stream()` is a long-lived call for the whole
    session (same as production -- `app.orchestrator` only ends it on an
    explicit teardown, never on the audio iterator running dry), so nothing
    naturally stops it once this fixture's audio is exhausted. Bounded here
    by the audio's own duration plus `_FINALIZE_BUFFER_S` instead, generous
    enough for Deepgram's endpointing gap to fire and flush the last final
    result; whatever was collected by then is the hypothesis.
    """
    finals: list[str] = []

    async def _collect() -> None:
        provider = DeepgramSTTProvider(settings.deepgram_api_key)
        async for event in provider.stream(
            _replay_audio_chunks(path), languages=(source_lang, target_lang)
        ):
            if isinstance(event, TranscriptSegment) and event.is_final and not event.is_empty:
                finals.append(event.text)

    timeout = _audio_duration_s(path) + _FINALIZE_BUFFER_S
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(_collect(), timeout=timeout)

    return " ".join(finals)


@pytest.mark.asyncio
@pytest.mark.parametrize("item", _load_items(), ids=lambda item: item["id"])
async def test_transcription_wer_below_threshold(item: dict) -> None:
    audio_path = _audio_path(item["id"])
    if not audio_path.exists():
        pytest.skip(
            f"no audio fixture at {audio_path} -- run "
            "`uv run python tests/fixtures/generate_audio_fixtures.py` with a live "
            "ELEVENLABS_API_KEY first"
        )

    other_lang = "es" if item["sourceLang"] == "en" else "en"
    hypothesis = await _transcribe_item(audio_path, item["sourceLang"], other_lang)

    error_rate = jiwer.wer(
        item["text"],
        hypothesis,
        reference_transform=_NORMALIZE,
        hypothesis_transform=_NORMALIZE,
    )
    assert error_rate < WER_THRESHOLD, (
        f"WER {error_rate:.1%} exceeds the {WER_THRESHOLD:.0%} threshold for "
        f"{item['id']!r}: reference={item['text']!r} hypothesis={hypothesis!r}"
    )
