"""Shared supported-language allow-list.

Used by both `app.api.realtime` (rejects an unsupported `sourceLanguage`/
`targetLanguage` with an HTTP 400 before ever calling OpenAI) and
`app.orchestrator` (falls back to `DEFAULT_LANGUAGES` for an unsupported
code in a `start_session` message. See `orchestrator._parse_languages`;
unlike `realtime.py`'s HTTP request/response cycle, there's no clean
"reject before accepting" point mid-session for a WebSocket message).
Factored out here, rather than one module importing it from the other, so
neither the route layer nor the orchestrator layer owns this domain data on
the other's behalf.
"""

from typing import Final

# Only these are wired up for this ticket: the brief's minimum viable
# language-pair support (English <-> Spanish). Extending this dict is how a
# later ticket adds more languages; nothing else in either consumer changes.
SUPPORTED_LANGUAGES: Final[dict[str, str]] = {"en": "English", "es": "Spanish"}
