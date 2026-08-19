"""LLM transcript-check side-channel (Ticket 14): answers one question about
a *finished* segment's transcript -- does it look misrecognised, and (in
`correct` mode) what should it have said? `app.orchestrator._process_segment`
calls this between resolving the segment's direction and kicking off
translation, so a rewrite reaches the translator rather than arriving after
it.

Not a `Protocol`-based provider like STT/Translation/TTS in `base.py`, for
the same reason `segmentation_checker.py` isn't: one specific prompt and
model choice serving one specific orchestration decision, not a swappable
vendor boundary. Client construction follows that module too -- one
`AsyncOpenAI` built per object and held for its lifetime, with an explicit
tight timeout, because this call sits directly in a segment's path to
translation.
"""

import json
from dataclasses import dataclass
from typing import Any, Final, Literal

import httpx
from openai import AsyncOpenAI, OpenAIError

# Same small/fast default as the clause check: this runs per segment, in
# front of translation, so a slow verdict costs the listener directly.
MODEL: Final = "gpt-4o-mini"

CheckMode = Literal["flag", "correct"]

_SYSTEM_PROMPT: Final = (
    "You are checking the output of an automatic speech recognition system "
    "for a live interpreting session. The transcript is in {language}. Decide "
    "whether it looks misrecognised: homophone substitutions, garbled or "
    "invented words, or phrases that are impossible in {language}. Disfluency, "
    "missing punctuation and casual phrasing are normal speech, not "
    "misrecognition.{correction}"
    ' Answer with a JSON object: {{"suspicious": <true|false>, "corrected": '
    "<string|null>}}."
)

_CORRECTION_INSTRUCTION: Final = (
    " If it is misrecognised, also give the minimally corrected transcript in "
    '"corrected": change only the words that were misheard, keep everything '
    "else exactly as it is, never translate it into another language, and "
    "never add content that was not spoken. Use null when there is nothing to "
    "correct."
)

_FLAG_INSTRUCTION: Final = ' Always use null for "corrected".'


@dataclass
class TranscriptCheckResult:
    """`failed` is not an error channel the caller has to branch on to stay
    alive -- it means "no verdict", and every field is already the
    do-nothing answer, so a caller that ignores it behaves exactly as if the
    check had come back clean."""

    flagged: bool
    corrected_text: str | None
    failed: bool


def _no_verdict() -> TranscriptCheckResult:
    return TranscriptCheckResult(flagged=False, corrected_text=None, failed=True)


class TranscriptChecker:
    def __init__(self, api_key: str, model: str = MODEL) -> None:
        # Tighter than the clause check's 10s: that one races Deepgram's own
        # boundary signals and losing is harmless, whereas this one is in
        # front of translation, so its whole cost is added latency.
        self._client = AsyncOpenAI(api_key=api_key, timeout=httpx.Timeout(6.0, connect=3.0))
        self._model = model

    async def check(
        self, text: str, language: str, mode: CheckMode, *, model: str | None = None
    ) -> TranscriptCheckResult:
        """Whether `text` (a finished segment's transcript, in `language`)
        looks misrecognised, and in `correct` mode what it should say
        instead.

        `corrected_text` is only ever a *replacement*: `None` in `flag`
        mode, and `None` in `correct` mode when the model returned nothing
        or returned the transcript it was given, so a caller can treat
        "there is a correction" as a plain truth test.

        `model` is per call (defaulting to the constructor's), the same seam
        `SegmentationChecker` and `OpenAITranslationProvider` use, so a
        mid-session tuning Apply reaches the very next segment.

        Any OpenAI failure, and any response this can't parse, comes back as
        `failed=True` rather than raised: the caller translates the original
        text and the session continues (story AC 4.7).
        """
        try:
            response = await self._client.chat.completions.create(
                model=model or self._model,
                stream=False,
                max_tokens=200,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _system_prompt(language, mode)},
                    {"role": "user", "content": text},
                ],
            )
        except OpenAIError:
            return _no_verdict()
        if not response.choices:
            return _no_verdict()
        return _parse(response.choices[0].message.content, text, mode)


def _system_prompt(language: str, mode: CheckMode) -> str:
    return _SYSTEM_PROMPT.format(
        language=language,
        correction=_CORRECTION_INSTRUCTION if mode == "correct" else _FLAG_INSTRUCTION,
    )


def _parse(content: str | None, text: str, mode: CheckMode) -> TranscriptCheckResult:
    """The documented `{"suspicious": bool, "corrected": str|null}` answer, or
    `failed` -- anything else is a response we can't read, and guessing at
    what the model meant would be worse than saying the check didn't run."""
    if not content:
        return _no_verdict()
    try:
        parsed: Any = json.loads(content)
    except json.JSONDecodeError:
        return _no_verdict()
    if not isinstance(parsed, dict) or not isinstance(parsed.get("suspicious"), bool):
        return _no_verdict()

    corrected = parsed.get("corrected")
    if corrected is not None and not isinstance(corrected, str):
        return _no_verdict()
    if mode == "flag" or not corrected or corrected.strip() == text.strip():
        corrected = None
    return TranscriptCheckResult(
        flagged=parsed["suspicious"], corrected_text=corrected, failed=False
    )
