import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from app.api.realtime import OPENAI_CLIENT_SECRETS_URL, REALTIME_MODEL
from app.config import settings
from app.main import app
from app.tuning.defaults import default_realtime_tuning
from app.tuning.fingerprint import fingerprint
from app.tuning.schema import RealtimeModeTuning

pytestmark = pytest.mark.asyncio

FAKE_UPSTREAM_KEY = "sk-real-openai-key-must-never-leak"

# The real, unpatched AsyncClient.post — tests patch the class method below,
# so calls to the test's own ASGI-backed client (which also happens to be an
# httpx.AsyncClient) must fall through to this rather than be intercepted.
_real_post = httpx.AsyncClient.post


def _mock_client_secrets(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Intercept only outbound calls to OpenAI's client_secrets endpoint.

    Any other call (e.g. the test's own ASGI test client hitting our app)
    passes through to the real implementation.
    """
    captured: list[httpx.Request] = []

    async def fake_post(
        self: httpx.AsyncClient,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        if str(url) != OPENAI_CLIENT_SECRETS_URL:
            return await _real_post(self, url, headers=headers, json=json, timeout=timeout)
        request = httpx.Request("POST", url, headers=headers, json=json)
        captured.append(request)
        return handler(request)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    return captured


def _success_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        status_code=200,
        json={
            "value": "ek_test_ephemeral_token",
            "expires_at": 1_999_999_999,
            "session": {
                "type": "realtime",
                "model": REALTIME_MODEL,
                "audio": {"output": {"voice": "alloy"}},
            },
        },
        request=request,
    )


@pytest.fixture(autouse=True)
def _fake_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", FAKE_UPSTREAM_KEY)


async def _post_session(body: dict | None = None) -> httpx.Response:
    """One session POST through the app. `None` sends no body at all, which is
    what the browser did before this ticket."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/api/realtime/session", json=body)


def _tuning_document(**realtime: Any) -> dict:
    """A complete `ModeTuningConfig` (mode `realtime`) as the panel sends it.

    Written out in full rather than built from the pydantic model so the tests
    pin the *wire* document -- camelCase keys, absent optionals genuinely
    absent -- which is what the fingerprint hashes on both sides.
    """
    return {
        "schemaVersion": 1,
        "mode": "realtime",
        "client": {
            "microphone": {
                "echoCancellation": True,
                "noiseSuppression": True,
                "autoGainControl": True,
            },
            "rmsGate": {
                "enabled": False,
                "thresholdDbfs": -45,
                "holdMs": 200,
                "attackMs": 5,
                "releaseMs": 80,
                "attenuationDb": 12,
                "fullMute": False,
            },
            "rnnoise": {"enabled": False, "voiceProbThreshold": 0.5},
        },
        "realtime": {
            "model": "gpt-realtime",
            "voice": "alloy",
            "turnDetection": {"type": "server_vad"},
            "transcriptCheck": {"mode": "off", "model": "gpt-4o-mini"},
            **realtime,
        },
    }


def _outbound_session(captured: list[httpx.Request]) -> dict:
    """The `session` block of the single payload sent to OpenAI."""
    assert len(captured) == 1
    return json.loads(captured[0].content)["session"]


async def test_returns_ephemeral_token_and_expiry_to_caller(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 200
    body = response.json()
    assert body["client_secret"] == "ek_test_ephemeral_token"
    assert body["expires_at"] == 1_999_999_999
    assert body["model"] == REALTIME_MODEL
    assert body["voice"] == "alloy"


async def test_never_leaks_the_real_api_key_into_the_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert FAKE_UPSTREAM_KEY not in response.text


async def test_calls_openai_client_secrets_with_gpt_realtime_and_translation_instructions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        await client.post("/api/realtime/session")

    assert len(captured) == 1
    request = captured[0]
    assert request.url == "https://api.openai.com/v1/realtime/client_secrets"
    assert request.headers["authorization"] == f"Bearer {FAKE_UPSTREAM_KEY}"

    sent_body = json.loads(request.content)
    session = sent_body["session"]
    assert session["model"] == "gpt-realtime"
    assert "gpt-realtime-translate" not in str(sent_body)
    instructions = session["instructions"]
    assert "English" in instructions
    assert "Spanish" in instructions
    assert session["audio"]["input"]["turn_detection"] == {"type": "server_vad"}


async def test_vad_tuning_settings_are_forwarded_only_when_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The as-shipped session is bare `server_vad` (OpenAI defaults, the
    configuration COMPARISON.md's Realtime quality number was measured at);
    the two tuning knobs add their keys only when set in settings."""
    captured = _mock_client_secrets(monkeypatch, _success_response)
    monkeypatch.setattr(settings, "realtime_vad_silence_ms", 900)
    monkeypatch.setattr(settings, "realtime_vad_interrupt_response", False)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        await client.post("/api/realtime/session")

    turn_detection = json.loads(captured[0].content)["session"]["audio"]["input"]["turn_detection"]
    assert turn_detection == {
        "type": "server_vad",
        "silence_duration_ms": 900,
        "interrupt_response": False,
    }


async def test_default_language_pair_used_when_body_is_empty_dict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session", json={})

    assert response.status_code == 200
    instructions = json.loads(captured[0].content)["session"]["instructions"]
    assert "English" in instructions
    assert "Spanish" in instructions


async def test_real_language_pair_in_request_body_changes_instructions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/realtime/session",
            json={"sourceLanguage": "es", "targetLanguage": "en"},
        )

    assert response.status_code == 200
    instructions = json.loads(captured[0].content)["session"]["instructions"]
    assert "Detect whether the speaker used Spanish or English" in instructions
    assert (
        "If they spoke Spanish, translate what they said into English" in instructions
    )


async def test_unsupported_language_code_returns_400_without_calling_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/realtime/session",
            json={"sourceLanguage": "de", "targetLanguage": "es"},
        )

    assert response.status_code == 400
    assert captured == []


async def test_session_config_requests_input_audio_transcription(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        await client.post("/api/realtime/session")

    sent_body = json.loads(captured[0].content)
    transcription = sent_body["session"]["audio"]["input"]["transcription"]
    assert transcription == {"model": "gpt-4o-transcribe"}


async def test_upstream_error_from_openai_does_not_crash_and_hides_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _unauthorized(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=401,
            json={"error": {"message": "Incorrect API key provided"}},
            request=request,
        )

    _mock_client_secrets(monkeypatch, _unauthorized)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 502
    assert FAKE_UPSTREAM_KEY not in response.text


async def test_malformed_2xx_response_missing_value_returns_502_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bug fix: a 2xx response missing `value` must not reach the
    unguarded `data["value"]` and raise an unhandled `KeyError` (an
    unstyled 500) -- it should return the same clean, documented 502 the
    sibling >=400 branch already returns."""

    def _missing_value(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            json={
                "expires_at": 1_999_999_999,
                "session": {
                    "type": "realtime",
                    "model": REALTIME_MODEL,
                    "audio": {"output": {"voice": "alloy"}},
                },
            },
            request=request,
        )

    _mock_client_secrets(monkeypatch, _missing_value)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 502
    assert FAKE_UPSTREAM_KEY not in response.text


async def test_malformed_2xx_response_missing_expires_at_returns_502_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _missing_expires_at(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status_code=200,
            json={
                "value": "ek_test_ephemeral_token",
                "session": {
                    "type": "realtime",
                    "model": REALTIME_MODEL,
                    "audio": {"output": {"voice": "alloy"}},
                },
            },
            request=request,
        )

    _mock_client_secrets(monkeypatch, _missing_expires_at)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 502
    assert FAKE_UPSTREAM_KEY not in response.text


async def test_network_failure_reaching_openai_returns_502_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
        if str(url) != OPENAI_CLIENT_SECRETS_URL:
            return await _real_post(self, url, **kwargs)
        raise httpx.ConnectError(
            "connection refused", request=httpx.Request("POST", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 502


async def test_missing_server_api_key_fails_fast_without_calling_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "")
    captured = _mock_client_secrets(monkeypatch, _success_response)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test"
    ) as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code == 500
    assert captured == []


# --- ticket 04: start-of-session tuning -------------------------------------


async def test_turn_detection_knobs_from_tuning_reach_the_openai_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """S4 (story AC 1.2/1.3): a knob the panel set lands under
    `session.audio.input.turn_detection`, and the ones it left on "provider
    default" are absent from the payload entirely rather than sent as nulls."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    response = await _post_session(
        {
            "tuning": _tuning_document(
                turnDetection={"type": "server_vad", "silenceDurationMs": 300}
            )
        }
    )

    assert response.status_code == 200
    turn_detection = _outbound_session(captured)["audio"]["input"]["turn_detection"]
    assert turn_detection == {"type": "server_vad", "silence_duration_ms": 300}


async def test_tuning_is_authoritative_and_env_defaults_are_not_merged_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The panel was served the `.env` defaults by `/api/tuning/capabilities`
    and sent back what it wanted. Merging `settings` back in would resurrect a
    knob the user deliberately cleared."""
    captured = _mock_client_secrets(monkeypatch, _success_response)
    monkeypatch.setattr(settings, "realtime_vad_silence_ms", 900)
    monkeypatch.setattr(settings, "realtime_vad_interrupt_response", False)

    await _post_session({"tuning": _tuning_document()})

    turn_detection = _outbound_session(captured)["audio"]["input"]["turn_detection"]
    assert turn_detection == {"type": "server_vad"}


async def test_all_server_vad_knobs_are_forwarded_with_their_openai_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    await _post_session(
        {
            "tuning": _tuning_document(
                turnDetection={
                    "type": "server_vad",
                    "threshold": 0.6,
                    "prefixPaddingMs": 250,
                    "silenceDurationMs": 300,
                    "interruptResponse": False,
                }
            )
        }
    )

    turn_detection = _outbound_session(captured)["audio"]["input"]["turn_detection"]
    assert turn_detection == {
        "type": "server_vad",
        "threshold": 0.6,
        "prefix_padding_ms": 250,
        "silence_duration_ms": 300,
        "interrupt_response": False,
    }


async def test_semantic_vad_forwards_eagerness_and_drops_the_server_vad_knobs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`threshold`/`prefixPaddingMs`/`silenceDurationMs` are `server_vad`-only
    and `eagerness` is `semantic_vad`-only; a config carrying both (a panel
    that remembered the other type's values) must send only what applies."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    await _post_session(
        {
            "tuning": _tuning_document(
                turnDetection={
                    "type": "semantic_vad",
                    "eagerness": "high",
                    "threshold": 0.6,
                    "silenceDurationMs": 300,
                    "interruptResponse": True,
                }
            )
        }
    )

    turn_detection = _outbound_session(captured)["audio"]["input"]["turn_detection"]
    assert turn_detection == {
        "type": "semantic_vad",
        "eagerness": "high",
        "interrupt_response": True,
    }


@pytest.mark.parametrize(
    ("noise_reduction", "expected"),
    [
        ("near_field", {"type": "near_field"}),
        ("far_field", {"type": "far_field"}),
        ("off", None),
    ],
)
async def test_noise_reduction_maps_to_the_ga_three_state_shape(
    monkeypatch: pytest.MonkeyPatch,
    noise_reduction: str,
    expected: dict | None,
) -> None:
    """S5 (story AC 3.6). `off` is ours, not OpenAI's: the SDK documents an
    explicit `null` as the way to turn noise reduction off."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    await _post_session({"tuning": _tuning_document(noiseReduction=noise_reduction)})

    audio_input = _outbound_session(captured)["audio"]["input"]
    assert "noise_reduction" in audio_input
    assert audio_input["noise_reduction"] == expected


async def test_omitted_noise_reduction_sends_no_key_at_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`Provider default` is a fourth state, distinct from `off`: OpenAI must
    not be told anything about noise reduction."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    await _post_session({"tuning": _tuning_document()})

    assert "noise_reduction" not in _outbound_session(captured)["audio"]["input"]


async def test_tuning_model_and_voice_reach_the_session_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured = _mock_client_secrets(monkeypatch, _success_response)

    await _post_session(
        {"tuning": _tuning_document(model="gpt-realtime-mini", voice="marin")}
    )

    session = _outbound_session(captured)
    assert session["model"] == "gpt-realtime-mini"
    assert session["audio"]["output"]["voice"] == "marin"


async def test_client_and_transcript_check_blocks_are_never_sent_to_openai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """They describe the browser's own DSP and a separate endpoint. They are
    echoed in `appliedTuning` and hashed, but OpenAI has no use for them."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    response = await _post_session(
        {
            "tuning": _tuning_document(
                transcriptCheck={"mode": "flag", "model": "gpt-4.1-mini"}
            )
        }
    )

    sent_body = json.loads(captured[0].content)
    assert "rmsGate" not in str(sent_body)
    assert "transcriptCheck" not in str(sent_body)
    assert "gpt-4.1-mini" not in str(sent_body)
    # ...but they are part of the config this session ran with.
    applied = response.json()["appliedTuning"]
    assert applied["realtime"]["transcriptCheck"] == {
        "mode": "flag",
        "model": "gpt-4.1-mini",
    }
    assert applied["client"]["rmsGate"]["thresholdDbfs"] == -45


@pytest.mark.parametrize(
    ("tuning", "detail"),
    [
        pytest.param(
            _tuning_document(model="gpt-5-audio"),
            "Unsupported realtime model 'gpt-5-audio'. "
            "Supported: ['gpt-realtime', 'gpt-realtime-mini'].",
            id="F1-model",
        ),
        pytest.param(
            _tuning_document(voice="bob"),
            "Unsupported realtime voice 'bob'. Supported: ['alloy', 'ash', "
            "'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', "
            "'cedar'].",
            id="F1-voice",
        ),
        pytest.param(
            _tuning_document(turnDetection={"type": "server_vad", "threshold": 1.5}),
            "tuning.realtime.turnDetection.threshold must be between 0 and 1.",
            id="F2-threshold",
        ),
        pytest.param(
            _tuning_document(
                turnDetection={"type": "server_vad", "prefixPaddingMs": -1}
            ),
            "tuning.realtime.turnDetection.prefixPaddingMs must be between 0 and 5000.",
            id="F2-prefix-padding",
        ),
        pytest.param(
            _tuning_document(
                turnDetection={"type": "server_vad", "silenceDurationMs": 99_000}
            ),
            "tuning.realtime.turnDetection.silenceDurationMs must be between 0 and 10000.",
            id="F2-silence-duration",
        ),
        pytest.param(
            _tuning_document(turnDetection={"type": "server_vad", "eagerness": "high"}),
            "eagerness applies only to semantic_vad.",
            id="F3-eagerness",
        ),
        pytest.param(
            _tuning_document(noiseReduction="loud"),
            "Unsupported noise reduction 'loud'. "
            "Supported: ['off', 'near_field', 'far_field'].",
            id="F1-noise-reduction",
        ),
        pytest.param(
            _tuning_document(
                transcriptCheck={"mode": "correct", "model": "gpt-4o-mini"}
            ),
            "correct is unavailable in Realtime mode.",
            id="F3-correct",
        ),
        pytest.param(
            _tuning_document(transcriptCheck={"mode": "flag", "model": "gpt-9"}),
            "Unsupported transcript-check model 'gpt-9'. "
            "Supported: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-nano'].",
            id="transcript-check-model",
        ),
        pytest.param(
            {**_tuning_document(), "schemaVersion": 2},
            "Unsupported tuning schemaVersion 2. This server supports 1.",
            id="F5-schema-version",
        ),
        pytest.param(
            {**_tuning_document(), "mode": "cascade"},
            "Unsupported tuning mode 'cascade'. "
            "This endpoint starts realtime sessions only.",
            id="wrong-mode",
        ),
    ],
)
async def test_invalid_tuning_returns_400_naming_the_field_without_calling_openai(
    monkeypatch: pytest.MonkeyPatch,
    tuning: dict,
    detail: str,
) -> None:
    """F1/F2/F3/F5 (story AC 5.7): every semantically-invalid-but-parseable
    value is rejected with a 400 that names the field, and no ephemeral token
    is minted for a session that could not have run."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    response = await _post_session({"tuning": tuning})

    assert response.status_code == 400
    assert response.json()["detail"] == detail
    assert captured == []


async def test_language_validation_still_runs_before_tuning_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`assertServersUp()` in the capture harness probes with an unsupported
    `sourceLanguage` and matches that error. Tuning validation must not get
    in front of it."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    response = await _post_session(
        {
            "sourceLanguage": "zz",
            "tuning": _tuning_document(model="gpt-5-audio"),
        }
    )

    assert response.status_code == 400
    assert response.json()["detail"].startswith("Unsupported language code 'zz'.")
    assert captured == []


async def test_wrongly_typed_tuning_value_is_still_the_documented_422(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A malformed JSON *type* is a client bug, not a configuration choice;
    the brief documents it as pydantic's 422 rather than one of the 400s."""
    captured = _mock_client_secrets(monkeypatch, _success_response)

    response = await _post_session(
        {
            "tuning": _tuning_document(
                turnDetection={"type": "server_vad", "threshold": "loud"}
            )
        }
    )

    assert response.status_code == 422
    assert captured == []


async def test_response_carries_the_fingerprint_of_the_config_that_was_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The panel displays the *server's* fingerprint, so it has to agree with
    the hash the client computed for the document it sent."""
    _mock_client_secrets(monkeypatch, _success_response)
    document = _tuning_document(
        voice="marin",
        turnDetection={"type": "server_vad", "silenceDurationMs": 300},
        noiseReduction="near_field",
    )

    response = await _post_session({"tuning": document})

    body = response.json()
    assert body["fingerprint"] == fingerprint(document, "realtime")
    applied = body["appliedTuning"]
    assert applied["mode"] == "realtime"
    assert applied["schemaVersion"] == 1
    assert applied["realtime"]["voice"] == "marin"
    assert applied["realtime"]["noiseReduction"] == "near_field"
    assert applied["realtime"]["turnDetection"] == {
        "type": "server_vad",
        "silenceDurationMs": 300,
    }


async def test_applied_tuning_keeps_absent_keys_absent_and_rehashes_identically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`appliedTuning` is the round-trip the panel verifies against: hashing
    what the server echoes must give the fingerprint it published."""
    _mock_client_secrets(monkeypatch, _success_response)

    body = (
        await _post_session(
            {"tuning": _tuning_document(turnDetection={"type": "server_vad"})}
        )
    ).json()

    turn_detection = body["appliedTuning"]["realtime"]["turnDetection"]
    assert turn_detection == {"type": "server_vad"}
    assert "noiseReduction" not in body["appliedTuning"]["realtime"]
    assert fingerprint(body["appliedTuning"], "realtime") == body["fingerprint"]


async def test_a_changed_knob_moves_the_fingerprint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_client_secrets(monkeypatch, _success_response)

    quiet = await _post_session(
        {"tuning": _tuning_document(turnDetection={"type": "server_vad"})}
    )
    eager = await _post_session(
        {
            "tuning": _tuning_document(
                turnDetection={"type": "server_vad", "silenceDurationMs": 300}
            )
        }
    )

    assert quiet.json()["fingerprint"] != eager.json()["fingerprint"]


async def test_a_session_started_without_tuning_reports_the_env_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every session is joinable to a config, including the ones started
    before the panel existed -- otherwise a benchmark row has nothing to key
    on. `REALTIME_VAD_SILENCE_MS` is in that document, so setting it moves the
    fingerprint."""
    _mock_client_secrets(monkeypatch, _success_response)
    monkeypatch.setattr(settings, "realtime_vad_silence_ms", 900)

    body = (await _post_session()).json()

    expected = RealtimeModeTuning(realtime=default_realtime_tuning())
    assert body["fingerprint"] == fingerprint(expected, "realtime")
    assert body["appliedTuning"]["realtime"]["turnDetection"] == {
        "type": "server_vad",
        "silenceDurationMs": 900,
    }
