"""The "real voices instead of synthetic" quality report: exercises the same
STT -> translation -> LLM-judge pipeline as `run_quality_report.py`
(Ticket 9) / `test_quality_wer.py` (Ticket 8), but against hand-recorded
human speech instead of ElevenLabs-synthesized audio.

Ticket 8's own scope named this explicitly and deferred it: "a handful of
real (non-TTS) audio recordings across varied conditions (quiet, some
noise, near/far mic) through the same harness" -- "manual-tier, not
blocking automated CI." This script is that harness; the recordings
themselves have to come from an actual person; there's no synthetic
stand-in for "real" here.

Unlike `test_quality_wer.py` (which grades transcription against a clean,
already-known-correct source string), this script deliberately translates
whatever Deepgram actually transcribed, not the hand-written reference --
that's the point of testing with real speech: it exercises the full
STT -> translation chain the way a live session would, including
compounding errors, not just each stage in isolation.

## Adding a recording

**Easiest path**: open `tests/fixtures/real_audio/recorder.html` directly in
a browser (Chrome/Edge -- it uses the File System Access API to save
straight into place, degrading to plain downloads elsewhere). Pick a
prompt, record, listen back, save -- it writes an already-correctly-
formatted `.wav` and appends the manifest entry itself, no `ffmpeg` step.

**Manual path**, if you'd rather record with something else (a phone voice
memo, an existing recording, etc.):

1. Record yourself (or someone else) speaking a short EN or ES sentence.
   Note down varied conditions on purpose -- quiet vs. some background
   noise, laptop mic vs. headset, close vs. across-the-room -- since that's
   the whole reason this harness exists instead of just using more TTS.
2. Convert it to mono 16-bit PCM WAV at 16000Hz (Deepgram's/this app's
   expected input format) if it isn't already. From almost any source
   format:

       ffmpeg -i your-recording.m4a -ar 16000 -ac 1 -sample_fmt s16 tests/fixtures/real_audio/my-recording-01.wav

3. Add an entry to `tests/fixtures/real_audio/manifest.json` (create it from
   `manifest.example.json` if it doesn't exist yet):

       {
         "id": "my-recording-01",
         "audioFile": "my-recording-01.wav",
         "sourceLang": "en",
         "targetLang": "es",
         "referenceText": "Exactly what you actually said, transcribed by hand.",
         "conditions": "quiet room, laptop mic, ~30cm"
       }

4. Run this script (needs live `DEEPGRAM_API_KEY` and `OPENAI_API_KEY`):

       uv run python tests/fixtures/run_real_audio_report.py

Output: per-item WER + translation-quality lines on stdout, plus the full
report as JSON at `tests/fixtures/real_audio_report.json`.
"""

import asyncio
import json
from pathlib import Path

from openai import AsyncOpenAI

from app.config import settings
from app.providers.openai_translation import OpenAITranslationProvider
from app.quality.llm_judge import judge_translation
from tests.fixtures.stt_replay import (
    WavFormatError,
    assert_wav_format,
    transcribe_wav,
    word_error_rate,
)

REAL_AUDIO_DIR = Path(__file__).parent / "real_audio"
MANIFEST_PATH = REAL_AUDIO_DIR / "manifest.json"
REPORT_PATH = REAL_AUDIO_DIR.parent / "real_audio_report.json"


def _load_manifest() -> list[dict]:
    if not MANIFEST_PATH.exists():
        return []
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))["items"]


async def _translate(provider: OpenAITranslationProvider, text: str, source_lang: str, target_lang: str) -> str:
    chunks = [
        chunk async for chunk in provider.translate(text, source_lang=source_lang, target_lang=target_lang)
    ]
    return "".join(chunks)


async def main() -> None:
    items = _load_manifest()
    if not items:
        print(
            f"No entries in {MANIFEST_PATH} yet (or the file doesn't exist).\n"
            "This is a real-recording harness -- see this script's module docstring "
            "for how to add one. Nothing to run yet; exiting cleanly, not an error."
        )
        return

    if not settings.deepgram_api_key or not settings.openai_api_key:
        raise SystemExit(
            "Needs both DEEPGRAM_API_KEY (transcription) and OPENAI_API_KEY "
            "(translation + judge) set -- see backend/.env."
        )

    translation_provider = OpenAITranslationProvider(settings.openai_api_key)
    judge_client = AsyncOpenAI(api_key=settings.openai_api_key)

    results = []
    for item in items:
        audio_path = REAL_AUDIO_DIR / item["audioFile"]
        print(f"\n=== {item['id']} ({item.get('conditions', 'no conditions noted')}) ===")

        if not audio_path.exists():
            print(f"SKIP  missing audio file: {audio_path}")
            continue
        try:
            assert_wav_format(audio_path)
        except WavFormatError as exc:
            print(
                f"SKIP  {exc}\n"
                f"      convert with: ffmpeg -i <original> -ar 16000 -ac 1 "
                f"-sample_fmt s16 {audio_path}"
            )
            continue

        other_lang = item["targetLang"]
        hypothesis = await transcribe_wav(
            audio_path, item["sourceLang"], other_lang, settings.deepgram_api_key
        )
        error_rate = word_error_rate(item["referenceText"], hypothesis)
        print(f"WER {error_rate:.1%}  reference={item['referenceText']!r}")
        print(f"          hypothesis={hypothesis!r}")

        # Translates what Deepgram actually heard, not the hand-written
        # reference -- see module docstring for why that's the point here.
        candidate = await _translate(translation_provider, hypothesis, item["sourceLang"], other_lang)
        judgment = await judge_translation(
            hypothesis, item["sourceLang"], candidate, other_lang, client=judge_client
        )
        flag = "PASS" if judgment.acceptable else "FAIL"
        print(f"{flag}  translation: {candidate!r}")
        if judgment.issues:
            print(f"      issues: {', '.join(judgment.issues)}")

        results.append(
            {
                "id": item["id"],
                "conditions": item.get("conditions"),
                "sourceLang": item["sourceLang"],
                "targetLang": other_lang,
                "referenceText": item["referenceText"],
                "transcriptHypothesis": hypothesis,
                "wordErrorRate": error_rate,
                "candidateTranslation": candidate,
                "translationAcceptable": judgment.acceptable,
                "translationIssues": judgment.issues,
                "translationNotes": judgment.notes,
            }
        )

    if not results:
        print("\nNo items produced a result (all skipped) -- nothing to report.")
        return

    avg_wer = sum(r["wordErrorRate"] for r in results) / len(results)
    acceptable_count = sum(r["translationAcceptable"] for r in results)
    print(
        f"\n{len(results)} recording(s) processed -- avg WER {avg_wer:.1%}, "
        f"{acceptable_count}/{len(results)} translations acceptable"
    )

    REPORT_PATH.write_text(
        json.dumps(
            {
                "results": results,
                "summary": {
                    "total": len(results),
                    "averageWordErrorRate": avg_wer,
                    "translationsAcceptable": acceptable_count,
                },
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
