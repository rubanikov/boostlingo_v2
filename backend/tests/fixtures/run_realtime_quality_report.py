"""Realtime-mode translation-quality report: the missing row in
COMPARISON.md section 2.

`run_quality_report.py` scores Cascade by calling its translate() step on
each dataset item directly. Realtime has no such step: `gpt-realtime`
translates inside the model, so its output only exists as the spoken reply
of a live audio session. `frontend/e2e/realtime-quality-capture.mjs` runs
those sessions (one per recorded clip of the corpus, via Chromium's
fake-mic) and writes what the model said to
`tests/fixtures/realtime_quality/captures.json`; this script judges those
captures with the same `judge_translation()` Cascade was scored with, so
the two acceptance rates are comparable.

Each capture is judged against the *reference text* (what the speaker
actually said, from the manifest), because that is what the listener
would compare the interpretation to. The input-side caption
(`gpt-4o-transcribe`'s transcript, a side channel the model does not
translate from) is reported as an informational WER only, so an
unintelligible recording can be told apart from a bad translation.

## Steps

1. Record the corpus: `tests/fixtures/real_audio/recorder.html`, prompt
   set "Realtime quality corpus"; `tests/fixtures/realtime_quality/SCRIPT.md`
   has every line.
2. Start both dev servers with real keys in `backend/.env` (`.\\dev.ps1`).
3. `cd frontend && npm run capture:realtime-quality`
   (add `-- --tuning configs/a.json` to run the corpus under a specific
   `TuningConfig` rather than the server's defaults)
4. `cd backend && uv run python -m tests.fixtures.run_realtime_quality_report`
   (module form so `app` imports resolve; needs `OPENAI_API_KEY` for the judge)

Output: per-item verdict lines on stdout, the full report at
`tests/fixtures/realtime_quality_report.json`, a ready-to-paste summary for
COMPARISON.md section 2, and one section 7 row per tuning config and
condition.

Every capture carries the fingerprint of the tuning config its session ran
under (the capture harness scrapes it off the panel's chip), so it travels
through this report unchanged: onto each result row, into the summary, and
into the section 7 row that joins these numbers to the Cascade sweep's.
A capture file written before fingerprints existed simply carries `null`.
"""

import asyncio
import json
from pathlib import Path

from openai import AsyncOpenAI

from app.config import settings
from app.quality.llm_judge import judge_translation
from tests.fixtures.stt_replay import word_error_rate

CORPUS_DIR = Path(__file__).parent / "realtime_quality"
CAPTURES_PATH = CORPUS_DIR / "captures.json"
REPORT_PATH = CORPUS_DIR.parent / "realtime_quality_report.json"


def _load_captures() -> list[dict]:
    """The capture items, each guaranteed to carry a `fingerprint` key: an
    item that has none inherits the envelope's, which is the config the whole
    run was captured under."""
    if not CAPTURES_PATH.exists():
        return []
    document = json.loads(CAPTURES_PATH.read_text(encoding="utf-8"))
    envelope_fingerprint = document.get("fingerprint")
    return [
        {**capture, "fingerprint": capture.get("fingerprint") or envelope_fingerprint}
        for capture in document["items"]
    ]


async def main() -> None:
    captures = _load_captures()
    if not captures:
        print(
            f"No captures at {CAPTURES_PATH} yet.\n"
            "Run `npm run capture:realtime-quality` from frontend/ first (see this "
            "script's module docstring for the full sequence). Nothing to judge; exiting "
            "cleanly, not an error."
        )
        return
    if not settings.openai_api_key:
        raise SystemExit("Needs OPENAI_API_KEY (judge) set -- see backend/.env.")

    judge_client = AsyncOpenAI(api_key=settings.openai_api_key)

    results = []
    for capture in captures:
        print(f"\n=== {capture['id']} ({capture['sourceLang']} -> {capture['targetLang']}) ===")
        if capture.get("error"):
            print(f"SKIP  capture failed: {capture['error']}")
            results.append({**_identity(capture), "status": "capture_failed", "captureError": capture["error"]})
            continue

        heard = capture.get("inputTranscript") or ""
        said = capture.get("outputTranscript") or ""
        caption_wer = word_error_rate(capture["referenceText"], heard) if heard else None
        print(f"reference: {capture['referenceText']!r}")
        print(f"heard:     {heard!r}" + (f"  (caption WER {caption_wer:.1%})" if caption_wer is not None else ""))

        if not said.strip():
            print("FAIL  model produced no reply")
            results.append(
                {
                    **_identity(capture),
                    "status": "judged",
                    "inputTranscript": heard,
                    "captionWordErrorRate": caption_wer,
                    "outputTranscript": "",
                    "translationAcceptable": False,
                    "translationIssues": ["no reply from model"],
                    "translationNotes": "",
                    "endToEndLatencyMs": capture.get("endToEndLatencyMs"),
                }
            )
            continue

        judgment = await judge_translation(
            capture["referenceText"],
            capture["sourceLang"],
            said,
            capture["targetLang"],
            client=judge_client,
        )
        flag = "PASS" if judgment.acceptable else "FAIL"
        print(f"{flag}  said: {said!r}")
        if judgment.issues:
            print(f"      issues: {', '.join(judgment.issues)}")
        results.append(
            {
                **_identity(capture),
                "status": "judged",
                "inputTranscript": heard,
                "captionWordErrorRate": caption_wer,
                "outputTranscript": said,
                "translationAcceptable": judgment.acceptable,
                "translationIssues": judgment.issues,
                "translationNotes": judgment.notes,
                "endToEndLatencyMs": capture.get("endToEndLatencyMs"),
            }
        )

    judged = [r for r in results if r["status"] == "judged"]
    if not judged:
        print("\nNo capture could be judged (all failed at capture time) -- nothing to report.")
        return

    acceptable = sum(r["translationAcceptable"] for r in judged)
    wers = [r["captionWordErrorRate"] for r in judged if r["captionWordErrorRate"] is not None]
    latencies = [r["endToEndLatencyMs"] for r in judged if r["endToEndLatencyMs"] is not None]
    # Normally one config per capture file. A file assembled from several runs
    # is reported as a list instead of a single fingerprint, because averaging
    # across configurations is exactly the mistake the fingerprint exists to
    # prevent -- the per-config numbers are in the section 7 rows below.
    fingerprints = sorted({r["fingerprint"] for r in results if r["fingerprint"]})
    summary = {
        "fingerprint": fingerprints[0] if len(fingerprints) == 1 else None,
        "captured": len(results),
        "judged": len(judged),
        "translationsAcceptable": acceptable,
        "acceptanceRate": acceptable / len(judged),
        "averageCaptionWordErrorRate": (sum(wers) / len(wers)) if wers else None,
        "endToEndLatencyMs": {
            "n": len(latencies),
            "mean": (sum(latencies) / len(latencies)) if latencies else None,
            "min": min(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
        },
    }
    if len(fingerprints) > 1:
        summary["fingerprints"] = fingerprints
    REPORT_PATH.write_text(
        json.dumps({"results": results, "summary": summary}, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(
        f"\n{len(judged)}/{len(results)} capture(s) judged -- "
        f"{acceptable}/{len(judged)} translations acceptable ({summary['acceptanceRate']:.0%})"
    )
    print(f"tuning config: {', '.join(fingerprints) if fingerprints else 'not recorded'}")
    if wers:
        print(f"caption WER (informational, gpt-4o-transcribe side channel): {summary['averageCaptionWordErrorRate']:.1%}")
    if latencies:
        lat = summary["endToEndLatencyMs"]
        print(f"end-to-end latency over {lat['n']} turns: mean {lat['mean']:.0f}ms, range {lat['min']}-{lat['max']}ms")
    print(f"wrote {REPORT_PATH}")
    print(
        "\nCOMPARISON.md section 2 row:\n"
        f"| Realtime LLM-judge acceptance rate ({len(judged)} items, real-voice clips) | "
        f"**{acceptable}/{len(judged)} ({summary['acceptanceRate']:.0%})** |"
    )
    print("\nCOMPARISON.md section 7 rows:")
    for line in _table_rows(judged):
        print(line)


def _identity(capture: dict) -> dict:
    return {
        "id": capture["id"],
        "fingerprint": capture.get("fingerprint"),
        "sourceLang": capture["sourceLang"],
        "targetLang": capture["targetLang"],
        "referenceText": capture["referenceText"],
        "referenceTranslation": capture.get("referenceTranslation"),
        "conditions": capture.get("conditions"),
    }


def _condition(result: dict) -> str:
    """Section 7's `condition` column. The Realtime corpus is recorded
    speech, not the synthesised noisy corpus, so a clip only has a condition
    if the person recording it noted one."""
    return result.get("conditions") or "clean"


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _table_rows(judged: list[dict]) -> list[str]:
    """One markdown row per (fingerprint, condition), in COMPARISON.md
    section 7's column order.

    Three of the nine columns are structurally blank on a Realtime row and
    stay that way: `SNR` (these are real recordings, not mixed-in noise at a
    known ratio), `corrected WER` (the transcript check's `correct` mode is
    Cascade-only) and `added latency` (there is no client-side denoise chain
    to attribute time to; the model is the whole pipeline). `provider
    latency` is the end-to-end turn latency the UI measured, which for
    Realtime *is* the provider's.
    """
    lines = []
    buckets = sorted(
        {(result["fingerprint"], _condition(result)) for result in judged},
        # `or ""`: a capture file from before fingerprints existed carries
        # None, which will not sort against a string.
        key=lambda bucket: (bucket[0] or "", bucket[1]),
    )
    for config_fingerprint, condition in buckets:
        cell = [
            result
            for result in judged
            if (result["fingerprint"], _condition(result)) == (config_fingerprint, condition)
        ]
        acceptable = sum(result["translationAcceptable"] for result in cell)
        wers = [r["captionWordErrorRate"] for r in cell if r["captionWordErrorRate"] is not None]
        latencies = [r["endToEndLatencyMs"] for r in cell if r["endToEndLatencyMs"] is not None]
        lines.append(
            f"| `{config_fingerprint or 'cfg:unknown'}` | realtime | {condition} | -- | "
            f"{f'{_mean(wers):.1%} (n={len(wers)})' if wers else '--'} | -- | "
            f"{acceptable}/{len(cell)} ({acceptable / len(cell):.0%}) | -- | "
            f"{f'{_mean(latencies):.0f} ms' if latencies else '--'} |"
        )
    return lines


if __name__ == "__main__":
    asyncio.run(main())
