import json
from collections.abc import Callable

import httpx
import pytest

from app.api.realtime import OPENAI_CLIENT_SECRETS_URL, REALTIME_MODEL
from app.config import settings
from app.main import app

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
