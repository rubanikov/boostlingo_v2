"""HMAC mint/verify for the observability operator cookie (`obs_session`).

The cookie holds no server-side state: its value is HMAC-SHA256 of the
operator token over a fixed message. Rotating or unsetting
`OBSERVABILITY_UI_TOKEN` invalidates every outstanding cookie.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

COOKIE_NAME = "obs_session"
_SESSION_MAC_MESSAGE = b"observability-ui-session-v1"


def mint_session_cookie(ui_token: str) -> str:
    """Return the 64-char lowercase hex HMAC for `ui_token`."""
    return hmac.new(
        ui_token.encode("utf-8"),
        _SESSION_MAC_MESSAGE,
        hashlib.sha256,
    ).hexdigest()


def verify_session_cookie(ui_token: str, cookie_value: str) -> bool:
    """Constant-time check that `cookie_value` matches `ui_token`'s HMAC."""
    if not ui_token or not cookie_value:
        return False
    expected = mint_session_cookie(ui_token)
    if len(cookie_value) != len(expected):
        return False
    return secrets.compare_digest(cookie_value, expected)
