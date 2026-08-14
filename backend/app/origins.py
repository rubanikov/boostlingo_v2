"""Shared Origin allow-list check.

`CORSMiddleware` never inspects WebSocket upgrades, so `/ws/cascade` has to
enforce the allow-list itself. The Realtime telemetry ingest route uses the
same rule: reject a present Origin that isn't in `settings.cors_origins`;
allow a missing Origin (non-browser clients).
"""

from app.config import settings


def is_allowed_origin(origin: str | None) -> bool:
    if origin is None:
        return True
    return origin in settings.cors_origins
