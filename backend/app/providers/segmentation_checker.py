"""LLM clause-check side-channel (Ticket 5): answers one question: is the
partial transcript accumulated so far a complete, grammatically finished
clause, ready to translate, or is it still trailing off? `app.orchestrator`
races this against Deepgram's own `speech_final`/`UtteranceEnd` boundary
signals (see `_run_stt`); this module only answers the question, it never
touches segmentation state itself.

Not a `Protocol`-based provider like STT/Translation/TTS in `base.py`.
This is orchestration logic (one specific prompt/model choice for one
specific gating decision), not a swappable vendor boundary. `AsyncOpenAI`
client construction mirrors `openai_translation.py`'s pattern (one client
built once, held for the object's lifetime) since this call happens far
more often, per segment, than translation does.
"""

from typing import Final

import httpx
from openai import AsyncOpenAI, OpenAIError

# Small/fast, not the translation model: this call gates real-time
# capture (see `app.orchestrator._run_stt`'s race), so latency matters more
# than quality here: a wrong verdict just means Deepgram's own
# speech_final/UtteranceEnd fallback cuts the segment instead.
MODEL: Final = "gpt-4o-mini"

_PROMPT_TEMPLATE: Final = (
    'Partial transcript of live speech in {language}: "{text}". Is this a '
    "complete, grammatically finished clause or sentence ready to "
    "translate -- not trailing off or obviously incomplete? Respond with "
    "exactly one word: YES or NO."
)


class SegmentationChecker:
    def __init__(self, api_key: str) -> None:
        # Tight explicit timeout (vs the SDK's 600s default): a slow
        # verdict is worthless here anyway; Deepgram's own boundary
        # signals will have cut the segment long before 600s.
        self._client = AsyncOpenAI(
            api_key=api_key, timeout=httpx.Timeout(10.0, connect=5.0)
        )

    async def is_complete_clause(
        self, text: str, language: str, *, model: str | None = None
    ) -> bool:
        """True iff `text` (the in-progress segment's accumulated transcript,
        in `language`) reads as a complete, translatable clause.
        Non-streaming, single-token response: this is a gate, not a
        generation.

        `model` is per call (defaulting to `MODEL`) so a mid-session tuning
        Apply reaches the very next clause-check instead of waiting for a
        new session.

        Any OpenAI failure (rate limit, timeout, malformed response) is
        treated as `False` rather than raised: a negative verdict just
        means capture continues, and it's Deepgram's own
        speech_final/UtteranceEnd fallback (not this call succeeding)
        that guarantees a segment never hangs (see
        `app.orchestrator._run_stt`'s race).
        """
        try:
            response = await self._client.chat.completions.create(
                model=model or MODEL,
                stream=False,
                # A couple tokens' headroom for "YES"/"NO" plus stray
                # punctuation, without inviting a rambling response;
                # still effectively free latency-wise.
                max_tokens=3,
                messages=[
                    {
                        "role": "user",
                        "content": _PROMPT_TEMPLATE.format(language=language, text=text),
                    }
                ],
            )
        except OpenAIError:
            return False
        if not response.choices:
            return False
        content = response.choices[0].message.content
        return bool(content) and content.strip().upper().startswith("YES")
