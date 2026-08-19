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

# Extending this dict is how a new language is added; nothing else in
# either consumer changes (the Realtime instructions and translation
# prompts are templated on these names, and Deepgram's `language=multi`
# streaming detection plus ElevenLabs' multilingual flash model both
# already cover them). French was added exactly this way, as the brief's
# "time-to-onboard a new language pair" metric predicts: one entry here,
# one pair entry in the frontend's `LANGUAGE_PAIRS`.
SUPPORTED_LANGUAGES: Final[dict[str, str]] = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
}
