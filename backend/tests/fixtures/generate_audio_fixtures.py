"""One-time/on-demand generator for `tests/fixtures/audio/{item_id}.wav`
(Ticket 8): synthesizes every `interpreter_dataset.json` item's source
`text` via the real `ElevenLabsTTSProvider` (reused directly, not
reimplemented) and writes it to a proper `.wav` container -- Playwright's
fake-mic flag (`--use-file-for-fake-audio-capture`) needs a real audio
file, not a raw PCM blob, and the WER regression test
(`test_quality_wer.py`) replays these same files back into
`DeepgramSTTProvider`.

`ElevenLabsTTSProvider.synthesize` yields raw PCM16 mono at
`elevenlabs_tts.SAMPLE_RATE` (16kHz) -- written here via the `wave` stdlib
module, no format conversion needed since that already matches
`DeepgramSTTProvider`'s expected input format.

A standalone script, not a pytest test -- run on demand from `backend/`:

    uv run python tests/fixtures/generate_audio_fixtures.py

Requires a live `ELEVENLABS_API_KEY` (this makes real TTS calls); refuses
to run without one rather than failing confusingly partway through.
Idempotent: an item whose `.wav` already exists is skipped, so a partial
run (or a dataset item added later) can be safely re-run.
"""

import asyncio
import json
import wave
from pathlib import Path

from app.config import settings
from app.providers.base import TTSFlush, TTSText
from app.providers.elevenlabs_tts import SAMPLE_RATE, ElevenLabsTTSProvider

FIXTURES_DIR = Path(__file__).parent
DATASET_PATH = FIXTURES_DIR / "interpreter_dataset.json"
AUDIO_DIR = FIXTURES_DIR / "audio"


def _load_items() -> list[dict]:
    return json.loads(DATASET_PATH.read_text(encoding="utf-8"))["items"]


async def _synthesize(provider: ElevenLabsTTSProvider, text: str) -> bytes:
    async def _input_events():
        yield TTSText(text)
        yield TTSFlush()

    chunks = [
        chunk
        async for chunk in provider.synthesize(_input_events(), voice=settings.elevenlabs_voice_id)
    ]
    return b"".join(chunks)


def _write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # PCM16
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm)


async def main() -> None:
    if not settings.elevenlabs_api_key:
        raise SystemExit(
            "ELEVENLABS_API_KEY is not set -- this script makes real TTS calls and "
            "can't run without one. Set it in backend/.env (or the environment) and "
            "re-run: uv run python tests/fixtures/generate_audio_fixtures.py"
        )

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    items = _load_items()
    provider = ElevenLabsTTSProvider(settings.elevenlabs_api_key, settings.elevenlabs_voice_id)

    generated = 0
    skipped = 0
    for item in items:
        out_path = AUDIO_DIR / f"{item['id']}.wav"
        if out_path.exists():
            print(f"skip  {item['id']} (already exists)")
            skipped += 1
            continue
        print(f"synth {item['id']} ({item['sourceLang']}): {item['text'][:60]!r}...")
        pcm = await _synthesize(provider, item["text"])
        _write_wav(out_path, pcm)
        generated += 1

    print(f"done -- {generated} generated, {skipped} already present, {len(items)} total")


if __name__ == "__main__":
    asyncio.run(main())
