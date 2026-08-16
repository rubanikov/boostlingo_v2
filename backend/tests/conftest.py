"""Shared pytest fixtures.

Ticket 5: `SegmentationChecker` is now constructed for every session
(`orchestrator._start_new_session`), the same way `DeepgramSTTProvider`/
`OpenAITranslationProvider`/`ElevenLabsTTSProvider` already are. Unlike
those three, most existing tests predate this ticket and don't monkeypatch
it -- without a default, the real `SegmentationChecker` would try to
construct a real `AsyncOpenAI` client against `settings.openai_api_key`
(empty in the test environment) and blow up session startup for every one
of them.

This autouse fixture stands in a checker that never resolves `True`, so
segmentation for every pre-existing test stays driven purely by Deepgram's
`speech_final`/`UtteranceEnd`, exactly as it was before this ticket. A test
that specifically wants to exercise the LLM race overrides this with its
own `monkeypatch.setattr(orchestrator, "SegmentationChecker", ...)`, same
as any other provider (see `test_segmentation.py`, which instead drives
`orchestrator._run_stt` directly and never goes through this fixture at
all).

Ticket 14 adds a second one for exactly the same reason: `TranscriptChecker`
is constructed per session too. Its stub answers "nothing to report" in every
mode, so a test that doesn't set `cascade.transcriptCheck.mode` (i.e. all of
them, since the default is `off`) sees the pipeline it always saw.
"""

import pytest

from app import orchestrator
from app.providers.transcript_check import TranscriptCheckResult


class _NeverCompleteSegmentationChecker:
    def __init__(self, api_key: str) -> None:
        pass

    async def is_complete_clause(self, text: str, language: str, *, model: str | None = None) -> bool:
        del text, language
        return False


class _CleanTranscriptChecker:
    def __init__(self, api_key: str, model: str = "gpt-4o-mini") -> None:
        pass

    async def check(
        self, text: str, language: str, mode: str, *, model: str | None = None
    ) -> TranscriptCheckResult:
        del text, language, mode, model
        return TranscriptCheckResult(flagged=False, corrected_text=None, failed=False)


@pytest.fixture(autouse=True)
def _default_segmentation_checker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator, "SegmentationChecker", _NeverCompleteSegmentationChecker)


@pytest.fixture(autouse=True)
def _default_transcript_checker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(orchestrator, "TranscriptChecker", _CleanTranscriptChecker)
