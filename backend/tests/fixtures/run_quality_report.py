"""Ticket 8's "run the suite, get a quality report" deliverable, added by
Ticket 9: Ticket 8's own acceptance criteria named an LLM-judge quality
report as a system-level output, but nothing in that ticket actually tied
`judge_translation` to the full corpus as a runnable script --
`test_quality_llm_judge.py` only covers the judge's request/response
plumbing against a fake client, never a real dataset.

For every item in `interpreter_dataset.json`, this script:
1. Translates `text` with the real `OpenAITranslationProvider` (the same
   class `app.orchestrator` uses in Cascade mode) to get a candidate
   translation -- not `referenceTranslation`, which is a human sanity-check
   for the write-up, never the judge's input (see the dataset's own
   `_comment`).
2. Scores that candidate against the source with
   `app.quality.llm_judge.judge_translation`.

Prints a per-item PASS/FAIL line (with issues, when any) plus a summary
acceptance rate, and writes the full report as JSON for Ticket 9's
write-up to cite numbers from.

Requires a live `OPENAI_API_KEY` -- makes two real OpenAI calls per item
(translate + judge). Run from `backend/`:

    uv run python tests/fixtures/run_quality_report.py

Output: `tests/fixtures/quality_report.json`.
"""

import asyncio
import json
from pathlib import Path

from openai import AsyncOpenAI

from app.config import settings
from app.providers.openai_translation import OpenAITranslationProvider
from app.quality.llm_judge import judge_translation

FIXTURES_DIR = Path(__file__).parent
DATASET_PATH = FIXTURES_DIR / "interpreter_dataset.json"
REPORT_PATH = FIXTURES_DIR / "quality_report.json"


async def _translate(provider: OpenAITranslationProvider, item: dict) -> str:
    chunks = [
        chunk
        async for chunk in provider.translate(
            item["text"], source_lang=item["sourceLang"], target_lang=item["targetLang"]
        )
    ]
    return "".join(chunks)


async def main() -> None:
    if not settings.openai_api_key:
        raise SystemExit(
            "OPENAI_API_KEY is not set -- this script makes real translation + judge "
            "calls and can't run without one. Set it in backend/.env (or the "
            "environment) and re-run: uv run python tests/fixtures/run_quality_report.py"
        )

    items = json.loads(DATASET_PATH.read_text(encoding="utf-8"))["items"]
    translation_provider = OpenAITranslationProvider(settings.openai_api_key)
    judge_client = AsyncOpenAI(api_key=settings.openai_api_key)

    results = []
    for item in items:
        candidate = await _translate(translation_provider, item)
        judgment = await judge_translation(
            item["text"], item["sourceLang"], candidate, item["targetLang"], client=judge_client
        )
        results.append(
            {
                "id": item["id"],
                "category": item["category"],
                "sourceLang": item["sourceLang"],
                "targetLang": item["targetLang"],
                "text": item["text"],
                "candidateTranslation": candidate,
                "referenceTranslation": item.get("referenceTranslation"),
                "acceptable": judgment.acceptable,
                "issues": judgment.issues,
                "notes": judgment.notes,
            }
        )
        flag = "PASS" if judgment.acceptable else "FAIL"
        print(f"{flag}  {item['id']:<28} {item['text'][:50]!r}")
        if judgment.issues:
            print(f"      issues: {', '.join(judgment.issues)}")

    acceptable_count = sum(r["acceptable"] for r in results)
    total = len(results)
    print(f"\n{acceptable_count}/{total} acceptable ({acceptable_count / total:.0%})")

    REPORT_PATH.write_text(
        json.dumps(
            {
                "results": results,
                "summary": {
                    "total": total,
                    "acceptable": acceptable_count,
                    "acceptanceRate": acceptable_count / total,
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
