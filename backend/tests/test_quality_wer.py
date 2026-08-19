"""Ticket 8's WER regression test: replays each dataset item's TTS-generated
audio fixture (`tests/fixtures/audio/{id}.wav`, see
`fixtures/generate_audio_fixtures.py`) through the real `DeepgramSTTProvider`
and asserts the resulting transcript is close to the item's known source
`text`, via `jiwer.wer` (edit-distance alignment). Replay mechanics live in
`fixtures/stt_replay.py`, shared with `fixtures/run_real_audio_report.py`
(real, hand-recorded speech instead of this module's TTS-generated corpus).

Needs two things this environment doesn't have: a live `DEEPGRAM_API_KEY`
(gated by the module-level `skipif` below) and the audio fixtures themselves
(gated per-item -- see `test_transcription_wer_below_threshold`'s skip). Both
gates exist so this test does something meaningful in a real CI/dev
environment with keys and fixtures present, rather than simply failing here.
See this repo's Ticket 8 summary for the exact commands to run this for real.

Threshold: `WER_THRESHOLD = 0.20` (20%). Reasoning: this corpus is clean,
single-speaker, TTS-generated audio (no room noise, no accent variation) fed
into a modern streaming STT model (Deepgram nova-3) -- published WER figures
for that combination are typically single digits to low teens. 20% leaves
real headroom above that for streaming-specific effects this corpus doesn't
control for (interim-result churn, endpointing cutting a word early,
Spanish's higher baseline STT error rates than English) while still catching
a genuine regression.

Confirmed against a live run: all 33 items pass at this threshold once two
real bugs (both explained in `stt_replay.py`, not here) were found and fixed
-- Deepgram never finalizing an utterance when the replay simply stops
sending bytes instead of continuing with silence, and a fixed overall
timeout racing against (and sometimes losing to) a long sentence's several
separate `is_final` chunks. Two individual audio fixtures also turned out to
be one-off bad ElevenLabs synthesis runs (confirmed by regenerating them and
getting a clean pass); an occasional bad TTS render, not a code bug, is an
accepted risk of a TTS-generated corpus -- if a specific item starts failing
consistently, regenerating that one fixture is the first thing to try before
assuming a regression.
"""

import json
from pathlib import Path
from typing import Final

import pytest

from app.config import settings
from tests.fixtures.stt_replay import transcribe_wav, word_error_rate

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


def _load_items() -> list[dict]:
    return json.loads(DATASET_PATH.read_text(encoding="utf-8"))["items"]


def _audio_path(item_id: str) -> Path:
    return AUDIO_DIR / f"{item_id}.wav"


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
    hypothesis = await transcribe_wav(
        audio_path, item["sourceLang"], other_lang, settings.deepgram_api_key
    )

    error_rate = word_error_rate(item["text"], hypothesis)
    assert error_rate < WER_THRESHOLD, (
        f"WER {error_rate:.1%} exceeds the {WER_THRESHOLD:.0%} threshold for "
        f"{item['id']!r}: reference={item['text']!r} hypothesis={hypothesis!r}"
    )
