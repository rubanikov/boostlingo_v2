"""HMAC telemetry tokens and the per-`sid` ingest rate limiter.

The signing secret is `secrets.token_bytes(32)` generated once at process
start. Tokens minted by one worker are invalid on another and do not
survive a restart, same bound as `orchestrator._detached_sessions`. Rate
buckets are an in-process token-bucket keyed by the token's `sid`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass

from app.config import settings

_SECRET = secrets.token_bytes(32)

# sid -> (tokens remaining, last refill monotonic ts). Evicted when idle.
_rate_buckets: dict[str, tuple[float, float]] = {}
_BUCKET_IDLE_EVICT_S = 120.0


@dataclass(frozen=True)
class TelemetryTokenClaims:
    sid: str
    tid: str
    exp: int


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode(data + pad)


def mint_telemetry_token(*, sid: str, tid: str, exp: int) -> str:
    """`base64url(json) + "." + base64url(hmac_sha256)` over `{sid, tid, exp}`."""
    payload = json.dumps(
        {"sid": sid, "tid": tid, "exp": exp},
        separators=(",", ":"),
    ).encode("utf-8")
    signature = hmac.new(_SECRET, payload, hashlib.sha256).digest()
    return f"{_b64url_encode(payload)}.{_b64url_encode(signature)}"


def peek_token_sid(token: str | None) -> str | None:
    """Read `sid` from the payload without checking the signature or `exp`.

    The ingest route rate-limits before it verifies, so a tampered token
    with a still-parseable payload shares the victim `sid`'s bucket.
    """
    if not token:
        return None
    payload_b64, _, _ = token.partition(".")
    if not payload_b64:
        return None
    try:
        data = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError):
        return None
    sid = data.get("sid") if isinstance(data, dict) else None
    return sid if isinstance(sid, str) and sid else None


def verify_telemetry_token(
    token: str | None, *, now: int | None = None
) -> TelemetryTokenClaims | None:
    if not token:
        return None
    payload_b64, sep, signature_b64 = token.partition(".")
    if not sep or not payload_b64 or not signature_b64:
        return None
    try:
        payload = _b64url_decode(payload_b64)
        signature = _b64url_decode(signature_b64)
    except ValueError:
        return None
    expected = hmac.new(_SECRET, payload, hashlib.sha256).digest()
    if len(signature) != len(expected) or not hmac.compare_digest(signature, expected):
        return None
    try:
        data = json.loads(payload)
        sid = data["sid"]
        tid = data["tid"]
        exp = data["exp"]
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(sid, str) or not isinstance(tid, str) or not isinstance(exp, int):
        return None
    if exp < (now if now is not None else int(time.time())):
        return None
    return TelemetryTokenClaims(sid=sid, tid=tid, exp=exp)


def allow_ingest(sid: str, *, now: float | None = None) -> bool:
    """Token-bucket: `telemetry_ingest_rate_per_minute` tokens, refill over 60s."""
    clock = time.monotonic() if now is None else now
    rate = float(settings.telemetry_ingest_rate_per_minute)
    _evict_idle_buckets(clock)
    tokens, last = _rate_buckets.get(sid, (rate, clock))
    elapsed = max(0.0, clock - last)
    tokens = min(rate, tokens + elapsed * (rate / 60.0))
    if tokens < 1.0:
        _rate_buckets[sid] = (tokens, clock)
        return False
    _rate_buckets[sid] = (tokens - 1.0, clock)
    return True


def reset_ingest_rate_limiter() -> None:
    _rate_buckets.clear()


def _evict_idle_buckets(now: float) -> None:
    stale = [key for key, (_, last) in _rate_buckets.items() if now - last > _BUCKET_IDLE_EVICT_S]
    for key in stale:
        del _rate_buckets[key]
