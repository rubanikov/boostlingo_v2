"""Ticket 14's provider-boundary tests for `app.providers.transcript_check`.

Same posture as `test_providers.py`'s `TestSegmentationChecker`: the OpenAI
client is mocked, so no live call is ever made, and every documented failure
mode is checked to come back as `failed=True` rather than as an exception --
a transcript check that blows up must never take a segment (or a session)
with it.
"""

import json
from unittest.mock import AsyncMock

import httpx2
import openai as openai_errors
import pytest

from app.providers import transcript_check
from app.providers.transcript_check import TranscriptChecker


def _openai_request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")


class _FakeMessage:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str | None) -> None:
        self.message = _FakeMessage(content)


class _FakeChatCompletion:
    def __init__(self, choices: list[_FakeChoice]) -> None:
        self.choices = choices


def _answer(**payload: object) -> _FakeChatCompletion:
    """A `chat.completions.create(...)` result whose single choice carries
    the JSON object the prompt asks for."""
    return _FakeChatCompletion([_FakeChoice(json.dumps(payload))])


def _patched(monkeypatch: pytest.MonkeyPatch, **mock_kwargs: object) -> tuple:
    checker = TranscriptChecker(api_key="test-key")
    create = AsyncMock(**mock_kwargs)
    monkeypatch.setattr(checker._client.chat.completions, "create", create)
    return checker, create


class TestTranscriptChecker:
    @pytest.mark.asyncio
    async def test_a_suspicious_verdict_is_flagged(self, monkeypatch):
        checker, _ = _patched(
            monkeypatch, return_value=_answer(suspicious=True, corrected=None)
        )

        result = await checker.check("wreck a nice beach", "en", "flag")

        assert result.flagged is True
        assert result.corrected_text is None
        assert result.failed is False

    @pytest.mark.asyncio
    async def test_a_clean_verdict_is_not_flagged(self, monkeypatch):
        checker, _ = _patched(
            monkeypatch, return_value=_answer(suspicious=False, corrected=None)
        )

        result = await checker.check("the meeting starts at noon", "en", "flag")

        assert result.flagged is False
        assert result.corrected_text is None
        assert result.failed is False

    @pytest.mark.asyncio
    async def test_correct_mode_returns_the_rewritten_transcript(self, monkeypatch):
        checker, _ = _patched(
            monkeypatch,
            return_value=_answer(suspicious=True, corrected="recognise speech"),
        )

        result = await checker.check("wreck a nice beach", "en", "correct")

        assert result.flagged is True
        assert result.corrected_text == "recognise speech"
        assert result.failed is False

    @pytest.mark.asyncio
    async def test_a_rewrite_identical_to_the_original_is_no_correction(self, monkeypatch):
        """`corrected_text` means "there is something to replace the
        transcript with". A model echoing the input back (whitespace aside)
        would otherwise make the orchestrator re-send a `source_transcript`
        whose `correctedFrom` equals its `text`."""
        checker, _ = _patched(
            monkeypatch,
            return_value=_answer(suspicious=True, corrected="  the meeting starts at noon "),
        )

        result = await checker.check("the meeting starts at noon", "en", "correct")

        assert result.corrected_text is None
        assert result.flagged is True
        assert result.failed is False

    @pytest.mark.asyncio
    async def test_flag_mode_never_reports_a_correction(self, monkeypatch):
        """A `flag`-mode caller translates the original text no matter what,
        so a `corrected` the model volunteered anyway is dropped here rather
        than left for each call site to remember to ignore."""
        checker, _ = _patched(
            monkeypatch,
            return_value=_answer(suspicious=True, corrected="recognise speech"),
        )

        result = await checker.check("wreck a nice beach", "en", "flag")

        assert result.corrected_text is None
        assert result.flagged is True

    @pytest.mark.asyncio
    async def test_the_model_is_asked_for_a_json_object_and_a_short_answer(self, monkeypatch):
        checker, create = _patched(
            monkeypatch, return_value=_answer(suspicious=False, corrected=None)
        )

        await checker.check("the meeting starts at noon", "en", "correct")

        kwargs = create.await_args.kwargs
        assert kwargs["response_format"] == {"type": "json_object"}
        assert kwargs["max_tokens"] == 200
        assert kwargs["stream"] is False
        prompt = " ".join(message["content"] for message in kwargs["messages"])
        assert "en" in prompt
        assert "the meeting starts at noon" in prompt

    @pytest.mark.asyncio
    async def test_model_is_per_call_and_defaults_to_the_constructor_argument(self, monkeypatch):
        """Ticket 06's per-call seam (`SegmentationChecker`,
        `OpenAITranslationProvider`): a mid-session tuning Apply reaches the
        very next check instead of waiting for a new session."""
        checker = TranscriptChecker(api_key="test-key", model="gpt-4.1-mini")
        create = AsyncMock(return_value=_answer(suspicious=False, corrected=None))
        monkeypatch.setattr(checker._client.chat.completions, "create", create)

        await checker.check("hi", "en", "flag")
        await checker.check("hi", "en", "flag", model="gpt-4o-mini")

        assert [call.kwargs["model"] for call in create.await_args_list] == [
            "gpt-4.1-mini",
            "gpt-4o-mini",
        ]

    def test_the_default_model_is_the_module_constant(self):
        assert TranscriptChecker(api_key="test-key")._model == transcript_check.MODEL

    @pytest.mark.asyncio
    async def test_an_openai_failure_is_reported_as_failed_rather_than_raised(self, monkeypatch):
        checker, _ = _patched(
            monkeypatch, side_effect=openai_errors.APITimeoutError(request=_openai_request())
        )

        result = await checker.check("wreck a nice beach", "en", "correct")

        assert result == transcript_check.TranscriptCheckResult(
            flagged=False, corrected_text=None, failed=True
        )

    @pytest.mark.asyncio
    async def test_a_rate_limit_is_reported_as_failed(self, monkeypatch):
        response = httpx2.Response(429, request=_openai_request())
        checker, _ = _patched(
            monkeypatch,
            side_effect=openai_errors.RateLimitError("rate limited", response=response, body=None),
        )

        result = await checker.check("wreck a nice beach", "en", "flag")

        assert result.failed is True

    @pytest.mark.asyncio
    async def test_unparseable_content_is_reported_as_failed(self, monkeypatch):
        checker, _ = _patched(
            monkeypatch, return_value=_FakeChatCompletion([_FakeChoice("not json at all")])
        )

        result = await checker.check("wreck a nice beach", "en", "correct")

        assert result.failed is True

    @pytest.mark.asyncio
    async def test_a_response_with_no_choices_is_reported_as_failed(self, monkeypatch):
        checker, _ = _patched(monkeypatch, return_value=_FakeChatCompletion([]))

        result = await checker.check("wreck a nice beach", "en", "flag")

        assert result.failed is True

    @pytest.mark.asyncio
    async def test_a_json_object_of_the_wrong_shape_is_reported_as_failed(self, monkeypatch):
        """Not `{"suspicious": bool, ...}` -- guessing at what the model
        meant would be worse than saying the check didn't run."""
        checker, _ = _patched(monkeypatch, return_value=_answer(verdict="maybe"))

        result = await checker.check("wreck a nice beach", "en", "correct")

        assert result.failed is True

    @pytest.mark.asyncio
    async def test_a_non_string_correction_is_reported_as_failed(self, monkeypatch):
        checker, _ = _patched(monkeypatch, return_value=_answer(suspicious=True, corrected=12))

        result = await checker.check("wreck a nice beach", "en", "correct")

        assert result.failed is True
