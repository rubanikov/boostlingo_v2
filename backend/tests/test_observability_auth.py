"""Operator cookie gate for /api/observability/*.

Seams: the HTTP routes in `app.api.observability`. Cookie value is the
brief's HMAC, computed here from the spec rather than from app helpers.
"""

from __future__ import annotations

import hashlib
import hmac

import httpx
import pytest

from app.config import settings
from app.main import app

pytestmark = pytest.mark.asyncio

OPERATOR_TOKEN = "test-operator-token"
# Independent of app.observability.auth — the brief is the source of truth.
EXPECTED_COOKIE = hmac.new(
    OPERATOR_TOKEN.encode("utf-8"),
    b"observability-ui-session-v1",
    hashlib.sha256,
).hexdigest()

DATA_ROUTES = (
    "/api/observability/summary",
    "/api/observability/traces",
)


def _asgi_client(base_url: str = "http://test") -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url=base_url,
    )


@pytest.fixture
def observability_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", OPERATOR_TOKEN)
    monkeypatch.setattr(settings, "langfuse_host", "")
    monkeypatch.setattr(settings, "langfuse_public_key", "")
    monkeypatch.setattr(settings, "langfuse_secret_key", "")


@pytest.fixture
def observability_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "observability_ui_token", "")
    monkeypatch.setattr(settings, "langfuse_host", "")
    monkeypatch.setattr(settings, "langfuse_public_key", "")
    monkeypatch.setattr(settings, "langfuse_secret_key", "")


def _set_cookie_header(response: httpx.Response) -> str | None:
    return response.headers.get("set-cookie")


async def test_config_is_unauthenticated_200_when_enabled(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.get("/api/observability/config")

    assert response.status_code == 200
    assert response.json() == {"enabled": True, "authenticated": False}


async def test_config_reports_disabled_when_token_unset(
    observability_disabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.get("/api/observability/config")

    assert response.status_code == 200
    assert response.json() == {"enabled": False, "authenticated": False}


async def test_config_authenticated_after_login(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        login = await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )
        assert login.status_code == 204
        response = await client.get("/api/observability/config")

    assert response.status_code == 200
    assert response.json() == {"enabled": True, "authenticated": True}


async def test_config_never_reveals_token_or_langfuse_host(
    observability_enabled: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "langfuse_host", "http://localhost:3000")
    async with _asgi_client() as client:
        response = await client.get("/api/observability/config")

    assert response.status_code == 200
    body = response.text
    assert OPERATOR_TOKEN not in body
    assert "localhost:3000" not in body
    assert "langfuse" not in body.lower()


async def test_login_sets_browser_session_cookie(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )

    assert response.status_code == 204
    header = _set_cookie_header(response)
    assert header is not None
    assert f"obs_session={EXPECTED_COOKIE}" in header
    assert EXPECTED_COOKIE == EXPECTED_COOKIE.lower()
    assert len(EXPECTED_COOKIE) == 64
    assert "HttpOnly" in header
    assert "samesite=lax" in header.lower()
    assert "Path=/" in header
    assert "Max-Age" not in header
    assert "Expires" not in header
    assert "Secure" not in header


async def test_login_sets_secure_cookie_on_https(
    observability_enabled: None,
) -> None:
    async with _asgi_client(base_url="https://test") as client:
        response = await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )

    assert response.status_code == 204
    header = _set_cookie_header(response)
    assert header is not None
    assert "Secure" in header
    assert "Max-Age" not in header
    assert "Expires" not in header


async def test_wrong_token_is_401_without_set_cookie(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.post(
            "/api/observability/login", json={"token": "not-the-token"}
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid operator token."}
    assert _set_cookie_header(response) is None


async def test_login_when_disabled_is_404(
    observability_disabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.post(
            "/api/observability/login", json={"token": "anything"}
        )

    assert response.status_code == 404
    assert response.json() == {
        "detail": "Observability is not enabled on this server."
    }
    assert _set_cookie_header(response) is None


async def test_logout_expires_cookie_and_next_summary_is_401(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        login = await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )
        assert login.status_code == 204

        logout = await client.post("/api/observability/logout")
        assert logout.status_code == 204
        header = _set_cookie_header(logout)
        assert header is not None
        assert header.startswith("obs_session=")
        assert "Max-Age=0" in header
        assert "Path=/" in header
        assert "HttpOnly" in header
        assert "samesite=lax" in header.lower()

        summary = await client.get("/api/observability/summary")
        assert summary.status_code == 401


async def test_logout_is_idempotent_without_cookie(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.post("/api/observability/logout")

    assert response.status_code == 204
    header = _set_cookie_header(response)
    assert header is not None
    assert "Max-Age=0" in header


@pytest.mark.parametrize("path", DATA_ROUTES)
async def test_data_route_without_cookie_is_401(
    path: str, observability_enabled: None
) -> None:
    async with _asgi_client() as client:
        response = await client.get(path)

    assert response.status_code == 401
    assert "detail" in response.json()


async def test_tampered_cookie_is_401(observability_enabled: None) -> None:
    flipped = EXPECTED_COOKIE[:-1] + ("0" if EXPECTED_COOKIE[-1] != "0" else "1")
    async with _asgi_client() as client:
        client.cookies.set("obs_session", flipped)
        response = await client.get("/api/observability/summary")

    assert response.status_code == 401
    assert _set_cookie_header(response) is None


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/observability/login"),
        ("GET", "/api/observability/summary"),
        ("GET", "/api/observability/traces"),
    ],
)
async def test_disabled_login_and_data_routes_are_404(
    method: str, path: str, observability_disabled: None
) -> None:
    async with _asgi_client() as client:
        response = await client.request(
            method, path, json={"token": "x"} if method == "POST" else None
        )

    assert response.status_code == 404
    assert response.json() == {
        "detail": "Observability is not enabled on this server."
    }


@pytest.mark.parametrize("path", DATA_ROUTES)
async def test_summary_and_traces_are_503_when_langfuse_unset(
    path: str, observability_enabled: None
) -> None:
    async with _asgi_client() as client:
        await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )
        response = await client.get(path)

    assert response.status_code == 503
    body = response.json()
    assert "detail" in body
    assert body != {}
    # 503 body is a detail string, not a stub summary payload.
    assert "latency" not in body
    assert "traces" not in body
    assert "window" not in body


@pytest.mark.parametrize("window", ["1h", "24h", "7d"])
async def test_valid_summary_window_reaches_langfuse_gate(
    window: str, observability_enabled: None
) -> None:
    async with _asgi_client() as client:
        await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )
        response = await client.get(
            "/api/observability/summary", params={"window": window}
        )

    assert response.status_code == 503


async def test_invalid_window_is_422(observability_enabled: None) -> None:
    async with _asgi_client() as client:
        await client.post(
            "/api/observability/login", json={"token": OPERATOR_TOKEN}
        )
        response = await client.get(
            "/api/observability/summary", params={"window": "2h"}
        )

    assert response.status_code == 422


async def test_realtime_session_is_not_gated_by_observability_cookie(
    observability_enabled: None,
) -> None:
    async with _asgi_client() as client:
        response = await client.post("/api/realtime/session")

    assert response.status_code not in (401, 403, 404)
