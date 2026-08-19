"""Translation-quality LLM-as-judge (Ticket 8): scores one candidate
translation against its source text and reports *what's wrong*, if
anything (lost tense, wrong register, dropped negation, mistranslation),
not just a pass/fail score, so a human or Ticket 9's write-up has something
actionable per item.

Not a provider (`app.providers.base` isn't touched here, no `Protocol`).
This is a one-off/batch scoring utility for the test corpus, never called on
the real-time pipeline path. `AsyncOpenAI` usage mirrors
`openai_translation.py`/`segmentation_checker.py`'s pattern (JSON-mode
structured output, per issue 14's resolution to use LLM-as-judge rather than
BLEU/COMET: no reference translation required, an actual verdict comes
back explaining the problem instead of an aggregate number).
"""

import json
from dataclasses import dataclass
from typing import Final

from openai import AsyncOpenAI

from app.config import settings
from app.languages import SUPPORTED_LANGUAGES

MODEL: Final = "gpt-4o-mini"

_SYSTEM_PROMPT: Final = (
    "You are a bilingual translation quality reviewer for a live spoken-language "
    "interpretation product. Given a source sentence and a candidate translation, "
    "judge whether the translation is acceptable for that use case -- natural "
    "paraphrase is fine, word-for-word literalness is not required. Respond with a "
    "JSON object with exactly these keys: \"acceptable\" (boolean), \"issues\" "
    "(an array of short strings describing what's wrong, e.g. \"lost tense\", "
    "\"wrong register\", \"dropped negation\", \"mistranslation\" -- empty if "
    "there are none), and \"notes\" (a one-sentence explanation of the verdict)."
)


@dataclass
class TranslationJudgment:
    """One judge verdict: `acceptable` is the headline pass/fail, `issues`
    is the actionable part the ticket calls out (what's wrong, not just a
    score). Empty when `acceptable` is True, `notes` is a short free-text
    explanation either way."""

    acceptable: bool
    issues: list[str]
    notes: str


async def judge_translation(
    source_text: str,
    source_language: str,
    candidate_translation: str,
    target_language: str,
    *,
    client: AsyncOpenAI | None = None,
) -> TranslationJudgment:
    """Judges `candidate_translation` (in `target_language`) against
    `source_text` (in `source_language`).

    `client` defaults to a fresh `AsyncOpenAI(api_key=settings.openai_api_key)`
    built per call. Unlike `SegmentationChecker` (constructed once and held
    for a whole real-time session, called per segment), this runs as a batch
    over a test corpus, not a hot path, so there's no lifetime to hold a
    client for. The parameter exists so a batch runner can supply one shared
    client across many items, and so tests can inject a fake one.

    Lets an outright API failure (rate limit, timeout, auth, ...) from
    `client.chat.completions.create` propagate rather than swallowing it into
    a default verdict: unlike a segmentation gate where a wrong guess just
    means a fallback signal cuts the segment instead, a failed judge call has
    no safe default here: reporting "acceptable" would hide a real
    translation defect from the quality report instead of surfacing it. Only
    the response *content* (missing or malformed JSON) is parsed defensively,
    in `_parse_response`.
    """
    openai_client = client or AsyncOpenAI(api_key=settings.openai_api_key)
    source_name = SUPPORTED_LANGUAGES.get(source_language, source_language)
    target_name = SUPPORTED_LANGUAGES.get(target_language, target_language)

    response = await openai_client.chat.completions.create(
        model=MODEL,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Source ({source_name}): {source_text}\n"
                    f"Candidate translation ({target_name}): {candidate_translation}"
                ),
            },
        ],
    )
    return _parse_response(response)


def _parse_response(response) -> TranslationJudgment:
    """Defensive parse of the model's JSON-mode response, per the ticket: a
    missing field, wrong type, or (despite `response_format={"type":
    "json_object"}`) a non-JSON/non-object body all fall back to a
    conservative `acceptable=False` judgment carrying the parse problem as
    its own issue, rather than raising. One uninterpretable item shouldn't
    crash a whole corpus run.
    """
    content = response.choices[0].message.content if response.choices else None
    if not content:
        return TranslationJudgment(acceptable=False, issues=["judge returned no content"], notes="")

    try:
        payload = json.loads(content)
    except json.JSONDecodeError:
        return TranslationJudgment(
            acceptable=False, issues=["judge response was not valid JSON"], notes=content.strip()
        )
    if not isinstance(payload, dict):
        return TranslationJudgment(
            acceptable=False,
            issues=["judge response JSON was not an object"],
            notes=content.strip(),
        )

    acceptable = payload.get("acceptable")
    issues = payload.get("issues")
    notes = payload.get("notes")
    return TranslationJudgment(
        acceptable=acceptable is True,
        issues=[str(issue) for issue in issues] if isinstance(issues, list) else [],
        notes=notes if isinstance(notes, str) else "",
    )
