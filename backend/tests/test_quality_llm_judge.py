"""Ticket 8's dedicated coverage for `app.quality.llm_judge`: the JSON-mode
prompt/response plumbing, defensive parsing of the model's response, and
that an outright API failure propagates rather than being swallowed into a
false "acceptable" verdict.

Seam: `judge_translation` itself, via its `client=` injection point -- a
minimal `AsyncOpenAI`-shaped fake (mirrors `test_providers.py`'s
`_FakeChatCompletion`/`_FakeChoiceWithMessage` convention for a non-streaming
`chat.completions.create` result) so no live network call is ever made, same
convention as every other LLM-touching test in this codebase.

What this can't cover without a live key: whether the judge's *prompt
quality* actually produces good verdicts against real translations -- only
that the plumbing (request shape, response parsing) is correct. See Ticket
8's summary.
"""

import json

import httpx2
import openai as openai_errors
import pytest

from app.quality.llm_judge import MODEL, TranslationJudgment, judge_translation


class _FakeMessage:
    def __init__(self, content: str | None) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str | None) -> None:
        self.message = _FakeMessage(content)


class _FakeChatCompletion:
    def __init__(self, choices: list[_FakeChoice]) -> None:
        self.choices = choices


class _FakeCompletions:
    """Records every `create()` call's kwargs (`calls`) so a test can assert
    on the request shape, and returns a canned response built from
    `content`."""

    def __init__(self, content: str | None) -> None:
        self._content = content
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return _FakeChatCompletion([_FakeChoice(self._content)])


class _FailingCompletions:
    def __init__(self, error: Exception) -> None:
        self._error = error

    async def create(self, **kwargs):
        del kwargs
        raise self._error


class _FakeClient:
    """`AsyncOpenAI`-shaped double: `judge_translation` only ever touches
    `.chat.completions.create(...)`, so that's all this needs to satisfy."""

    def __init__(self, completions) -> None:
        self.chat = _FakeChat(completions)


class _FakeChat:
    def __init__(self, completions) -> None:
        self.completions = completions


def _openai_request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.openai.com/v1/chat/completions")


class TestJudgeTranslationHappyPath:
    @pytest.mark.asyncio
    async def test_acceptable_translation_with_no_issues(self):
        content = json.dumps({"acceptable": True, "issues": [], "notes": "Faithful translation."})
        client = _FakeClient(_FakeCompletions(content))

        judgment = await judge_translation(
            "Good morning!", "en", "¡Buenos días!", "es", client=client
        )

        assert judgment == TranslationJudgment(
            acceptable=True, issues=[], notes="Faithful translation."
        )

    @pytest.mark.asyncio
    async def test_unacceptable_translation_reports_specific_issues(self):
        content = json.dumps(
            {
                "acceptable": False,
                "issues": ["dropped negation", "wrong register"],
                "notes": "The candidate omits \"not\" and uses an overly formal tone.",
            }
        )
        client = _FakeClient(_FakeCompletions(content))

        judgment = await judge_translation(
            "I don't want that.", "en", "Quiero eso.", "es", client=client
        )

        assert judgment.acceptable is False
        assert judgment.issues == ["dropped negation", "wrong register"]
        assert "not" in judgment.notes

    @pytest.mark.asyncio
    async def test_sends_json_mode_request_with_both_language_names_and_texts(self):
        content = json.dumps({"acceptable": True, "issues": [], "notes": ""})
        completions = _FakeCompletions(content)
        client = _FakeClient(completions)

        await judge_translation("Hello there.", "en", "Hola.", "es", client=client)

        assert len(completions.calls) == 1
        call = completions.calls[0]
        assert call["model"] == MODEL
        assert call["response_format"] == {"type": "json_object"}
        system_message, user_message = call["messages"]
        assert system_message["role"] == "system"
        assert "json" in system_message["content"].lower()  # required for OpenAI's json_object mode
        assert user_message["role"] == "user"
        assert "English" in user_message["content"]
        assert "Spanish" in user_message["content"]
        assert "Hello there." in user_message["content"]
        assert "Hola." in user_message["content"]

    @pytest.mark.asyncio
    async def test_unmapped_language_code_falls_back_to_the_raw_code(self):
        content = json.dumps({"acceptable": True, "issues": [], "notes": ""})
        completions = _FakeCompletions(content)
        client = _FakeClient(completions)

        await judge_translation("Guten Tag.", "de", "Hello.", "en", client=client)

        user_message = completions.calls[0]["messages"][1]["content"]
        assert "de" in user_message


class TestJudgeTranslationDefensiveParsing:
    @pytest.mark.asyncio
    async def test_non_json_response_falls_back_to_unacceptable_with_parse_issue(self):
        client = _FakeClient(_FakeCompletions("not json at all"))

        judgment = await judge_translation("Hi.", "en", "Hola.", "es", client=client)

        assert judgment.acceptable is False
        assert judgment.issues == ["judge response was not valid JSON"]
        assert judgment.notes == "not json at all"

    @pytest.mark.asyncio
    async def test_json_array_instead_of_object_falls_back_to_unacceptable(self):
        client = _FakeClient(_FakeCompletions(json.dumps(["not", "an", "object"])))

        judgment = await judge_translation("Hi.", "en", "Hola.", "es", client=client)

        assert judgment.acceptable is False
        assert judgment.issues == ["judge response JSON was not an object"]

    @pytest.mark.asyncio
    async def test_missing_fields_default_conservatively(self):
        client = _FakeClient(_FakeCompletions(json.dumps({})))

        judgment = await judge_translation("Hi.", "en", "Hola.", "es", client=client)

        assert judgment == TranslationJudgment(acceptable=False, issues=[], notes="")

    @pytest.mark.asyncio
    async def test_wrong_typed_fields_default_conservatively_rather_than_raising(self):
        content = json.dumps({"acceptable": "yes", "issues": "not a list", "notes": 42})
        client = _FakeClient(_FakeCompletions(content))

        judgment = await judge_translation("Hi.", "en", "Hola.", "es", client=client)

        assert judgment == TranslationJudgment(acceptable=False, issues=[], notes="")

    @pytest.mark.asyncio
    async def test_empty_choices_falls_back_to_unacceptable(self):
        client = _FakeClient(_FakeCompletionsEmptyChoices())

        judgment = await judge_translation("Hi.", "en", "Hola.", "es", client=client)

        assert judgment == TranslationJudgment(
            acceptable=False, issues=["judge returned no content"], notes=""
        )


class _FakeCompletionsEmptyChoices:
    async def create(self, **kwargs):
        del kwargs
        return _FakeChatCompletion([])


class TestJudgeTranslationApiFailure:
    @pytest.mark.asyncio
    async def test_api_failure_propagates_rather_than_defaulting_to_a_verdict(self):
        error = openai_errors.APITimeoutError(request=_openai_request())
        client = _FakeClient(_FailingCompletions(error))

        with pytest.raises(openai_errors.APITimeoutError):
            await judge_translation("Hi.", "en", "Hola.", "es", client=client)
