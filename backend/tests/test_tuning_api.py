"""Ticket 01: `GET /api/tuning/capabilities`.

Read-only, no auth, no side effects, and **always 200** -- the panel greys
rows out from this response, so a detection failure has to arrive as data
rather than as a 500 that leaves the panel with nothing to render.

Ticket 15 adds `POST /api/tuning/transcript-check` at the bottom of this file:
the same router, and the same no-auth posture, but a route that does reach a
provider.
"""

import asyncio
import importlib.util
from typing import ClassVar

import pytest
from starlette.testclient import TestClient

from app.api import tuning
from app.config import settings
from app.main import app
from app.providers import denoise
from app.providers.transcript_check import TranscriptCheckResult
from app.tuning.defaults import default_tuning_config
from app.tuning.fingerprint import canonical_document, fingerprint

STAGE_NAMES = {"deepfilternet", "noisereduce", "demucs", "dns64"}


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_stale_init_errors() -> None:
    denoise._last_init_error.clear()


class TestCapabilitiesShape:
    def test_returns_the_four_documented_blocks(self, client: TestClient) -> None:
        response = client.get("/api/tuning/capabilities")

        assert response.status_code == 200
        assert set(response.json()) == {
            "schemaVersion",
            "defaults",
            "allowLists",
            "stages",
        }

    def test_defaults_are_the_servers_own_configuration_not_blanks(
        self, client: TestClient
    ) -> None:
        """Story AC 1.11: the panel shows real `.env`-derived values."""
        body = client.get("/api/tuning/capabilities").json()

        assert body["schemaVersion"] == 1
        assert body["defaults"] == canonical_document(default_tuning_config())
        assert body["defaults"]["cascade"]["deepgram"]["endpointingMs"] == 500
        assert body["defaults"]["realtime"]["model"] == "gpt-realtime"
        assert body["defaults"]["cascade"]["ttsVoiceA"] == settings.elevenlabs_voice_id

    def test_published_defaults_hash_to_the_servers_own_fingerprint(
        self, client: TestClient
    ) -> None:
        """The panel hashes what it is served; if the two disagreed, the chip
        would be wrong from the very first render."""
        body = client.get("/api/tuning/capabilities").json()

        for mode in ("realtime", "cascade"):
            assert fingerprint(body["defaults"], mode) == fingerprint(
                default_tuning_config(), mode
            )

    def test_absent_optional_keys_stay_absent_in_the_published_defaults(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "realtime_vad_silence_ms", None)
        monkeypatch.setattr(settings, "realtime_vad_interrupt_response", None)

        turn_detection = client.get("/api/tuning/capabilities").json()["defaults"][
            "realtime"
        ]["turnDetection"]

        assert turn_detection == {"type": "server_vad"}

    def test_env_derived_defaults_are_published(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "realtime_vad_silence_ms", 900)

        turn_detection = client.get("/api/tuning/capabilities").json()["defaults"][
            "realtime"
        ]["turnDetection"]

        assert turn_detection["silenceDurationMs"] == 900

    def test_allow_lists_carry_every_picker(self, client: TestClient) -> None:
        allow_lists = client.get("/api/tuning/capabilities").json()["allowLists"]

        assert set(allow_lists) == {
            "realtimeModels",
            "realtimeVoices",
            "deepgramModels",
            "textModels",
            "elevenLabsVoices",
            "turnDetectionTypes",
            "eagerness",
            "noiseReduction",
        }
        assert allow_lists["realtimeModels"] == ["gpt-realtime", "gpt-realtime-mini"]
        assert allow_lists["deepgramModels"] == ["nova-3", "nova-2"]
        assert allow_lists["turnDetectionTypes"] == ["server_vad", "semantic_vad"]
        assert allow_lists["noiseReduction"] == ["off", "near_field", "far_field"]
        assert allow_lists["textModels"][0] == "gpt-4o-mini"

    def test_elevenlabs_voices_are_the_two_configured_ones(
        self, client: TestClient
    ) -> None:
        voices = client.get("/api/tuning/capabilities").json()["allowLists"][
            "elevenLabsVoices"
        ]

        assert voices == [
            {"id": settings.elevenlabs_voice_id, "label": "Rachel (voice A default)"},
            {
                "id": settings.elevenlabs_voice_id_speaker_b,
                "label": "Antoni (voice B default)",
            },
        ]

    def test_extra_voice_ids_from_the_environment_are_offered_too(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            settings,
            "elevenlabs_voice_ids_extra",
            ["pNInz6obpgDQGcFmaJgB", settings.elevenlabs_voice_id],
        )

        voices = client.get("/api/tuning/capabilities").json()["allowLists"][
            "elevenLabsVoices"
        ]

        assert [voice["id"] for voice in voices] == [
            settings.elevenlabs_voice_id,
            settings.elevenlabs_voice_id_speaker_b,
            "pNInz6obpgDQGcFmaJgB",
        ]

    def test_every_stage_reports_installed_and_live_capability(
        self, client: TestClient
    ) -> None:
        stages = client.get("/api/tuning/capabilities").json()["stages"]

        assert set(stages) == STAGE_NAMES
        assert stages["deepfilternet"]["liveCapable"] is True
        assert stages["noisereduce"]["liveCapable"] is True
        assert stages["demucs"]["liveCapable"] is False
        assert stages["dns64"]["liveCapable"] is False

    def test_installed_state_matches_what_is_actually_importable(
        self, client: TestClient
    ) -> None:
        """The extras are optional, so a default install honestly reports
        false for every stage -- assert against `find_spec` rather than
        against `false`, so this test stays true wherever they *are*
        installed (`uv sync --extra bench`)."""
        stages = client.get("/api/tuning/capabilities").json()["stages"]

        for name, module in denoise.STAGE_MODULES.items():
            assert stages[name]["installed"] is (
                importlib.util.find_spec(module) is not None
            )


class TestStageDetectionFailures:
    def test_s29_a_stage_whose_package_is_present_reports_installed_with_no_reason(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """S29: with the `bench` extra installed, `find_spec("noisereduce")`
        finds a spec, the row reports `installed: true` and carries no
        reason -- which is what makes the panel row live."""
        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: object())

        stages = client.get("/api/tuning/capabilities").json()["stages"]

        assert stages["noisereduce"] == {"installed": True, "liveCapable": True}
        assert stages["demucs"] == {"installed": True, "liveCapable": False}

    def test_f14_missing_module_reports_not_installed_with_the_install_hint(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: None)

        stages = client.get("/api/tuning/capabilities").json()["stages"]

        assert stages["deepfilternet"] == {
            "installed": False,
            "liveCapable": True,
            "reason": "torch not installed — run `uv sync --extra denoise` in backend/",
        }
        assert stages["noisereduce"]["reason"] == (
            "noisereduce not installed — run `uv sync --extra bench` in backend/"
        )
        assert stages["demucs"]["reason"] == (
            "benchmark-only stage; install with `uv sync --extra denoise`"
        )
        assert stages["dns64"]["reason"] == stages["demucs"]["reason"]

    def test_a_detection_exception_degrades_that_stage_instead_of_500ing(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def explode(name: str) -> None:
            raise ValueError(f"broken finder for {name}")

        monkeypatch.setattr(denoise.importlib.util, "find_spec", explode)

        response = client.get("/api/tuning/capabilities")

        assert response.status_code == 200
        for stage in response.json()["stages"].values():
            assert stage["installed"] is False
            assert stage["reason"] == "ValueError"

    def test_installed_but_weights_unavailable_is_a_different_hint(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The `denoise._last_init_error` hook a stage's first real use
        writes to (ticket 17's `init_df()`, or `NoisereduceStage` hitting a
        broken install): installed, but it will not run."""
        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: object())
        denoise._last_init_error["deepfilternet"] = "OSError: no weights"

        stages = client.get("/api/tuning/capabilities").json()["stages"]

        assert stages["deepfilternet"] == {
            "installed": True,
            "liveCapable": True,
            "reason": "model weights unavailable — see the server log.",
        }
        assert "reason" not in stages["noisereduce"]

    def test_f15_a_real_stage_whose_model_will_not_load_reports_that_hint(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """F15 end to end (ticket 17): torch *is* installed, `init_df()`
        raises on the session's first frame, and the panel is told the
        difference between "install the extra" and "the extra is installed
        and broken" -- by the stage itself, not by a hand-written dict."""

        def _no_weights() -> denoise._DFRuntime:
            raise OSError("could not download DeepFilterNet3")

        monkeypatch.setattr(denoise.importlib.util, "find_spec", lambda name: object())
        monkeypatch.setattr(denoise, "_load_deepfilternet", _no_weights)

        assert denoise.DeepFilterNetStage(30, 0.02).process(bytes(960)) == bytes(960)

        stages = client.get("/api/tuning/capabilities").json()["stages"]
        assert stages["deepfilternet"] == {
            "installed": True,
            "liveCapable": True,
            "reason": "model weights unavailable — see the server log.",
        }


class _ScriptedChecker:
    """Fake `TranscriptChecker` for the route's seam: records every call and
    answers with whatever `result` the test scripted. Same shape as
    `test_orchestrator._ScriptedChecker`, minus the gate -- this route awaits
    the verdict, so there is no ordering to prove here."""

    calls: ClassVar[list[dict]] = []
    result: ClassVar[TranscriptCheckResult] = TranscriptCheckResult(False, None, False)

    def __init__(self, api_key: str, model: str = "gpt-4o-mini") -> None:
        type(self).calls.append({"api_key": api_key, "model": model})

    async def check(self, text, language, mode, *, model=None):
        type(self).calls[-1] |= {
            "text": text,
            "language": language,
            "mode": mode,
            "call_model": model,
        }
        return type(self).result


@pytest.fixture()
def checker(monkeypatch: pytest.MonkeyPatch) -> type[_ScriptedChecker]:
    """The scripted checker wired in over the real one, plus the API key the
    route refuses to run without. Returns the class so a test can script its
    verdict and read back what it was called with."""
    _ScriptedChecker.calls = []
    _ScriptedChecker.result = TranscriptCheckResult(
        flagged=False, corrected_text=None, failed=False
    )
    monkeypatch.setattr(tuning, "TranscriptChecker", _ScriptedChecker)
    monkeypatch.setattr(settings, "openai_api_key", "sk-test-key")
    return _ScriptedChecker


def _body(**overrides) -> dict:
    """The brief's example request, overridable field by field."""
    return {
        "text": "i went to the store yesterday",
        "language": "en",
        "mode": "flag",
        "model": "gpt-4o-mini",
    } | overrides


class TestTranscriptCheckRoute:
    def test_a_flagged_transcript_comes_back_flagged(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """The brief's documented 200: `{flagged, correctedText, elapsedMs}`,
        with no `failed` key when the check actually ran."""
        checker.result = TranscriptCheckResult(
            flagged=True, corrected_text=None, failed=False
        )

        response = client.post("/api/tuning/transcript-check", json=_body())

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"flagged", "correctedText", "elapsedMs"}
        assert body["flagged"] is True
        assert body["correctedText"] is None
        assert isinstance(body["elapsedMs"], (int, float))

    def test_the_request_reaches_the_checker_verbatim(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """`model` is passed per call (the seam `TranscriptChecker.check`
        documents), so the panel's picker reaches the very next request."""
        client.post(
            "/api/tuning/transcript-check",
            json=_body(text="hola que tal", language="es", model="gpt-4.1-nano"),
        )

        assert checker.calls == [
            {
                "api_key": "sk-test-key",
                "model": "gpt-4o-mini",
                "text": "hola que tal",
                "language": "es",
                "mode": "flag",
                "call_model": "gpt-4.1-nano",
            }
        ]

    def test_correct_mode_returns_the_rewritten_transcript(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """`correct` is not reachable from the Realtime panel (locked decision
        4), but it is a documented mode of this endpoint and the checker
        supports it, so the route must forward the rewrite rather than drop
        it."""
        checker.result = TranscriptCheckResult(
            flagged=True, corrected_text="I went to the store yesterday", failed=False
        )

        response = client.post(
            "/api/tuning/transcript-check", json=_body(mode="correct")
        )

        assert response.status_code == 200
        assert response.json()["correctedText"] == "I went to the store yesterday"
        assert checker.calls[0]["mode"] == "correct"

    def test_a_provider_failure_is_a_200_the_caller_can_ignore(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """Story AC 4.7 / brief section 3: the check is a side channel, so a
        provider that never answered must not break a live session. Every
        field is already the do-nothing answer; `failed` is only there for a
        caller that wants to log it."""
        checker.result = TranscriptCheckResult(
            flagged=False, corrected_text=None, failed=True
        )

        response = client.post("/api/tuning/transcript-check", json=_body())

        assert response.status_code == 200
        body = response.json()
        assert body["failed"] is True
        assert body["flagged"] is False
        assert body["correctedText"] is None
        assert isinstance(body["elapsedMs"], (int, float))

    def test_elapsed_ms_measures_the_provider_call(
        self,
        client: TestClient,
        checker: type[_ScriptedChecker],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Not asserted against a wall-clock number (that would be flaky), but
        against the span it claims to cover: a checker that takes ~50ms cannot
        report 0."""

        async def slow_check(self, text, language, mode, *, model=None):
            del text, language, mode, model
            await asyncio.sleep(0.05)
            return TranscriptCheckResult(
                flagged=False, corrected_text=None, failed=False
            )

        monkeypatch.setattr(checker, "check", slow_check)

        body = client.post("/api/tuning/transcript-check", json=_body()).json()

        assert body["elapsedMs"] >= 50


class TestTranscriptCheckRejections:
    """The four documented `400`s. Each asserts the provider was never
    constructed: a rejected request must not spend an OpenAI call."""

    def test_text_over_the_cap_is_rejected(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        response = client.post(
            "/api/tuning/transcript-check", json=_body(text="a" * 2001)
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "text must be at most 2000 characters."
        assert checker.calls == []

    def test_text_at_exactly_the_cap_is_accepted(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        response = client.post(
            "/api/tuning/transcript-check", json=_body(text="a" * 2000)
        )

        assert response.status_code == 200

    def test_an_unsupported_mode_is_rejected(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """`off` included: "don't check" is the caller not calling, not a
        request for a verdict."""
        for mode in ("off", "rewrite", ""):
            response = client.post(
                "/api/tuning/transcript-check", json=_body(mode=mode)
            )

            assert response.status_code == 400
            assert response.json()["detail"] == (
                f"Unsupported transcript-check mode {mode!r}. "
                "Supported: ['flag', 'correct']."
            )
        assert checker.calls == []

    def test_a_model_outside_the_allow_list_is_rejected(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """An unvalidated free-text model id would reach a provider call
        (`allowlists` module docstring)."""
        response = client.post(
            "/api/tuning/transcript-check", json=_body(model="gpt-4o")
        )

        assert response.status_code == 400
        assert response.json()["detail"] == (
            "Unsupported transcript-check model 'gpt-4o'. "
            "Supported: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano']."
        )
        assert checker.calls == []

    def test_an_unsupported_language_is_rejected(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """Same allow-list, and the same 400, as `POST /api/realtime/session`:
        `language` is templated straight into the check's system prompt."""
        response = client.post(
            "/api/tuning/transcript-check", json=_body(language="de")
        )

        assert response.status_code == 400
        assert response.json()["detail"] == (
            "Unsupported language code 'de'. Supported: ['en', 'es', 'fr']."
        )
        assert checker.calls == []

    def test_a_missing_field_is_the_usual_422(
        self, client: TestClient, checker: type[_ScriptedChecker]
    ) -> None:
        """Not one of the brief's 400s: a body without `mode` never became a
        request, so it stays FastAPI's request-validation error."""
        response = client.post("/api/tuning/transcript-check", json={"text": "hi"})

        assert response.status_code == 422
        assert checker.calls == []

    def test_a_server_with_no_openai_key_says_so(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Deliberately *not* the `failed: true` 200: that means "the provider
        had no verdict", and a server with no key is a misconfiguration the
        operator has to fix, not a flaky check. Same 500 and same wording as
        `POST /api/realtime/session`."""
        monkeypatch.setattr(settings, "openai_api_key", "")

        response = client.post("/api/tuning/transcript-check", json=_body())

        assert response.status_code == 500
        assert response.json()["detail"] == (
            "OPENAI_API_KEY is not configured on the server."
        )

    def test_a_bad_request_is_rejected_even_without_a_key(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "openai_api_key", "")

        response = client.post(
            "/api/tuning/transcript-check", json=_body(model="gpt-4o")
        )

        assert response.status_code == 400
