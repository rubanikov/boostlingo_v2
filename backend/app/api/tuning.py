"""The tuning panel's own two routes.

`GET /api/tuning/capabilities` -- what this server's defaults are and which
denoise stages it can actually run.

Read-only and side-effect free: it derives everything from `settings`,
`app.tuning.defaults` and `importlib.util.find_spec`. Nothing is stored
server-side (story AC 1.8) -- the panel's configuration lives in the browser's
localStorage, and this endpoint only tells it where to start from.

Two things make this endpoint worth having rather than hardcoding the same
values in the frontend:

* **Defaults.** `.env` used to be invisible: `REALTIME_VAD_SILENCE_MS` changed
  how sessions behaved with nothing in the UI to show for it. Publishing the
  effective config means the panel opens on real numbers (story AC 1.11) and
  the fingerprint chip agrees with the server from the first render.
* **Capabilities.** The denoise stages are optional extras that may simply not
  be installed. The panel needs to disable those rows *with a reason a person
  can act on*, which is a different string per failure mode.

The route always answers `200`. A stage whose detection raises is reported as
`installed: false` with the exception class name; a panel with no data is a
worse outcome than a panel that says one row is unavailable.

`POST /api/tuning/transcript-check` (ticket 15) is the Realtime half of the
transcript check. Cascade runs the same `TranscriptChecker` inline
(`orchestrator._check_transcript`), but a Realtime session is browser-to-OpenAI
WebRTC: this server sees nothing after minting the token, and the browser has
no API key. So `flag` mode there is a round trip back through here, made
best-effort at both ends -- the browser calls it without blocking playback, and
this route answers `200` with `failed: true` rather than an error status when
the provider doesn't come back (story AC 4.7).
"""

import logging
import time
from typing import Any, Final

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.languages import SUPPORTED_LANGUAGES
from app.providers import denoise
from app.providers.transcript_check import TranscriptChecker
from app.tuning.allowlists import TEXT_MODELS, allow_lists
from app.tuning.defaults import default_tuning_config
from app.tuning.fingerprint import canonical_document
from app.tuning.schema import TUNING_SCHEMA_VERSION

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tuning", tags=["tuning"])

# Demucs and DNS64 are benchmark-only: `run_tuning_sweep.py` applies them to a
# whole WAV before replay, and the live path ignores them (brief section 4).
LIVE_CAPABLE_STAGES: Final[frozenset[str]] = frozenset({"deepfilternet", "noisereduce"})

# Hints a person can act on, per stage. Deepfilternet's names torch because
# torch is the reason the extra is big enough to be optional at all.
NOT_INSTALLED_REASONS: Final[dict[str, str]] = {
    "deepfilternet": "torch not installed — run `uv sync --extra denoise` in backend/",
    "noisereduce": "noisereduce not installed — run `uv sync --extra bench` in backend/",
    "demucs": "benchmark-only stage; install with `uv sync --extra denoise`",
    "dns64": "benchmark-only stage; install with `uv sync --extra denoise`",
}

WEIGHTS_UNAVAILABLE_REASON: Final = "model weights unavailable — see the server log."


def _stage_status(name: str) -> dict[str, Any]:
    """One `stages.*` entry, from the same detection the live chain uses
    (`denoise.stage_installed`: `find_spec` only, never an import) and the
    same `denoise._last_init_error` a stage writes when its *first real use*
    fails -- DeepFilterNet's `init_df()` not finding model weights, say.
    Installed-but-unusable is a genuinely different case from not installed
    and needs a different hint."""
    live_capable = name in LIVE_CAPABLE_STAGES
    try:
        installed = denoise.stage_installed(name)
    except Exception as exc:  # noqa: BLE001 -- deliberately per-stage, see below
        # A broken meta-path finder or a package with a malformed __init__
        # must degrade this one row, not the whole panel.
        logger.warning("denoise stage %s detection failed: %r", name, exc)
        return {
            "installed": False,
            "liveCapable": live_capable,
            "reason": type(exc).__name__,
        }

    status: dict[str, Any] = {"installed": installed, "liveCapable": live_capable}
    if not installed:
        status["reason"] = NOT_INSTALLED_REASONS[name]
    elif name in denoise._last_init_error:
        status["reason"] = WEIGHTS_UNAVAILABLE_REASON
    return status


@router.get("/capabilities")
def get_capabilities() -> dict[str, Any]:
    """Server defaults, curated allow-lists and denoise-stage availability.

    ```jsonc
    {
      "schemaVersion": 1,
      "defaults": { "schemaVersion": 1, "client": {…}, "realtime": {…}, "cascade": {…} },
      "allowLists": { "realtimeModels": [...], "elevenLabsVoices": [{"id","label"}], … },
      "stages": { "deepfilternet": {"installed": false, "liveCapable": true, "reason": "…"}, … }
    }
    ```

    `defaults` is served in **canonical form** (`fingerprint.canonical_document`)
    rather than as a plain `model_dump`: absent optional keys stay absent, and
    numbers are already clamped/quantised the way the hash sees them. So the
    document the panel receives is literally the document it fingerprints, and
    `/api/tuning/capabilities` can never publish a config that hashes to
    something the server would not.
    """
    return {
        "schemaVersion": TUNING_SCHEMA_VERSION,
        "defaults": canonical_document(default_tuning_config()),
        "allowLists": allow_lists(),
        "stages": {name: _stage_status(name) for name in denoise.STAGE_MODULES},
    }


# Long enough for any single settled Realtime turn and short enough that a
# runaway caller can't turn one request into an expensive prompt.
MAX_TEXT_CHARS: Final = 2000

# Both of `TranscriptChecker`'s modes, not just Realtime's: the endpoint is the
# checker's HTTP surface, and `off` is the *absence* of a call, so it is not a
# value this route accepts. (The Realtime panel only ever sends `flag` --
# `correct` has no seam there, which `RealtimeTranscriptCheck` enforces.)
CHECK_MODES: Final[tuple[str, ...]] = ("flag", "correct")


class TranscriptCheckRequest(BaseModel):
    """Body of `POST /api/tuning/transcript-check`.

    snake_case straight through, unlike the camelCase aliases next door in
    `app.api.realtime`: every field here is a single word, so there is no
    two-name mapping to maintain.

    `mode` and `model` are plain `str` rather than literals/enums on purpose.
    Typing them would make a bad value FastAPI's 422; the brief documents a
    `400` naming the offending field, and the checks below produce exactly
    that, in one place and in one order (the same idiom as
    `realtime._validate_tuning`).
    """

    text: str
    language: str
    mode: str
    model: str


def _validate(request: TranscriptCheckRequest) -> None:
    """The brief's four `400` rules, in its documented order. Runs before the
    API-key check: whether this server is configured says nothing about
    whether the request was well-formed, and a caller that sent a bad `mode`
    should be told so even on a server with no key."""
    if len(request.text) > MAX_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"text must be at most {MAX_TEXT_CHARS} characters.",
        )

    if request.mode not in CHECK_MODES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported transcript-check mode {request.mode!r}. "
                f"Supported: {list(CHECK_MODES)}."
            ),
        )

    if request.model not in TEXT_MODELS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported transcript-check model {request.model!r}. "
                f"Supported: {list(TEXT_MODELS)}."
            ),
        )

    if request.language not in SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported language code {request.language!r}. "
                f"Supported: {sorted(SUPPORTED_LANGUAGES)}."
            ),
        )


@router.post("/transcript-check")
async def check_transcript(request: TranscriptCheckRequest) -> dict[str, Any]:
    """Check one finished transcript for misrecognition.

    ```jsonc
    // request
    {"text":"i went to the store yesterday","language":"en","mode":"flag","model":"gpt-4o-mini"}
    // 200
    {"flagged": true, "correctedText": null, "elapsedMs": 143}
    // 200, provider didn't answer
    {"flagged": false, "correctedText": null, "elapsedMs": 6003, "failed": true}
    ```

    **A provider failure is not an error status.** `TranscriptChecker` never
    raises and its no-verdict answer is already the do-nothing one, so it is
    forwarded as a `200` carrying `failed: true`. The caller is a live session
    annotating transcripts it has already shown; breaking it because a
    side-channel check timed out would be a worse outcome than no badge.

    A new checker per request rather than a module-level one: this route holds
    no session state, `model` is per call anyway, and the alternative (one
    long-lived client built at import time) would need a key that may not
    exist yet. The cost is a fresh connection per check, so `elapsedMs` here
    carries a TLS handshake that Cascade's per-session checker amortises --
    worth knowing before comparing the two numbers directly.

    `elapsedMs` covers the provider call only -- it is what the panel's
    latency row reports, and it is comparable with Cascade's
    `transcript_check` latency stage, which measures the same span.
    """
    _validate(request)

    if not settings.openai_api_key:
        raise HTTPException(
            status_code=500,
            detail="OPENAI_API_KEY is not configured on the server.",
        )

    checker = TranscriptChecker(settings.openai_api_key)
    started = time.perf_counter()
    result = await checker.check(
        request.text, request.language, request.mode, model=request.model
    )
    elapsed_ms = round((time.perf_counter() - started) * 1000)

    response: dict[str, Any] = {
        "flagged": result.flagged,
        "correctedText": result.corrected_text,
        "elapsedMs": elapsed_ms,
    }
    if result.failed:
        response["failed"] = True
    return response
